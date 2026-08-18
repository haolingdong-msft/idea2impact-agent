import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
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
import architectureRoutes, {
  architectureDesignBrief,
  validateArchitectureGraph,
} from "./architecture.js";

const GRAPH = {
  title: "Idea2Impact Agent Architecture",
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
  platforms: [
    {
      id: "web-platform",
      label: "Web Platform",
      description: "Hosts the presentation workspace.",
      technology: "Web runtime",
      componentNodeIds: ["web-workspace"],
      toolings: [{
        id: "brief-capture",
        label: "Brief capture",
        description: "Captures the presentation brief.",
        technology: "React form",
        componentNodeId: "web-workspace",
      }],
      provenance: "confirmed",
    },
    {
      id: "copilot-platform",
      label: "GitHub Copilot",
      description: "Hosts architecture generation.",
      technology: "GitHub Copilot SDK",
      componentNodeIds: ["copilot-agent"],
      toolings: [{
        id: "architecture-generation",
        label: "Architecture generation",
        description: "Generates validated architecture JSON.",
        technology: "GitHub Copilot SDK",
        componentNodeId: "copilot-agent",
      }],
      provenance: "confirmed",
    },
  ],
  workflow: {
    actor: "Presenter",
    goal: "Generate and review an architecture",
    steps: [
      {
        id: "submit-brief",
        order: 1,
        label: "Submit brief",
        userAction: "Describe the desired architecture.",
        platformCalls: [{
          platformId: "web-platform",
          toolingId: "brief-capture",
          nodeId: "web-workspace",
          action: "capture brief",
          mechanism: "browser form",
          output: "approved context",
        }],
      },
      {
        id: "generate-graph",
        order: 2,
        label: "Generate graph",
        userAction: "Request the architecture result.",
        platformCalls: [{
          platformId: "copilot-platform",
          toolingId: "architecture-generation",
          nodeId: "copilot-agent",
          action: "generate validated graph",
          mechanism: "Copilot SDK",
          output: "architecture JSON",
        }],
      },
    ],
  },
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

function createSession(...contents: string[]) {
  const sendAndWait = vi.fn();
  for (const content of contents) {
    sendAndWait.mockResolvedValueOnce({ data: { content } });
  }
  return {
    sendAndWait,
    destroy: vi.fn().mockResolvedValue(undefined),
  };
}

describe("POST /architecture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("rejects a missing idea", async () => {
    const response = await request(createApp()).post("/architecture").send({ idea: " " });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("non-empty");
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
    expect(response.body.architecture.title).toBe("Idea2Impact Agent Architecture");
    expect(response.body.architecture.layers).toHaveLength(2);
    expect(response.body.architecture.platforms[0].toolings[0]).toMatchObject({
      componentNodeId: "web-workspace",
    });
    expect(response.body.architecture.workflow.steps[0].platformCalls[0])
      .toMatchObject({
        platformId: "web-platform",
        nodeId: "web-workspace",
      });
    expect(response.body.architecture.workflow.steps[0].platformCalls[0].toolingId)
      .toBe("brief-capture");
    expect(createSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        systemMessage: expect.objectContaining({ mode: "append" }),
      }),
    );
    expect(session.destroy).toHaveBeenCalledOnce();
    expect(session.sendAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringMatching(
          /simple executive-level system diagram.*directional, technically specific/s,
        ),
      }),
      120_000,
    );
    const prompt = session.sendAndWait.mock.calls[0][0].prompt;
    expect(prompt).toContain("model GitHub as a platform");
    expect(prompt).toContain("GitHub Copilot SDK as its own component");
    expect(prompt).toContain("directional connection from");
  });

  it("creates compact validated JSON with bounded technical connections", () => {
    const brief = architectureDesignBrief(GRAPH);
    const specification = JSON.parse(brief.slice(brief.indexOf("\n") + 1));

    expect(specification).not.toHaveProperty("layers");
    expect(specification).not.toHaveProperty("connections");
    expect(specification.components[0]).toMatchObject({
      id: "web-workspace",
      platformId: "web-platform",
    });
    expect(specification.technicalConnections).toHaveLength(1);
    expect(specification.technicalConnections[0]).toEqual({
      from: "web-workspace",
      to: "copilot-agent",
      label: "request architecture",
      mechanism: "HTTPS JSON",
    });
    expect(specification.workflow.steps[0]).toEqual({
      label: "Submit brief",
      platforms: ["web-platform"],
      tools: ["Brief capture"],
    });
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

  it("requires each component to belong to exactly one real platform", () => {
    expect(() => validateArchitectureGraph({
      ...GRAPH,
      platforms: [{
        ...GRAPH.platforms[0],
        componentNodeIds: ["missing-component"],
      }],
    })).toThrow("unique, real component node IDs");
    expect(() => validateArchitectureGraph({
      ...GRAPH,
      platforms: [GRAPH.platforms[0]],
    })).toThrow("Every non-actor component must belong to one platform");
  });

  it("requires explicit platform toolings and workflow tooling calls", () => {
    expect(() => validateArchitectureGraph({
      ...GRAPH,
      platforms: GRAPH.platforms.map(({ toolings: _toolings, ...platform }) => platform),
    })).toThrow("requires 1-6 important toolings");
    expect(() => validateArchitectureGraph({
      ...GRAPH,
      workflow: {
        ...GRAPH.workflow,
        steps: GRAPH.workflow.steps.map(step => ({
          ...step,
          platformCalls: step.platformCalls.map(
            ({ toolingId: _toolingId, ...call }) => call,
          ),
        })),
      },
    })).toThrow("must reference a real platform, tooling, and component");
  });

  it("limits the user workflow to seven consolidated steps", () => {
    expect(() => validateArchitectureGraph({
      ...GRAPH,
      workflow: {
        ...GRAPH.workflow,
        steps: Array.from({ length: 8 }, (_, index) => ({
          ...GRAPH.workflow.steps[0],
          id: `step-${index + 1}`,
          order: index + 1,
        })),
      },
    })).toThrow("2-7 consolidated steps");
  });

  it("enforces a simple subsystem-level graph", () => {
    const layers = Array.from({ length: 4 }, (_, layerIndex) => ({
      id: `layer-${layerIndex}`,
      label: `Layer ${layerIndex}`,
      purpose: "Groups high-level components.",
      tone: "blue",
      nodes: Array.from({ length: 3 }, (_, nodeIndex) => ({
        id: `component-${layerIndex}-${nodeIndex}`,
        label: `Component ${layerIndex}-${nodeIndex}`,
        description: "Represents a high-level subsystem.",
        kind: "service",
        technology: "Managed service",
        provenance: "assumed",
      })),
    }));
    expect(() => validateArchitectureGraph({
      ...GRAPH,
      layers,
    })).toThrow("8-component simplicity limit");
    expect(() => validateArchitectureGraph({
      ...GRAPH,
      connections: Array.from(
        { length: 15 },
        () => ({ ...GRAPH.connections[0] }),
      ),
    })).toThrow("10-connection simplicity limit");
  });

  it("repairs an invalid architecture response once", async () => {
    const invalidGraph = {
      ...GRAPH,
      connections: [{ ...GRAPH.connections[0], label: "" }],
    };
    const session = createSession(
      JSON.stringify(invalidGraph),
      JSON.stringify(GRAPH),
    );
    (getClient as Mock).mockResolvedValue({
      createSession: vi.fn().mockResolvedValue(session),
    });

    const response = await request(createApp()).post("/architecture").send({
      idea: "Build an agent that renders architecture in HTML.",
    });

    expect(response.status).toBe(200);
    expect(response.body.architecture.title).toBe(GRAPH.title);
    expect(session.sendAndWait).toHaveBeenCalledTimes(2);
    expect(session.sendAndWait.mock.calls[1][0].prompt).toContain(
      "Connection 1 requires a technical interaction label.",
    );
    expect(session.sendAndWait.mock.calls[1][0].prompt).toContain(
      "PREVIOUS INVALID RESPONSE",
    );
    expect(session.destroy).toHaveBeenCalledOnce();
  });

  it("forwards repair feedback to the configured Hosted Agent", async () => {
    vi.stubEnv(
      "PRESENTATION_AGENT_INVOCATIONS_ENDPOINT",
      "http://127.0.0.1:8088/invocations",
    );
    const invalidGraph = {
      ...GRAPH,
      connections: [{ ...GRAPH.connections[0], label: "" }],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: { content: JSON.stringify(invalidGraph) },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        result: { content: JSON.stringify(GRAPH) },
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await request(createApp()).post("/architecture").send({
      idea: "Build an agent that renders architecture in HTML.",
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const repairBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(repairBody.input.validationFeedback).toContain(
      "technical interaction label",
    );
    expect(repairBody.input.previousResponse).toContain('"label":""');
  });

  it("returns 500 when Copilot remains invalid after one repair", async () => {
    const session = createSession("not json", "still not json");
    (getClient as Mock).mockResolvedValue({
      createSession: vi.fn().mockResolvedValue(session),
    });

    const response = await request(createApp()).post("/architecture").send({
      idea: "Build an agent that renders architecture in HTML.",
    });

    expect(response.status).toBe(500);
    expect(response.body.error).toContain("remained invalid after one repair");
    expect(response.body).not.toHaveProperty("architecture");
    expect(session.sendAndWait).toHaveBeenCalledTimes(2);
    expect(session.destroy).toHaveBeenCalledOnce();
  });
});
