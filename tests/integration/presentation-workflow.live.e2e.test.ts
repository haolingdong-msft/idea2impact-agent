import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const BASE_URL = (
  process.env.PRESENTATION_E2E_BASE_URL || "http://127.0.0.1:3000"
).replace(/\/$/, "");
const OUTPUT_DIR = resolve(
  process.env.PRESENTATION_E2E_OUTPUT_DIR ||
    join(process.cwd(), "artifacts", "presentation-e2e"),
);
const REPOSITORY_URL =
  "https://github.com/haolingdong-msft/presentation-agent";
const BRIEF = {
  title: "Idea2Impact Agent Value Demo",
  idea:
    "Demonstrate how Idea2Impact Agent is helpful and easy to use for " +
    "generating presentations and saving a significant amount of time.",
  audience: "Engineering leaders and product stakeholders",
  purpose:
    "Show the complete, time-saving workflow from a brief and codebase to " +
    "an outline, overview, slides, and narrated video.",
  repositoryUrl: REPOSITORY_URL,
};

type ProjectResponse = {
  project: { id: string };
};

type OutlineResponse = {
  outline: {
    status: string;
    [key: string]: unknown;
  };
};

type RepositoryResponse = {
  evidence: {
    repository: {
      url: string;
      [key: string]: unknown;
    };
  };
};

type ArchitectureResponse = {
  visual: {
    mode: string;
    imageUrl: string;
  };
  architecture: {
    platforms: unknown[];
    workflow: { steps: unknown[] };
    [key: string]: unknown;
  };
};

type Slide = {
  id: string;
  kind: string;
  imageUrl: string;
};

type SlidesResponse = {
  deck: {
    slides: Slide[];
    [key: string]: unknown;
  };
};

type VideoPlan = {
  jobId: string;
  slides: Array<{ script: string }>;
};

type RenderedVideo = {
  durationSeconds: number;
  slideCount: number;
  voice: string;
  subtitles: string;
  downloadUrl: string;
};

