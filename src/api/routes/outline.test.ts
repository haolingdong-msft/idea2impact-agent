import { rm } from "node:fs/promises";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { OUTLINE_PROMPT } from "../presentation-instructions.js";
import {
  createProject,
  getProject,
  projectDirectory,
  storeProjectJsonAsset,
} from "./project-store.js";
import outlineRoutes, { validateOutline } from "./outline.js";

const createdProjects: string[] = [];

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(outlineRoutes);
  return app;
}

afterEach(async () => {
  await Promise.all(createdProjects.splice(0).map(projectId =>
    rm(projectDirectory(projectId), { recursive: true, force: true })));
});

describe("outline routes", () => {
  it("requires repository evidence to populate all three fields automatically", () => {
    expect(OUTLINE_PROMPT).toContain("summarize the codebase into all three");
    expect(OUTLINE_PROMPT).toContain("Do not wait for additional user answers");
    expect(OUTLINE_PROMPT).toContain("Mark product intent");
  });

  it("generates all three initial fields from an idea without repository evidence", () => {
    expect(OUTLINE_PROMPT).toContain("no repository evidence is supplied");
    expect(OUTLINE_PROMPT).toContain("generate a complete initial version");
    expect(OUTLINE_PROMPT).toContain("Chat is used to refine that draft afterward");
  });

  it("allows partial drafts but requires complete approval content", () => {
    expect(validateOutline({ problemStatement: "Draft" }).status).toBe("draft");
    expect(() => validateOutline({
      problemStatement: "Too short",
      userScenarios: "Too short",
      solution: "Too short",
    }, "approved")).toThrow("Complete all three");
  });

  it("autosaves a draft, invalidates generated assets, and approves one revision", async () => {
    const project = await createProject({
      title: "Outline workflow",
      idea: "Create slides from one approved editable presentation outline.",
      audience: "Engineering leaders",
      purpose: "Explain the design",
    });
    createdProjects.push(project.id);
    await storeProjectJsonAsset(project.id, "architecture", { title: "stale" });

    const draft = {
      problemStatement: "Teams repeatedly recreate presentation context after a proof of concept.",
      userScenarios: "A presenter refines scenarios in chat or edits the central outline directly.",
      solution: "A Copilot workflow stores one outline and generates architecture, slides, and speech notes.",
    };
    const saved = await request(createApp())
      .put(`/projects/${project.id}/outline`)
      .send(draft);
    expect(saved.status).toBe(200);
    expect(saved.body.outline.status).toBe("draft");
    expect((await getProject(project.id))?.currentAssets.architecture).toBeUndefined();

    const approved = await request(createApp())
      .post(`/projects/${project.id}/outline/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body.outline.status).toBe("approved");
    expect(approved.body.asset.sourceAssetIds).toContain(saved.body.asset.id);
    expect(approved.body.project.currentAssets.outline).toBe(approved.body.asset.id);
  });
});
