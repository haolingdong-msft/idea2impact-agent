import { rm } from "node:fs/promises";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("../client.js", () => ({
  getClient: vi.fn(),
}));

vi.mock("../model-config.js", () => ({
  getSessionOptions: vi.fn().mockResolvedValue({}),
  enhanceModelError: vi.fn((error: unknown) =>
    error instanceof Error ? error : new Error(String(error))),
}));

vi.mock("../hosted-agent-client.js", () => ({
  invokeHostedAgent: vi.fn(),
  invokeHostedStructured: vi.fn(),
  isHostedAgentConfigured: vi.fn(() => false),
}));

vi.mock("../architecture-visual.js", () => ({
  generateArchitectureImage: vi.fn()
    .mockResolvedValue(new Uint8Array(Buffer.from("generated-slide-image"))),
  isArchitectureImageConfigured: vi.fn(() => true),
}));

import { getClient } from "../client.js";
import {
  invokeHostedAgent,
  isHostedAgentConfigured,
} from "../hosted-agent-client.js";
import { generateArchitectureImage } from "../architecture-visual.js";
import type { ArchitectureGraph } from "./architecture.js";
import {
  createProject,
  getProject,
  projectDirectory,
  readProjectBinaryAsset,
  storeProjectJsonAsset,
  storeProjectTextAsset,
} from "./project-store.js";
import slideRoutes, {
  buildSlideImagePrompt,
  renderSlideDeckHtml,
  validateSlideDeck,
  type SlideDeck,
} from "./slides.js";

const GRAPH: ArchitectureGraph = {
  title: "Idea2Impact Agent Architecture",
  summary: "A guided workflow creates presentation assets.",
  layers: [
    {
      id: "experience",
      label: "Experience",
      purpose: "Guides the presenter.",
      tone: "navy",
      nodes: [
        {
          id: "workspace",
          label: "Web Workspace",
          description: "Hosts the workflow.",
          kind: "interface",
          technology: "React",
          provenance: "confirmed",
        },
      ],
    },
    {
      id: "agent",
      label: "Agent",
      purpose: "Generates presentation assets.",
      tone: "blue",
      nodes: [
        {
          id: "copilot",
          label: "Copilot SDK",
          description: "Generates structured presentation content.",
          kind: "agent",
          technology: "GitHub Copilot SDK",
          provenance: "confirmed",
        },
      ],
    },
  ],
  platforms: [
    {
      id: "web-platform",
      label: "Web Platform",
      description: "Hosts the user workspace.",
      technology: "React",
      componentNodeIds: ["workspace"],
      provenance: "confirmed",
    },
    {
      id: "copilot-platform",
      label: "GitHub Copilot",
      description: "Hosts presentation generation.",
      technology: "GitHub Copilot SDK",
      componentNodeIds: ["copilot"],
      provenance: "confirmed",
    },
  ],
  workflow: {
    actor: "Presenter",
    goal: "Generate a presentation",
    steps: [
      {
        id: "review-story",
        order: 1,
        label: "Review story",
        userAction: "Review the presentation story.",
        platformCalls: [{
          nodeId: "workspace",
          action: "present story",
          mechanism: "React UI",
          output: "approved story",
        }],
      },
      {
        id: "generate-deck",
        order: 2,
        label: "Generate deck",
        userAction: "Request presentation generation.",
        platformCalls: [{
          nodeId: "copilot",
          action: "generate presentation",
          mechanism: "Copilot SDK",
          output: "slide deck",
        }],
      },
    ],
  },
  connections: [{
    from: "workspace",
    to: "copilot",
    label: "generate architecture",
    type: "request",
    mechanism: "HTTPS JSON",
    payload: "approved story context",
    provenance: "confirmed",
    primary: true,
  }],
  assumptions: [],
};