async function requestJson<T>(
  path: string,
  init?: RequestInit,
  timeoutMs = 10 * 60_000,
): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init?.method || "GET"} ${path} failed (${response.status}): ${text}`);
  }
  return JSON.parse(text) as T;
}

async function saveResponse(
  path: string,
  fileName: string,
  timeoutMs = 3 * 60_000,
): Promise<{ path: string; bytes: number; sha256: string }> {
  const response = await fetch(`${BASE_URL}${path}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`GET ${path} failed (${response.status}): ${await response.text()}`);
  }
  const content = Buffer.from(await response.arrayBuffer());
  const outputPath = join(OUTPUT_DIR, fileName);
  await writeFile(outputPath, content);
  return {
    path: outputPath,
    bytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

describe("live presentation workflow", () => {
  it("generates outline, overview, slides, and video from a brief and codebase URL", async () => {
    await mkdir(OUTPUT_DIR, { recursive: true });
    const startedAt = new Date().toISOString();

    const health = await requestJson<{ status: string }>("/health", undefined, 15_000);
    expect(health.status).toBe("ok");

    const created = await requestJson<ProjectResponse>("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(BRIEF),
    });
    const projectId = String(created.project.id);
    expect(projectId).toMatch(/^[0-9a-f-]{36}$/i);

    const repository = await requestJson<RepositoryResponse>(
      `/projects/${projectId}/repository/scan`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repositoryUrl: REPOSITORY_URL }),
      },
    );
    expect(repository.evidence.repository.url).toBe(REPOSITORY_URL);

    const generatedOutline = await requestJson<OutlineResponse>(
      `/projects/${projectId}/outline/generate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversation:
            "Create a concise outline showing how this agent makes presentation " +
            "creation easy and saves time. Ground all claims in repository evidence.",
        }),
      },
    );
    const savedOutline = await requestJson<OutlineResponse>(
      `/projects/${projectId}/outline`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(generatedOutline.outline),
      },
    );
    expect(savedOutline.outline.status).toBe("draft");
    const approvedOutline = await requestJson<OutlineResponse>(
      `/projects/${projectId}/outline/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    expect(approvedOutline.outline.status).toBe("approved");

    const overview = await requestJson<ArchitectureResponse>("/architecture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        idea: BRIEF.idea,
        audience: BRIEF.audience,
        purpose: BRIEF.purpose,
        context: JSON.stringify(approvedOutline.outline),
        generateVisuals: true,
        visualMode: "image",
      }),
    }, 15 * 60_000);
    expect(overview.visual.mode).toBe("image");
    expect(overview.visual.imageUrl).toBeTruthy();
    expect(overview.architecture.workflow.steps.length).toBeGreaterThan(0);

    const overviewJsonPath = join(OUTPUT_DIR, "overview.json");
    await writeFile(
      overviewJsonPath,
      JSON.stringify(overview.architecture, null, 2),
      "utf8",
    );
    const artifacts = [
      await saveResponse(overview.visual.imageUrl, "overview.png"),
    ];

    const slides = await requestJson<SlidesResponse>("/slides", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, architectureVisualMode: "image" }),
    }, 30 * 60_000);
    expect(slides.deck.slides.map(slide => slide.kind)).toEqual([
      "problem",
      "user-scenarios",
      "solution",
    ]);
    expect(slides.deck.slides.every(slide => slide.imageUrl)).toBe(true);

    await writeFile(
      join(OUTPUT_DIR, "slides.json"),
      JSON.stringify(slides.deck, null, 2),
      "utf8",
    );
    const slidesHtml = await saveResponse(
      `/projects/${projectId}/slides/download`,
      "slides.html",
    );
    artifacts.push(slidesHtml);
    for (const slide of slides.deck.slides) {
      artifacts.push(
        await saveResponse(slide.imageUrl, `slide-${slide.id}.png`),
      );
    }

    const html = await (await fetch(`${BASE_URL}/projects/${projectId}/slides/download`)).text();
    const videoPlan = await requestJson<VideoPlan>(
      "/slide-video/plan?targetDurationSeconds=30",
      {
        method: "POST",
        headers: { "Content-Type": "text/html" },
        body: html,
      },
    );
    expect(videoPlan.slides).toHaveLength(slides.deck.slides.length);
    await writeFile(
      join(OUTPUT_DIR, "video-plan.json"),
      JSON.stringify(videoPlan, null, 2),
      "utf8",
    );

    const renderedVideo = await requestJson<RenderedVideo>(
      `/slide-video/${videoPlan.jobId}/render`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetDurationSeconds: 30,
          voice: "en-US-AvaMultilingualNeural",
          slides: videoPlan.slides.map(slide => ({
            script: slide.script,
          })),
        }),
      },
      20 * 60_000,
    );
    expect(renderedVideo.durationSeconds).toBe(30);
    expect(renderedVideo.slideCount).toBe(slides.deck.slides.length);
    const video = await saveResponse(
      renderedVideo.downloadUrl,
      "presentation-video.mp4",
    );
    artifacts.push(video);
    const videoBytes = await (await fetch(`${BASE_URL}${renderedVideo.downloadUrl}`))
      .arrayBuffer();
    expect(Buffer.from(videoBytes).subarray(4, 8).toString("ascii")).toBe("ftyp");

    const evidence = {
      result: "passed",
      startedAt,
      completedAt: new Date().toISOString(),
      baseUrl: BASE_URL,
      projectId,
      inputs: BRIEF,
      repository: repository.evidence.repository,
      outlineStatus: approvedOutline.outline.status,
      overview: {
        mode: overview.visual.mode,
        platformCount: overview.architecture.platforms.length,
        workflowStepCount: overview.architecture.workflow.steps.length,
      },
      slides: {
        count: slides.deck.slides.length,
        kinds: slides.deck.slides.map(slide => slide.kind),
      },
      video: {
        durationSeconds: renderedVideo.durationSeconds,
        slideCount: renderedVideo.slideCount,
        voice: renderedVideo.voice,
        subtitles: renderedVideo.subtitles,
      },
      artifacts,
    };
    await writeFile(
      join(OUTPUT_DIR, "test-evidence.json"),
      JSON.stringify(evidence, null, 2),
      "utf8",
    );
  });
});
