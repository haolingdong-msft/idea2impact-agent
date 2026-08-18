import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../model-config.js", () => ({
  getSessionOptions: vi.fn().mockResolvedValue({}),
  enhanceModelError: vi.fn((error: unknown) =>
    error instanceof Error ? error : new Error(String(error))),
}));
vi.mock("../architecture-visual.js", () => ({
  architectureImageConfiguration: vi.fn(() => ({
    deployment: "gpt-image-2",
    width: 1536,
    height: 864,
  })),
  generateArchitectureImage: vi.fn().mockResolvedValue(
    new Uint8Array(Buffer.from("generated-design-graph")),
  ),
  isArchitectureImageConfigured: vi.fn(() => true),
  parseArchitectureImage: vi.fn().mockResolvedValue({
    architecture: { title: "Image-derived architecture" },
    layout: { width: 1600, height: 900, nodes: [], connections: [] },
  }),
}));

import architectureRoutes from "./architecture.js";
import {
  generateArchitectureImage,
  isArchitectureImageConfigured,
  parseArchitectureImage,
} from "../architecture-visual.js";
import {
  createProject,
  getProject,
  projectDirectory,
  storeProjectBinaryAsset,
  storeProjectJsonAsset,
} from "./project-store.js";

const GRAPH = {
  title: "Creative Architecture",
  summary: "Copilot directly designs the architecture visual.",
  layers: [
    { id: "experience", label: "Experience", purpose: "User access.", tone: "navy", nodes: [
      { id: "web", label: "Web UI", description: "Captures input.", kind: "interface", technology: "Web", provenance: "confirmed" },
    ] },
    { id: "agent", label: "Agent", purpose: "Generation.", tone: "blue", nodes: [
      { id: "foundry", label: "Foundry Agent", description: "Creates assets.", kind: "agent", technology: "Foundry", provenance: "confirmed" },
    ] },
  ],
  platforms: [
    {
      id: "web-platform",
      label: "Web Platform",
      description: "Hosts the browser experience.",
      technology: "Web runtime",
      componentNodeIds: ["web"],
      toolings: [{
        id: "brief-capture",
        label: "Brief capture",
        description: "Captures approved presentation context.",
        technology: "Browser form",
        componentNodeId: "web",
      }],
      provenance: "confirmed",
    },
    {
      id: "foundry-platform",
      label: "Microsoft Foundry",
      description: "Hosts the generation agent.",
      technology: "Microsoft Foundry",
      componentNodeIds: ["foundry"],
      toolings: [{
        id: "visual-generation",
        label: "Visual generation",
        description: "Generates architecture visual options.",
        technology: "Foundry Hosted Agent",
        componentNodeId: "foundry",
      }],
      provenance: "confirmed",
    },
  ],
  workflow: {
    actor: "Presenter",
    goal: "Create an architecture design",
    steps: [
      {
        id: "enter-input",
        order: 1,
        label: "Enter input",
        userAction: "Provide the approved presentation context.",
        platformCalls: [{
          platformId: "web-platform",
          toolingId: "brief-capture",
          nodeId: "web",
          action: "capture input",
          mechanism: "browser form",
          output: "approved input",
        }],
      },
      {
        id: "create-assets",
        order: 2,
        label: "Create assets",
        userAction: "Generate architecture design options.",
        platformCalls: [{
          platformId: "foundry-platform",
          toolingId: "visual-generation",
          nodeId: "foundry",
          action: "generate assets",
          mechanism: "agent invocation",
          output: "architecture visuals",
        }],
      },
    ],
  },
  connections: [{
    from: "web", to: "foundry", label: "generate", type: "request",
    mechanism: "HTTPS", payload: "approved input", provenance: "confirmed", primary: true,
  }],
  assumptions: [],
};

const HTML = `<!doctype html><html><head><style>
body{margin:0;background:#eef4ff}.flow{display:grid}
.connector{border-top:2px solid #2563eb}
</style></head><body><h1>Creative architecture</h1><main class="flow" data-architecture-flow>
<section data-component="user">User</section>
<div class="connector" data-connector data-from="user" data-to="web"><span class="connector-label">HTTPS</span><span class="connector-arrow" aria-hidden="true"></span></div>
<section data-component="web">Web UI</section>
<div class="connector" data-connector data-from="web" data-to="api"><span class="connector-label">request</span><span class="connector-arrow" aria-hidden="true"></span></div>
<section data-component="api">API</section>
<div class="connector" data-connector data-from="api" data-to="agent"><span class="connector-label">invoke</span><span class="connector-arrow" aria-hidden="true"></span></div>
<section data-component="agent">Foundry Agent</section>
<div class="connector" data-connector data-from="agent" data-to="store"><span class="connector-label">write</span><span class="connector-arrow" aria-hidden="true"></span></div>
<section data-component="store">Asset Store</section>
</main></body></html>`;
const projectIds: string[] = [];
let quickSourceSha = "";

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use(architectureRoutes);
  return instance;
}

