import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../client.js", () => ({
  getClient: vi.fn(),
}));

vi.mock("../model-config.js", () => ({
  getSessionOptions: vi.fn().mockResolvedValue({}),
  enhanceModelError: vi.fn((error: unknown) =>
    error instanceof Error ? error : new Error(String(error))),
}));

import { getClient } from "../client.js";
import architectureRoutes, { validateArchitectureGraph } from "./architecture.js";

const GRAPH = {
  title: "Presentation Agent Architecture",
  summary: "A browser workspace uses Copilot to structure and render architecture.",
  layers: [
    {
      id: "experience",
      label: "Experience",
      purpose: "Captures the idea and displays the graph.",
      tone: "navy",
      nodes: [
        {
          id: "web-workspace",
          label: "Web Workspace",
          description: "Collects briefs and renders HTML.",
          kind: "interface",
          technology: "React and TypeScript",
          provenance: "confirmed",
        },
      ],
    },
    {
      id: "intelligence",
      label: "Intelligence",
      purpose: "Structures the architecture.",
      tone: "blue",
      nodes: [
        {
          id: "copilot-agent",
          label: "Copilot Agent",
          description: "Creates validated graph JSON.",
          kind: "agent",
          technology: "GitHub Copilot SDK",
          provenance: "confirmed",
        },
      ],
    },
  ],
  connections: [
    {
      from: "web-workspace",
      to: "copilot-agent",
      label: "request architecture",
      type: "request",
      mechanism: "HTTPS JSON",
      payload: "approved idea and context",
      provenance: "confirmed",
      primary: true,
    },
  ],
  assumptions: ["GitHub authentication is available."],
};

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(architectureRoutes);
  return app;
}

function createSession(content: string) {
  return {
    sendAndWait: vi.fn().mockResolvedValue({ data: { content } }),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
}

describe("POST /architecture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a missing or short idea", async () => {
    const response = await request(createApp()).post("/architecture").send({ idea: "short" });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("at least 10");
  });

  it("returns a validated architecture graph", async () => {
    const session = createSession(JSON.stringify(GRAPH));
    const createSessionMock = vi.fn().mockResolvedValue(session);
    (getClient as Mock).mockResolvedValue({ createSession: createSessionMock });

    const response = await request(createApp()).post("/architecture").send({
      idea: "Build an agent that turns an idea into an architecture graph.",
      audience: "Engineering leaders",
      purpose: "Approve an MVP",
      context: "Problem, user story, and architecture were explicitly approved.",
    });

    expect(response.status).toBe(200);
    expect(response.body.architecture.title).toBe("Presentation Agent Architecture");
    expect(response.body.architecture.layers).toHaveLength(2);
    expect(createSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        systemMessage: expect.objectContaining({ mode: "append" }),
      }),
    );
    expect(session.destroy).toHaveBeenCalledOnce();
    expect(session.sendAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringMatching(
          /concrete technical runtime.*directional, technically specific/s,
        ),
      }),
      120_000,
    );
  });

  it("rejects invalid clarification context", async () => {
    const response = await request(createApp()).post("/architecture").send({
      idea: "Build an agent that renders architecture in HTML.",
      context: { approved: true },
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("'context' must be a string");
  });

  it("rejects connections to unknown nodes", () => {
    expect(() => validateArchitectureGraph({
      ...GRAPH,
      connections: [{
        ...GRAPH.connections[0],
        from: "missing",
      }],
    })).toThrow("unknown node");
  });

  it("requires labeled technical component interactions", () => {
    expect(() => validateArchitectureGraph({
      ...GRAPH,
      connections: [],
    })).toThrow("labeled component interactions");
    expect(() => validateArchitectureGraph({
      ...GRAPH,
      connections: [{ ...GRAPH.connections[0], label: "" }],
    })).toThrow("technical interaction label");
  });

  it("rejects disconnected technical components and missing primary flow", () => {
    expect(() => validateArchitectureGraph({
      ...GRAPH,
      layers: [...GRAPH.layers, {
        id: "data",
        label: "Data",
        purpose: "Stores assets.",
        tone: "teal",
        nodes: [{
          id: "asset-store",
          label: "Asset Store",
          description: "Stores generated assets.",
          kind: "data",
          technology: "Filesystem",
          provenance: "assumed",
        }],
      }],
    })).toThrow("Asset Store");
    expect(() => validateArchitectureGraph({
      ...GRAPH,
      connections: GRAPH.connections.map(connection => ({
        ...connection,
        primary: false,
      })),
    })).toThrow("primary interaction");
  });

  it("returns 500 when Copilot returns invalid JSON", async () => {
    const session = createSession("not json");
    (getClient as Mock).mockResolvedValue({
      createSession: vi.fn().mockResolvedValue(session),
    });

    const response = await request(createApp()).post("/architecture").send({
      idea: "Build an agent that renders architecture in HTML.",
    });

    expect(response.status).toBe(500);
    expect(response.body.error).toContain("no architecture JSON");
    expect(session.destroy).toHaveBeenCalledOnce();
  });
});
