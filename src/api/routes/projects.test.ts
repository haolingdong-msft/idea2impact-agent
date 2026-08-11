import { rm } from "node:fs/promises";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearCurrentProjectAssets,
  createProject,
  getProject,
  projectDirectory,
  storeProjectJsonAsset,
  storeProjectTextAsset,
} from "./project-store.js";
import projectRoutes from "./projects.js";

const createdProjects: string[] = [];

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(projectRoutes);
  return app;
}

afterEach(async () => {
  await Promise.all(
    createdProjects.splice(0).map(projectId =>
      rm(projectDirectory(projectId), { recursive: true, force: true })),
  );
});

describe("presentation projects", () => {
  it("creates a persisted project with a brief asset", async () => {
    const response = await request(createApp()).post("/projects").send({
      title: "Presentation Agent",
      idea: "Build an agent that creates architecture and slides.",
      audience: "Engineering leaders",
      purpose: "Approve an MVP",
      repositoryUrl: "https://github.com/example/presentation-agent",
    });

    expect(response.status).toBe(201);
    createdProjects.push(response.body.project.id);
    expect(response.body.project.assets[0]).toMatchObject({
      type: "brief",
      format: "json",
      revision: 1,
    });

    const loaded = await request(createApp())
      .get(`/projects/${response.body.project.id}`);
    expect(loaded.status).toBe(200);
    expect(loaded.body.project.brief.title).toBe("Presentation Agent");
    expect(loaded.body.project.brief.repositoryUrl).toBe(
      "https://github.com/example/presentation-agent",
    );
  });

  it("creates a project when only the idea is supplied", async () => {
    const response = await request(createApp()).post("/projects").send({
      idea: "Create architecture and slides from one concise idea.",
    });

    expect(response.status).toBe(201);
    createdProjects.push(response.body.project.id);
    expect(response.body.project.brief).toMatchObject({
      idea: "Create architecture and slides from one concise idea.",
      audience: "",
      purpose: "",
    });
  });

  it("rejects non-GitHub repository URLs", async () => {
    const response = await request(createApp()).post("/projects").send({
      idea: "Create architecture and slides from a source repository.",
      repositoryUrl: "https://example.com/owner/repository",
    });

    expect(response.status).toBe(400);
  });

  it("stores approved story context with brief lineage", async () => {
    const created = await request(createApp()).post("/projects").send({
      idea: "Create a presentation workflow with persistent assets.",
    });
    const projectId = created.body.project.id;
    createdProjects.push(projectId);

    const response = await request(createApp())
      .put(`/projects/${projectId}/story`)
      .send({
        context: "The three story sections were approved.",
        approvedSections: ["problem", "userStory", "architecture"],
      });

    expect(response.status).toBe(200);
    expect(response.body.asset.type).toBe("story");
    expect(response.body.asset.sourceAssetIds).toContain(
      created.body.project.currentAssets.brief,
    );
  });

  it("invalidates current slides without deleting revision history", async () => {
    const project = await createProject({
      title: "Presentation Agent",
      idea: "Keep slide revisions when architecture changes.",
      audience: "",
      purpose: "",
    });
    createdProjects.push(project.id);
    await storeProjectJsonAsset(project.id, "slide-model", { slides: [] });
    await storeProjectTextAsset(project.id, "slide-deck", "html", "<html></html>");

    const before = await getProject(project.id);
    await clearCurrentProjectAssets(project.id, ["slide-model", "slide-deck"]);
    const after = await getProject(project.id);

    expect(after?.assets).toHaveLength(before?.assets.length ?? 0);
    expect(after?.currentAssets["slide-model"]).toBeUndefined();
    expect(after?.currentAssets["slide-deck"]).toBeUndefined();
  });
});
