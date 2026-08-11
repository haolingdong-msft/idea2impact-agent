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

import { getClient } from "../client.js";
import type { ArchitectureGraph } from "./architecture.js";
import {
  createProject,
  projectDirectory,
  storeProjectJsonAsset,
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
      kind: "user-story",
      eyebrow: "User story",
      title: "One guided project",
      subtitle: "",
      bullets: ["A presenter moves from idea to slides without re-entering context."],
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

  it("validates required story slides", () => {
    expect(validateSlideDeck(DECK).slides).toHaveLength(4);
    expect(() => validateSlideDeck({
      ...DECK,
      slides: DECK.slides.filter(slide => slide.kind !== "architecture"),
    })).toThrow("between 4 and 8");
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

  it("generates and stores HTML slides with asset lineage", async () => {
    const project = await createProject({
      title: "Presentation Agent",
      idea: "Create architecture and slides in one guided workflow.",
      audience: "Engineering leaders",
      purpose: "Approve the implementation",
    });
    createdProjects.push(project.id);
    const story = await storeProjectJsonAsset(
      project.id,
      "story",
      {
        context: "Problem, user story, and architecture approved.",
        approvedSections: ["problem", "userStory", "architecture"],
      },
      [project.currentAssets.brief!],
    );
    await storeProjectJsonAsset(
      project.id,
      "architecture",
      GRAPH,
      [story.asset.id],
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
      .send({ projectId: project.id });

    expect(response.status).toBe(201);
    expect(response.body.deck.slides).toHaveLength(4);
    expect(response.body.assets.model.type).toBe("slide-model");
    expect(response.body.assets.html.type).toBe("slide-deck");
    expect(response.body.assets.html.sourceAssetIds).toContain(
      response.body.assets.model.id,
    );

    const preview = await request(createApp())
      .get(`/projects/${project.id}/slides/preview`);
    expect(preview.status).toBe(200);
    expect(preview.headers["content-type"]).toContain("text/html");
    expect(preview.text).toContain("Web Workspace");
    expect(preview.text).toContain("generate architecture");
    expect(session.destroy).toHaveBeenCalledOnce();
  });
});