const DECK: SlideDeck = {
  title: "Idea2Impact Agent",
  subtitle: "From idea to polished presentation assets.",
  theme: "azure",
  slides: [
    {
      id: "problem",
      kind: "problem",
      eyebrow: "Problem",
      title: "Presentation workflows lose context",
      subtitle: "",
      bullets: ["Creators repeat approved information across disconnected tools."],
    },
    {
      id: "journey",
      kind: "user-scenarios",
      eyebrow: "User scenarios",
      title: "One guided project",
      subtitle: "",
      bullets: ["A presenter moves from idea to slides without re-entering context."],
    },
    {
      id: "solution",
      kind: "solution",
      eyebrow: "Solution",
      title: "A synchronized presentation workflow",
      subtitle: "",
      bullets: ["One approved outline grounds architecture, slides, and speaker notes."],
    },
  ],
};

const FLEXIBLE_DECK: SlideDeck = {
  ...DECK,
  slides: [
    DECK.slides[0],
    {
      ...DECK.slides[0],
      id: "problem-impact",
      title: "The impact compounds",
      bullets: ["Rework grows every time presentation context is copied."],
    },
    ...DECK.slides.slice(1),
  ],
};

const createdProjects: string[] = [];

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(slideRoutes);
  return app;
}

afterEach(async () => {
  await Promise.all(createdProjects.splice(0).map(projectId =>
    rm(projectDirectory(projectId), { recursive: true, force: true })));
});

