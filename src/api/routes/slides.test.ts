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

vi.mock("./pptx-export.js", () => ({
  exportHtmlToEditablePptx: vi.fn().mockResolvedValue(
    Buffer.from("PK editable pptx"),
  ),
}));

import { getClient } from "../client.js";
import { exportHtmlToEditablePptx } from "./pptx-export.js";
import type { ArchitectureGraph } from "./architecture.js";
import {
  createProject,
  projectDirectory,
  storeProjectJsonAsset,
  storeProjectTextAsset,
} from "./project-store.js";
import slideRoutes, {
  renderSlideDeckHtml,
  validateSlideDeck,
  type SlideDeck,
} from "./slides.js";

const GRAPH: ArchitectureGraph = {
  title: "Presentation Agent Architecture",
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
  title: "Presentation Agent",
  subtitle: "From idea to polished presentation assets.",
  theme: "azure",
  slides: [
    {
      id: "opening",
      kind: "title",
      eyebrow: "Presentation Agent",
      title: "Build the story once",
      subtitle: "Carry approved context through every step.",
      bullets: [],
    },
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
    {
      id: "system",
      kind: "architecture",
      eyebrow: "Architecture",
      title: "Assets flow through one workspace",
      subtitle: "The approved graph remains the source of truth.",
      bullets: [],
    },
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
  });

  it("validates required outline slides", () => {
    expect(validateSlideDeck(DECK).slides).toHaveLength(5);
    expect(() => validateSlideDeck({
      ...DECK,
      slides: DECK.slides.filter(slide => slide.kind !== "architecture"),
    })).toThrow("between 5 and 8");
  });

  it("escapes generated HTML content", () => {
    const html = renderSlideDeckHtml({
      ...DECK,
      title: "<script>alert(1)</script>",
    }, GRAPH);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("GitHub Copilot SDK");
    expect(html).toContain("HTTPS JSON");
    expect(html).toContain("approved story context");
  });

  it("renders editable SVG or a self-contained pixel fallback", () => {
    const layout = {
      width: 1600 as const,
      height: 900 as const,
      nodes: [
        { id: "workspace", x: 100, y: 200, width: 300, height: 150 },
        { id: "copilot", x: 800, y: 200, width: 300, height: 150 },
      ],
      connections: [{
        from: "workspace",
        to: "copilot",
        points: [{ x: 400, y: 275 }, { x: 800, y: 275 }],
        labelX: 600,
        labelY: 250,
      }],
    };
    const editable = renderSlideDeckHtml(DECK, GRAPH, { layout });
    expect(editable).toContain("architecture-generated-svg");
    expect(editable).toContain("generate architecture");

    const raster = renderSlideDeckHtml(DECK, GRAPH, {
      imageDataUrl: "data:image/png;base64,cG5n",
    });
    expect(raster).toContain("data:image/png;base64,cG5n");
    expect(raster).toContain("architecture-image");
  });

  it("generates and stores HTML slides with asset lineage", async () => {
    const project = await createProject({
      title: "Presentation Agent",
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
        userScenarios: "Presenters refine one outline and generate reusable assets.",
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
        data: { content: JSON.stringify(DECK) },
      }),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    (getClient as Mock).mockResolvedValue({
      createSession: vi.fn().mockResolvedValue(session),
    });

    const response = await request(createApp())
      .post("/slides")
      .send({ projectId: project.id, architectureVisualMode: "image-html" });

    expect(response.status).toBe(201);
    expect(response.body.deck.slides).toHaveLength(5);
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
    expect(preview.text).toContain("Image-derived option six");
    expect(preview.text).toContain("architecture-html-embed");
    expect(preview.text).toContain("@scope (.architecture-html-embed)");
    expect(preview.text).not.toContain("<iframe");
    expect(preview.text).not.toContain("srcdoc=");
    expect(preview.text).toContain("overflow:hidden!important;contain:layout paint");
    expect(preview.text).toContain("slide-architecture-canvas");
    expect(preview.text).toContain("width:100vw;height:100vh");
    expect(session.destroy).toHaveBeenCalledOnce();

    const pptx = await request(createApp())
      .get(`/projects/${project.id}/slides/download.pptx`);
    expect(pptx.status).toBe(200);
    expect(pptx.headers["content-type"]).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    expect(pptx.headers["content-disposition"]).toContain(
      'filename="presentation-slides-editable.pptx"',
    );
    expect(exportHtmlToEditablePptx).toHaveBeenCalledOnce();

    const cachedPptx = await request(createApp())
      .get(`/projects/${project.id}/slides/download.pptx`);
    expect(cachedPptx.status).toBe(200);
    expect(exportHtmlToEditablePptx).toHaveBeenCalledOnce();
  });
});