beforeEach(() => {
  vi.clearAllMocks();
  quickSourceSha = "";
  vi.stubEnv("PRESENTATION_AGENT_INVOCATIONS_ENDPOINT", "http://127.0.0.1:8088/invocations");
  vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const envelope = JSON.parse(String(init?.body));
    const operation = envelope.operation;
    if (operation === "start-images-to-editable-ppt") {
      quickSourceSha = envelope.input.sourceImages[0].sourceImageSha256;
      return new Response(JSON.stringify({
        jobId: "quick-editable-job",
        status: "running",
      }), {
        status: 202,
        headers: { "x-agent-session-id": "quick-editable-session" },
      });
    }
    if (operation === "editable-ppt-status") {
      return new Response(JSON.stringify({
        jobId: "quick-editable-job",
        status: "completed",
        invocationId: "skill-invocation-123",
        runId: "editppt-run-456",
        workflow: "image-to-editable-ppt",
        validationPassed: true,
        sourceImageSha256s: [quickSourceSha],
        pptxBase64: Buffer.from("PK skill conversion").toString("base64"),
      }), { status: 200 });
    }
    if (operation === "image-to-editable-ppt") {
      await new Promise(resolve => setTimeout(resolve, 25));
      return new Response(JSON.stringify({
        invocationId: "skill-invocation-123",
        runId: "editppt-run-456",
        workflow: "image-to-editable-ppt",
        validationPassed: true,
        sourceImageSha256: envelope.input.sourceImageSha256,
        pptxBase64: Buffer.from("PK skill conversion").toString("base64"),
      }), { status: 200 });
    }
    const content = ["architecture-html", "architecture-image-html"].includes(operation)
      ? HTML
      : JSON.stringify(GRAPH);
    return new Response(JSON.stringify({ result: { content } }), { status: 200 });
  }));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(projectIds.splice(0).map(id =>
    rm(projectDirectory(id), { recursive: true, force: true })));
});

