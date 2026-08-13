import { rm } from "node:fs/promises";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("../client.js", () => ({ getClient: vi.fn() }));
vi.mock("../model-config.js", () => ({
  getSessionOptions: vi.fn().mockResolvedValue({}),
  enhanceModelError: vi.fn((error: unknown) =>
    error instanceof Error ? error : new Error(String(error))),
}));

import { getClient } from "../client.js";
import {
  createProject,
  projectDirectory,
  storeProjectJsonAsset,
} from "./project-store.js";
import speechRoutes, { validateSpeechScript } from "./speech.js";
import type { SlideDeck } from "./slides.js";

const DECK: SlideDeck = {
  title: "Presentation Agent",
  subtitle: "One outline to finished assets.",
  theme: "azure",
  slides: [
    { id: "title", kind: "title", eyebrow: "", title: "Presentation Agent", subtitle: "", bullets: [] },
    { id: "problem", kind: "problem", eyebrow: "", title: "The problem", subtitle: "", bullets: ["Manual handoffs lose context."] },
    { id: "scenarios", kind: "user-scenarios", eyebrow: "", title: "User scenarios", subtitle: "", bullets: ["Presenters refine one outline."] },
    { id: "solution", kind: "solution", eyebrow: "", title: "The solution", subtitle: "", bullets: ["One workflow versions every asset."] },
    { id: "architecture", kind: "architecture", eyebrow: "", title: "Architecture", subtitle: "", bullets: [] },
  ],
};

const SCRIPT = {
  title: "Presentation Agent speaker notes",
  notes: DECK.slides.map(slide => ({
    slideId: slide.id,
    slideTitle: slide.title,
    script: `Explain ${slide.title} using the approved presentation outline and slide content.`,
  })),
};

const createdProjects: string[] = [];

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(speechRoutes);
  return app;
}

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(createdProjects.splice(0).map(projectId =>
    rm(projectDirectory(projectId), { recursive: true, force: true })));
});

describe("speech script routes", () => {
  it("validates exact slide coverage and order", () => {
    expect(validateSpeechScript(SCRIPT, DECK).notes).toHaveLength(5);
    expect(() => validateSpeechScript({
      ...SCRIPT,
      notes: SCRIPT.notes.slice(1),
    }, DECK)).toThrow("one note for every slide");
  });

  it("generates and stores speaker notes with outline and deck lineage", async () => {
    const project = await createProject({
      title: "Presentation Agent",
      idea: "Generate editable speaker notes from an approved slide deck.",
      audience: "Engineering leaders",
      purpose: "Prepare a talk track",
    });
    createdProjects.push(project.id);
    const outline = await storeProjectJsonAsset(project.id, "outline", {
      problemStatement: "Manual presentation work loses approved context.",
      userScenarios: "Presenters create one grounded slide workflow.",
      solution: "Generate slides and speaker notes from one outline.",
      status: "approved",
    });
    const deck = await storeProjectJsonAsset(
      project.id,
      "slide-model",
      DECK,
      [outline.asset.id],
    );
    const session = {
      sendAndWait: vi.fn().mockResolvedValue({
        data: { content: JSON.stringify(SCRIPT) },
      }),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    (getClient as Mock).mockResolvedValue({
      createSession: vi.fn().mockResolvedValue(session),
    });

    const response = await request(createApp())
      .post(`/projects/${project.id}/speech-script/generate`);
    expect(response.status).toBe(201);
    expect(response.body.script.notes).toHaveLength(5);
    expect(response.body.asset.type).toBe("speech-script");
    expect(response.body.asset.sourceAssetIds).toEqual(
      expect.arrayContaining([outline.asset.id, deck.asset.id]),
    );
  });
});