describe("slide generation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isHostedAgentConfigured).mockReturnValue(false);
  });

  it("validates required outline slides", () => {
    expect(validateSlideDeck(DECK).slides).toHaveLength(3);
    expect(validateSlideDeck({
      ...DECK,
      slides: [
        DECK.slides[0],
        {
          ...DECK.slides[0],
          id: "problem-impact",
          title: "The impact compounds",
        },
        ...DECK.slides.slice(1),
      ],
    }).slides).toHaveLength(4);
    expect(() => validateSlideDeck({
      ...DECK,
      slides: DECK.slides.filter(slide => slide.kind !== "solution"),
    })).toThrow("between 3 and 5");
  });

  it("escapes generated HTML content", () => {
    const html = renderSlideDeckHtml({
      ...DECK,
      title: "<script>alert(1)</script>",
    }, GRAPH);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("Presentation workflows lose context");
  });

  it("renders every generated image as a complete slide", () => {
    const html = renderSlideDeckHtml(DECK, GRAPH, {
      slideImages: {
        problem: "data:image/png;base64,cHJvYmxlbQ==",
        journey: "data:image/png;base64,dXNlcg==",
        solution: "data:image/png;base64,c29sdXRpb24=",
      },
    });
    expect(html.match(/<div class="slide-story-image">/g)).toHaveLength(3);
    expect(html.match(/slide-has-story-image/g)?.length).toBeGreaterThanOrEqual(4);
    expect(html).toContain(
      ".slide-has-story-image .slide-story-layout{display:block;width:100vw;height:100vh",
    );
    expect(html).toContain("data:image/png;base64,cHJvYmxlbQ==");
    expect(html).not.toContain("<ul>");
  });

  it("keeps image prompts strictly focused on their slide section", () => {
    const overviewGrounding =
      "Web Workspace (React): Hosts the workflow; Copilot SDK: Generates assets.";
    const problemPrompt = buildSlideImagePrompt({
      slide: DECK.slides[0],
      approvedSection: "Teams lose time rebuilding presentation context.",
      visualPoints: ["Teams lose time rebuilding presentation context."],
      overviewGrounding,
    });
    const scenarioPrompt = buildSlideImagePrompt({
      slide: DECK.slides[1],
      approvedSection: "Presenters refine one guided journey.",
      visualPoints: ["Presenters refine one guided journey."],
      overviewGrounding,
    });
    const solutionPrompt = buildSlideImagePrompt({
      slide: DECK.slides[2],
      approvedSection: "A Copilot workflow creates presentation assets.",
      visualPoints: ["A Copilot workflow creates presentation assets."],
      overviewGrounding,
    });

    expect(problemPrompt).toContain(
      "Focus only on user pain, context, impact, scope, and desired outcome.",
    );
    expect(scenarioPrompt).toContain(
      "Focus only on actors, goals, journeys, decisions, edge cases, and user value.",
    );
    for (const prompt of [problemPrompt, scenarioPrompt]) {
      expect(prompt).toContain(
        "Do not depict or name platforms, architecture, components, deployment",
      );
      expect(prompt).not.toContain("APPROVED OVERVIEW COMPONENTS:");
      expect(prompt).not.toContain("Web Workspace (React)");
    }
    expect(solutionPrompt).toContain(
      "You may depict capabilities, architecture, platforms, components",
    );
    expect(solutionPrompt).toContain("APPROVED OVERVIEW COMPONENTS:");
    expect(solutionPrompt).toContain("Web Workspace (React)");
  });

  it("generates and stores HTML slides with asset lineage", async () => {
    const project = await createProject({
      title: "Idea2Impact Agent",
      idea: "Create architecture and slides in one guided workflow.",
      audience: "Engineering leaders",
      purpose: "Approve the implementation",
    });
    createdProjects.push(project.id);
    const outline = await storeProjectJsonAsset(
      project.id,
      "outline",
      {
        problemStatement: "Teams lose time rebuilding presentation context.",
        userScenarios:
          "A presenter submits an idea and repository, reviews the generated overview and slide narrative, then works with an engineer to refine edge cases before final approval.",
        solution: "A Copilot workflow creates architecture, slides, and speaker notes.",
        status: "approved",
        approvedAt: "2026-08-11T00:00:00.000Z",
      },
      [project.currentAssets.brief!],
    );
    const architecture = await storeProjectJsonAsset(
      project.id,
      "architecture",
      GRAPH,
      [outline.asset.id],
    );
    const imageDerivedHtml = await storeProjectTextAsset(
      project.id,
      "architecture-image-derived-html",
      "html",
      "<!doctype html><html><body><main>Image-derived option six</main></body></html>",
      [architecture.asset.id],
    );
    const session = {
      sendAndWait: vi.fn().mockResolvedValue({
        data: { content: JSON.stringify(FLEXIBLE_DECK) },
      }),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    (getClient as Mock).mockResolvedValue({
      createSession: vi.fn().mockResolvedValue(session),
    });

    const response = await request(createApp())
      .post("/slides")
      .send({ projectId: project.id, architectureVisualMode: "image-html" });

    expect(response.status, response.body.error).toBe(201);
    expect(response.body.deck.slides).toHaveLength(4);
    expect(response.body.deck.slides.every(
      (slide: { imageUrl?: string }) => Boolean(slide.imageUrl),
    )).toBe(true);
    expect(generateArchitectureImage).toHaveBeenCalledTimes(4);
    const imagePrompts = vi.mocked(generateArchitectureImage).mock.calls
      .map(([prompt]) => prompt);
    expect(imagePrompts[0]).toContain(
      "APPROVED SECTION (verbatim):\nTeams lose time rebuilding presentation context.",
    );
    expect(imagePrompts[2]).toContain(
      "APPROVED SECTION (verbatim):\nA presenter submits an idea and repository, " +
      "reviews the generated overview and slide narrative, then works with an " +
      "engineer to refine edge cases before final approval.",
    );
    expect(imagePrompts[3]).toContain(
      "APPROVED SECTION (verbatim):\nA Copilot workflow creates architecture, slides, and speaker notes.",
    );
    expect(imagePrompts.every(prompt =>
      prompt.includes("Do not add generic presentation imagery"))).toBe(true);
    expect(imagePrompts[0]).toContain(
      "Do not depict or name platforms, architecture, components, deployment",
    );
    expect(imagePrompts[2]).toContain(
      "Do not depict or name platforms, architecture, components, deployment",
    );
    expect(imagePrompts[0]).not.toContain("APPROVED OVERVIEW COMPONENTS:");
    expect(imagePrompts[2]).not.toContain("APPROVED OVERVIEW COMPONENTS:");
    expect(imagePrompts[3]).toContain("APPROVED OVERVIEW COMPONENTS:");
    const deckPrompt = session.sendAndWait.mock.calls[0][0].prompt;
    expect(deckPrompt).toContain(
      "problem slides discuss only user pain, context, impact, scope, and desired",
    );
    expect(deckPrompt).toContain(
      "user-scenarios slides discuss only actors, goals, journeys, decisions, edge",
    );
    expect(deckPrompt).toContain(
      "Architecture input is supporting evidence for solution slides only.",
    );
    expect(imagePrompts[0]).toContain("TEXT TO RENDER VERBATIM:");
    expect(imagePrompts[0]).toContain(
      "1. Teams lose time rebuilding presentation context.",
    );
    expect(response.body.deck.slides[0].visualPoints).toEqual([
      "Teams lose time rebuilding presentation context.",
    ]);
    expect(response.body.deck.slides[2].visualPoints).toEqual([
      "A presenter submits an idea and repository, reviews the generated overview " +
      "and slide narrative, then works with an engineer to refine edge cases before " +
      "final approval.",
    ]);
    expect(response.body.deck.slides[3].visualPoints).toEqual([
      "A Copilot workflow creates architecture, slides, and speaker notes.",
    ]);
    expect(response.body.assets.model.type).toBe("slide-model");
    expect(response.body.assets.html.type).toBe("slide-deck");
    expect(response.body.assets.html.sourceAssetIds).toContain(
      response.body.assets.model.id,
    );
    expect(response.body.assets.html.sourceAssetIds).toContain(
      imageDerivedHtml.asset.id,
    );
    expect(response.body.pptxDownloadUrl).toBe(
      `/projects/${project.id}/slides/download.pptx`,
    );

    const preview = await request(createApp())
      .get(`/projects/${project.id}/slides/preview`);
    expect(preview.status).toBe(200);
    expect(preview.headers["content-type"]).toContain("text/html");
    expect(preview.text).toContain("Presentation workflows lose context");
    expect(preview.text).not.toContain("<iframe");
    expect(preview.text).not.toContain("srcdoc=");
    expect(preview.text).toContain("slide-story-layout");
    expect(preview.text).toContain("slide-has-story-image");
    expect(preview.text).toContain(
      ".slide-has-story-image .slide-story-layout{display:block;width:100vw;height:100vh",
    );
    expect(preview.text).not.toContain("<ul>");
    expect(session.destroy).toHaveBeenCalledOnce();

    const projectBeforePptx = await getProject(project.id);
    expect(projectBeforePptx?.currentAssets).toMatchObject({
      "slide-model": expect.any(String),
      "slide-image-problem": expect.any(String),
      "slide-image-problem-impact": expect.any(String),
      "slide-image-journey": expect.any(String),
      "slide-image-solution": expect.any(String),
    });
    const pptx = await request(createApp())
      .get(`/projects/${project.id}/slides/download.pptx`);
    expect(pptx.status, pptx.text).toBe(200);
    expect(pptx.headers["content-type"]).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    expect(pptx.headers["content-disposition"]).toContain(
      'filename="presentation-slides.pptx"',
    );
    const storedProject = await getProject(project.id);
    const storedPptx = storedProject?.assets.find(
      asset => asset.id === storedProject.currentAssets["slide-deck-pptx"],
    );
    expect(storedPptx?.metadata).toMatchObject({
      conversionWorkflow: "full-slide-images",
      editable: false,
      fullSlideScreenshot: true,
      slideCount: 4,
    });
    expect(storedPptx?.sourceAssetIds).toEqual(expect.arrayContaining([
      response.body.assets.model.id,
      expect.any(String),
    ]));
    const storedPptxContent = storedPptx
      ? await readProjectBinaryAsset(project.id, storedPptx.id)
      : null;
    expect(Buffer.from(storedPptxContent!.content).subarray(0, 2).toString())
      .toBe("PK");

    const problemImage = await request(createApp())
      .get(`/projects/${project.id}/slides/problem/image`);
    expect(problemImage.status).toBe(200);
    expect(problemImage.headers["content-type"]).toBe("image/png");
    const impactImage = await request(createApp())
      .get(`/projects/${project.id}/slides/problem-impact/image`);
    expect(impactImage.status).toBe(200);
    expect(storedPptx?.sourceAssetIds).toEqual(expect.arrayContaining([
      storedProject?.currentAssets["slide-image-problem"],
      storedProject?.currentAssets["slide-image-problem-impact"],
      storedProject?.currentAssets["slide-image-journey"],
      storedProject?.currentAssets["slide-image-solution"],
    ]));
  });
});