describe("architecture image generation", () => {
  it("supports the start-page shortcut without generating an overview", async () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 4, 5, 6]);
    const response = await request(app())
      .post("/editable-pptx")
      .set("Content-Type", "image/png")
      .send(png);

    expect(response.status).toBe(202);
    const invocation = JSON.parse(
      String((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body),
    );
    expect(invocation.operation).toBe("start-images-to-editable-ppt");
    expect(invocation.input.projectId).toBe("editable-ppt");
    expect(invocation.input.sourceImages[0].sourceImageBase64)
      .toBe(png.toString("base64"));
    const status = await request(app()).get(response.body.statusUrl);
    expect(status.status, JSON.stringify(status.body)).toBe(200);
    expect(status.body).toMatchObject({
      status: "completed",
      invocationId: "skill-invocation-123",
      sourceImageSha256: quickSourceSha,
    });
    expect(status.body.logs.at(-1)).toContain("Validation passed");
    const download = await request(app()).get(status.body.downloadUrl);
    expect(download.status).toBe(200);
    expect(download.headers["x-source-image-sha256"]).toBe(quickSourceSha);
  });

  it("defers the architecture image until slide generation is requested", async () => {
    const project = await createProject({
      title: "Deferred visuals",
      idea: "Analyze architecture before generating slide design options.",
      audience: "Leaders",
      purpose: "Compare visual treatments",
    });
    projectIds.push(project.id);
    await storeProjectJsonAsset(project.id, "outline", { status: "approved" });

    const response = await request(app()).post("/architecture").send({
      projectId: project.id,
      idea: project.brief.idea,
      generateVisuals: false,
    });

    expect(response.status).toBe(200);
    expect(response.body.visual).toEqual({ mode: "legacy" });
    expect(generateArchitectureImage).not.toHaveBeenCalled();
    const stored = await getProject(project.id);
    expect(stored?.currentAssets["architecture-html"]).toBeUndefined();
    expect(stored?.currentAssets["architecture-validated-json-html"]).toBeUndefined();
    expect(stored?.currentAssets["architecture-image-derived-html"]).toBeUndefined();
    expect(stored?.currentAssets["architecture-narrative-html"]).toBeUndefined();
    expect(stored?.currentAssets["architecture-image"]).toBeUndefined();
    expect(stored?.currentAssets["architecture-narrative-image"]).toBeUndefined();
  });

  it("uses the validated overview when image generation is not configured", async () => {
    vi.mocked(isArchitectureImageConfigured).mockReturnValueOnce(false);
    const project = await createProject({
      title: "Validated overview fallback",
      idea: "Show the project overview without optional image model settings.",
      audience: "Leaders",
      purpose: "Explain the system",
    });
    projectIds.push(project.id);
    await storeProjectJsonAsset(project.id, "outline", { status: "approved" });

    const response = await request(app()).post("/architecture").send({
      projectId: project.id,
      idea: project.brief.idea,
      generateVisuals: true,
    });

    expect(response.status).toBe(200);
    expect(response.body.architecture.title).toBe(GRAPH.title);
    expect(response.body.visual).toEqual({
      mode: "legacy",
      fallbackReason:
        "Image generation is not configured; showing the validated overview.",
    });
    expect(generateArchitectureImage).not.toHaveBeenCalled();

    const progress = await request(app()).get(
      `/projects/${project.id}/architecture/progress`,
    );
    expect(progress.body).toMatchObject({
      status: "completed",
      stage: "Validated overview is ready",
      percent: 100,
      completedTasks: 0,
      totalTasks: 0,
      tasks: [],
    });
  });

  it("generates and retains only the validated JSON image", async () => {
    const project = await createProject({
      title: "Selected image",
      idea: "Generate one architecture image without unused visual variants.",
      audience: "Leaders",
      purpose: "Explain the system",
    });
    projectIds.push(project.id);
    await storeProjectJsonAsset(project.id, "outline", { status: "approved" });

    const response = await request(app()).post("/architecture").send({
      projectId: project.id,
      idea: project.brief.idea,
      visualMode: "image",
    });

    expect(response.status).toBe(200);
    expect(response.body.visual).toEqual({
      mode: "image",
      imageUrl: `/projects/${project.id}/architecture/image`,
      pptxDownloadUrl:
        `/projects/${project.id}/architecture/download.pptx`,
      pptxGenerateUrl:
        `/projects/${project.id}/architecture/generate-editable-pptx`,
    });
    expect(generateArchitectureImage).toHaveBeenCalledTimes(1);
    const operations = (fetch as ReturnType<typeof vi.fn>).mock.calls
      .map(([, init]) => JSON.parse(String((init as RequestInit | undefined)?.body)))
      .map(invocation => invocation.operation);
    expect(operations).toContain("architecture");
    expect(operations.filter(operation => operation === "architecture-html"))
      .toHaveLength(0);
    expect(operations.filter(operation => operation === "architecture-image-html"))
      .toHaveLength(0);
    expect(parseArchitectureImage).not.toHaveBeenCalled();
    const stored = await getProject(project.id);
    expect(stored?.currentAssets["architecture-image"]).toBeTruthy();
    expect(stored?.currentAssets["architecture-html"]).toBeUndefined();
    expect(stored?.currentAssets["architecture-validated-json-html"]).toBeUndefined();
    expect(stored?.currentAssets["architecture-image-derived-html"]).toBeUndefined();
    expect(stored?.currentAssets["architecture-narrative-html"]).toBeUndefined();
    expect(stored?.currentAssets["architecture-narrative-image"]).toBeUndefined();
    const image = await request(app()).get(
      `/projects/${project.id}/architecture/image`,
    );
    expect(image.status).toBe(200);
    expect(image.headers["content-type"]).toContain("image/png");
    const pptx = await request(app()).get(
      `/projects/${project.id}/architecture/download.pptx`,
    );
    expect(pptx.status).toBe(409);
    expect(pptx.body.error).toContain("Validated JSON → Image 2");

    await storeProjectBinaryAsset(
      project.id,
      "architecture-pptx",
      "pptx",
      Buffer.from("PK wrong source"),
      [stored!.currentAssets.architecture!],
      { conversionWorkflow: "image-to-editable-ppt" },
    );
    const wrongSource = await request(app()).get(
      `/projects/${project.id}/architecture/download.pptx`,
    );
    expect(wrongSource.status).toBe(409);

    await storeProjectBinaryAsset(
      project.id,
      "architecture-pptx",
      "pptx",
      Buffer.from("PK dom conversion"),
      [stored!.currentAssets["architecture-image"]!],
      { conversionWorkflow: "dom-to-pptx" },
    );
    const wrongWorkflow = await request(app()).get(
      `/projects/${project.id}/architecture/download.pptx`,
    );
    expect(wrongWorkflow.status).toBe(409);

    await storeProjectBinaryAsset(
      project.id,
      "architecture-pptx",
      "pptx",
      Buffer.from("PK skill conversion"),
      [stored!.currentAssets["architecture-image"]!],
      {
        conversionWorkflow: "image-to-editable-ppt",
        editpptValidationPassed: true,
      },
    );
    const metadataOnlyClaim = await request(app()).get(
      `/projects/${project.id}/architecture/download.pptx`,
    );
    expect(metadataOnlyClaim.status).toBe(409);

    const [conversion, concurrentConversion] = await Promise.all([
      request(app()).post(
        `/projects/${project.id}/architecture/generate-editable-pptx`,
      ),
      request(app()).post(
        `/projects/${project.id}/architecture/generate-editable-pptx`,
      ),
    ]);
    expect(conversion.status).toBe(201);
    expect(concurrentConversion.status).toBe(201);
    expect(conversion.body).toMatchObject({
      invocationId: "skill-invocation-123",
      runId: "editppt-run-456",
      downloadUrl: `/projects/${project.id}/architecture/download.pptx`,
    });
    const skillInvocations = (fetch as ReturnType<typeof vi.fn>).mock.calls
      .map(([, init]) => JSON.parse(String((init as RequestInit | undefined)?.body)))
      .filter(invocation => invocation.operation === "image-to-editable-ppt");
    expect(skillInvocations).toHaveLength(1);
    const skillInvocation = skillInvocations[0];
    expect(skillInvocation.input).toMatchObject({
      projectId: project.id,
      sourceAssetId: stored!.currentAssets["architecture-image"],
      sourceImageMediaType: "image/png",
    });
    expect(skillInvocation.input.sourceImageSha256).toMatch(/^[a-f0-9]{64}$/);

    const skillPptx = await request(app()).get(
      `/projects/${project.id}/architecture/download.pptx`,
    );
    expect(skillPptx.status).toBe(200);
    expect(skillPptx.headers["content-type"]).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    expect(skillPptx.headers["content-disposition"]).toContain(
      'filename="presentation-overview-editable.pptx"',
    );
    const progress = await request(app()).get(
      `/projects/${project.id}/architecture/progress`,
    );
    expect(progress.body).toMatchObject({
      status: "completed",
      percent: 100,
      completedTasks: 1,
      totalTasks: 1,
    });
    expect(progress.body.tasks).toHaveLength(1);
    expect(progress.body.tasks.every(
      (task: { status: string }) => task.status === "completed",
    )).toBe(true);
  });

  it.skip("generates enabled options as sandbox-compatible retained assets", async () => {
    const project = await createProject({
      title: "Creative architecture",
      idea: "Generate a visually polished architecture from user input.",
      audience: "Leaders",
      purpose: "Explain the system",
    });
    projectIds.push(project.id);
    await storeProjectJsonAsset(project.id, "outline", { status: "approved" });

    const response = await request(app()).post("/architecture").send({
      projectId: project.id,
      idea: project.brief.idea,
      context: "Approved architecture.",
      visualMode: "html",
    });

    expect(response.status).toBe(200);
    expect(response.body.visual).toEqual({
      mode: "dual",
      htmlUrl: `/projects/${project.id}/architecture/html`,
      imageUrl: `/projects/${project.id}/architecture/image`,
      imageDerivedHtmlUrl:
        `/projects/${project.id}/architecture/image-derived-html`,
    });
    expect((await getProject(project.id))?.currentAssets["architecture-html"]).toBeTruthy();
    expect((await getProject(project.id))?.currentAssets["architecture-validated-json-html"])
      .toBeUndefined();
    expect((await getProject(project.id))?.currentAssets["architecture-image-derived-html"])
      .toBeTruthy();
    expect((await getProject(project.id))?.currentAssets["architecture-narrative-html"])
      .toBeUndefined();
    expect((await getProject(project.id))?.currentAssets["architecture-image"]).toBeTruthy();
    expect((await getProject(project.id))?.currentAssets["architecture-narrative-image"])
      .toBeUndefined();
    expect(generateArchitectureImage).toHaveBeenCalledTimes(1);

    const html = await request(app()).get(`/projects/${project.id}/architecture/html`);
    expect(html.status).toBe(200);
    expect(html.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(html.text).toContain("Creative architecture");
  });

  it("fails when the only enabled image generation fails", async () => {
    vi.mocked(generateArchitectureImage).mockRejectedValueOnce(
      new Error("Timeout after 120000ms waiting for session.idle"),
    );
    const project = await createProject({
      title: "Partial visual success",
      idea: "Generate architecture options without failing the complete workflow.",
      audience: "Leaders",
      purpose: "Explain the system",
    });
    projectIds.push(project.id);
    await storeProjectJsonAsset(project.id, "outline", { status: "approved" });

    const response = await request(app()).post("/architecture").send({
      projectId: project.id,
      idea: project.brief.idea,
      visualMode: "image",
    });

    expect(response.status).toBe(500);
    expect(response.body.error).toContain("Timeout");
    const stored = await getProject(project.id);
    expect(stored?.currentAssets["architecture-image"]).toBeUndefined();
    const progress = await request(app()).get(
      `/projects/${project.id}/architecture/progress`,
    );
    expect(progress.body).toMatchObject({
      status: "failed",
      percent: 100,
      completedTasks: 1,
      totalTasks: 1,
    });
    expect(progress.body.tasks.filter(
      (task: { status: string }) => task.status === "failed",
    )).toHaveLength(1);
  });

  it.skip("removes executable HTML", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const operation = JSON.parse(String(init?.body)).operation;
        const content = ["architecture-html", "architecture-image-html"].includes(operation)
          ? HTML.replace("<main", "<script>alert(1)</script><main onload=\"alert(1)\"")
          : JSON.stringify(GRAPH);
        return new Response(JSON.stringify({ result: { content } }), { status: 200 });
      },
    );
    const project = await createProject({
      title: "Unsafe architecture",
      idea: "Generate a polished architecture from approved input.",
      audience: "",
      purpose: "",
    });
    projectIds.push(project.id);
    await storeProjectJsonAsset(project.id, "outline", { status: "approved" });

    const response = await request(app()).post("/architecture").send({
      projectId: project.id,
      idea: project.brief.idea,
      visualMode: "html",
    });
    expect(response.status).toBe(200);
    const html = await request(app()).get(response.body.visual.htmlUrl);
    expect(html.text).toContain("Creative architecture");
    expect(html.text).not.toContain("<script");
    expect(html.text).not.toContain("onload");
    expect(html.text).toContain('id="architecture-layout-guard"');
  });

  it.skip("repairs detached overlay connectors before storing HTML", async () => {
    let htmlAttempts = 0;
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const invocation = JSON.parse(String(init?.body));
        if (invocation.operation === "architecture-image-html") {
          return new Response(JSON.stringify({ result: { content: HTML } }), { status: 200 });
        }
        if (invocation.operation !== "architecture-html") {
          return new Response(JSON.stringify({ result: { content: JSON.stringify(GRAPH) } }), { status: 200 });
        }
        htmlAttempts += 1;
        const content = htmlAttempts === 1
          ? HTML
              .replace('data-from="agent" data-to="store"', 'data-from="api" data-to="store"')
              .replace(".connector{", ".connector{position:absolute;")
          : HTML;
        return new Response(JSON.stringify({ result: { content } }), { status: 200 });
      },
    );
    const project = await createProject({
      title: "Repair connectors",
      idea: "Generate architecture with correctly anchored component arrows.",
      audience: "Engineers",
      purpose: "Explain runtime flow",
    });
    projectIds.push(project.id);
    await storeProjectJsonAsset(project.id, "outline", { status: "approved" });

    const response = await request(app()).post("/architecture").send({
      projectId: project.id,
      idea: project.brief.idea,
      visualMode: "html",
    });

    expect(response.status).toBe(200);
    expect(htmlAttempts).toBe(2);
    const html = await request(app()).get(response.body.visual.htmlUrl);
    expect(html.text).toContain("data-connector");
    expect(html.text).not.toContain("<svg");
    expect(html.text).not.toContain("position:absolute");
    expect(html.text).toContain("font-size:14px!important");
  });
});
