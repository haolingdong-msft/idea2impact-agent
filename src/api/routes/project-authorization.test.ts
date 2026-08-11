import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProject,
  projectDirectory,
  type ProjectBrief,
} from "./project-store.js";
import { authorizeProjectRequest } from "./project-authorization.js";
import { rm } from "node:fs/promises";

const brief: ProjectBrief = {
  title: "Owned project",
  idea: "A sufficiently detailed presentation idea.",
  audience: "",
  purpose: "",
};

const createdProjects: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(createdProjects.splice(0).map(projectId =>
    rm(projectDirectory(projectId), { recursive: true, force: true })));
});

describe("project authorization", () => {
  it("allows the explicit local-development owner", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const project = await createProject(brief);
    createdProjects.push(project.id);
    const app = express();
    app.use(express.json());
    app.use(authorizeProjectRequest);
    app.get("/projects/:projectId", (_request, response) => {
      response.json({ ok: true });
    });
    const response = await request(app).get(`/projects/${project.id}`);
    expect(response.status).toBe(200);
  });

  it("rejects anonymous production access to an owned project", async () => {
    const project = await createProject(brief, {
      kind: "github",
      id: "123",
      login: "owner",
    });
    createdProjects.push(project.id);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", "production-test-session-secret");
    const app = express();
    app.use(express.json());
    app.use(authorizeProjectRequest);
    app.get("/projects/:projectId", (_request, response) => {
      response.json({ ok: true });
    });
    const response = await request(app).get(`/projects/${project.id}`);
    expect(response.status).toBe(401);
  });
});
