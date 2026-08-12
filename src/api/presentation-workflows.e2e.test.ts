import { rm } from "node:fs/promises";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import architectureRoutes from "./routes/architecture.js";
import {
  projectDirectory,
  storeProjectJsonAsset,
  type ProjectManifest,
} from "./routes/project-store.js";
import projectRoutes from "./routes/projects.js";
import slideRoutes from "./routes/slides.js";
import type { RepositoryEvidence } from "./routes/repository.js";

vi.mock("./architecture-visual.js", () => ({
  generateArchitectureImage: vi.fn().mockResolvedValue(
    new Uint8Array(Buffer.from("generated-design-graph")),
  ),
  isArchitectureImageConfigured: vi.fn(() => true),
}));

const GRAPH = {
  title: "Presentation Agent",
  summary: "A simple workflow from idea to approved presentation assets.",
  layers: [
    {
      id: "experience",
      label: "Experience",
      purpose: "Captures input and displays generated assets.",
      tone: "navy",
      nodes: [
        {
          id: "user",
          label: "User",
          description: "Provides and approves the presentation story.",
          kind: "actor",
          technology: "Browser",
          provenance: "confirmed",
          evidencePaths: [],
        },
        {
          id: "web-ui",
          label: "Web UI",
          description: "Guides approvals and displays architecture.",
          kind: "interface",
          technology: "React",
          provenance: "confirmed",
          evidencePaths: ["src/web/App.tsx"],
        },
      ],
    },
    {
      id: "orchestration",
      label: "Orchestration",
      purpose: "Coordinates generation and project state.",
      tone: "blue",
      nodes: [
        {
          id: "api",
          label: "Presentation API",
          description: "Coordinates projects and generated assets.",
          kind: "service",
          technology: "Express",
          provenance: "confirmed",
          evidencePaths: ["src/api/index.ts"],
        },
        {
          id: "foundry-agent",
          label: "Foundry Agent",
          description: "Generates grounded story and presentation models.",
          kind: "agent",
          technology: "Microsoft Foundry",
          provenance: "confirmed",
          evidencePaths: ["src/hosted-agent/index.ts"],
        },
      ],
    },
    {
      id: "assets",
      label: "Assets and integrations",
      purpose: "Supplies evidence and stores generated outputs.",
      tone: "teal",
      nodes: [
        {
          id: "asset-store",
          label: "Asset Store",
          description: "Versions approved story and presentation assets.",
          kind: "data",
          technology: "Durable storage",
          provenance: "confirmed",
          evidencePaths: ["src/api/routes/project-store.ts"],
        },
        {
          id: "github",
          label: "GitHub",
          description: "Provides optional repository evidence.",
          kind: "integration",
          technology: "GitHub API",
          provenance: "confirmed",
          evidencePaths: ["src/api/routes/repository.ts"],
        },
      ],
    },
  ],
  platforms: [
    {
      id: "container-apps",
      label: "Azure Container Apps",
      description: "Hosts the presentation web and API services.",
      technology: "Azure Container Apps",
      componentNodeIds: ["web-ui", "api"],
      provenance: "confirmed",
    },
    {
      id: "foundry-platform",
      label: "Microsoft Foundry",
      description: "Hosts the presentation agent.",
      technology: "Microsoft Foundry",
      componentNodeIds: ["foundry-agent"],
      provenance: "confirmed",
    },
    {
      id: "data-integrations",
      label: "Project Data and Integrations",
      description: "Provides storage and repository evidence.",
      technology: "Durable storage and GitHub API",
      componentNodeIds: ["asset-store", "github"],
      provenance: "confirmed",
    },
  ],
  workflow: {
    actor: "Presenter",
    goal: "Create an approved presentation from an idea or repository",
    steps: [
      {
        id: "submit-brief",
        order: 1,
        label: "Submit brief",
        userAction: "Provide the idea and optional repository.",
        platformCalls: [{
          nodeId: "web-ui",
          action: "capture project brief",
          mechanism: "React form",
          output: "presentation brief",
        }],
      },
      {
        id: "approve-story",
        order: 2,
        label: "Approve story",
        userAction: "Review and approve the generated story.",
        platformCalls: [{
          nodeId: "api",
          action: "persist approvals",
          mechanism: "HTTPS JSON",
          output: "approved story asset",
        }],
      },
      {
        id: "generate-architecture",
        order: 3,
        label: "Generate architecture",
        userAction: "Request grounded architecture options.",
        platformCalls: [{
          nodeId: "foundry-agent",
          action: "generate validated architecture",
          mechanism: "Foundry invocation",
          output: "architecture JSON",
        }],
      },
      {
        id: "create-slides",
        order: 4,
        label: "Create slides",
        userAction: "Generate the final presentation deck.",
        platformCalls: [{
          nodeId: "asset-store",
          action: "store generated deck",
          mechanism: "project asset write",
          output: "versioned slide assets",
        }],
      },
    ],
  },
  connections: [
    {
      from: "user",
      to: "web-ui",
      label: "describe and approve story",
      type: "request",
      mechanism: "browser interaction",
      payload: "idea and approvals",
      provenance: "confirmed",
      primary: true,
      evidencePaths: [],
    },
    {
      from: "web-ui",
      to: "api",
      label: "request presentation generation",
      type: "request",
      mechanism: "HTTPS JSON",
      payload: "brief and approved story",
      provenance: "confirmed",
      primary: true,
      evidencePaths: ["src/web/App.tsx", "src/api/index.ts"],
    },
    {
      from: "api",
      to: "foundry-agent",
      label: "generate architecture and slides",
      type: "request",
      mechanism: "Foundry invocations",
      payload: "grounded generation context",
      provenance: "confirmed",
      primary: true,
      evidencePaths: ["src/hosted-agent/index.ts"],
    },
    {
      from: "api",
      to: "asset-store",
      label: "store approved assets",
      type: "data",
      mechanism: "project asset write",
      payload: "story, graph, and deck",
      provenance: "confirmed",
      primary: true,
      evidencePaths: ["src/api/routes/project-store.ts"],
    },
    {
      from: "api",
      to: "github",
      label: "read repository evidence",
      type: "data",
      mechanism: "GitHub REST API",
      payload: "bounded source excerpts",
      provenance: "confirmed",
      primary: false,
      evidencePaths: ["src/api/routes/repository.ts"],
    },
  ],
  assumptions: [],
};

const DECK = {
  title: "Presentation Agent",
  subtitle: "From idea or codebase to an approved presentation.",
  theme: "azure",
  slides: [
    {
      id: "title",
      kind: "title",
      eyebrow: "Presentation Agent",
      title: "Tell the technical story faster",
      subtitle: "Automate post-PoC presentation work.",
      bullets: [],
    },
    {
      id: "problem",
      kind: "problem",
      eyebrow: "Problem",
      title: "Demo preparation is too manual",
      subtitle: "",
      bullets: ["Teams repeatedly recreate the same technical story."],
    },
    {
      id: "user-story",
      kind: "user-story",
      eyebrow: "User story",
      title: "Create reviewable assets from one brief",
      subtitle: "",
      bullets: ["Users approve the story before generation."],
    },
    {
      id: "architecture",
      kind: "architecture",
      eyebrow: "Architecture",
      title: "A simple grounded generation workflow",
      subtitle: "",
      bullets: [],
    },
  ],
};

const createdProjects: string[] = [];

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(projectRoutes);
  app.use(architectureRoutes);
  app.use(slideRoutes);
  return app;
}

function hostedFetch(graph: typeof GRAPH) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const invocation = JSON.parse(String(init?.body)) as {
      operation: "architecture" | "architecture-html" | "slides";
    };
    const content = invocation.operation === "architecture"
      ? JSON.stringify(graph)
      : invocation.operation === "architecture-html"
        ? `<!doctype html><html><head><style>body{margin:0}.system{display:grid}</style></head><body>
<main class="system" data-architecture-flow>
<section data-component="user">User</section>
<div data-connector data-from="user" data-to="web"><span class="connector-label">HTTPS</span><span class="connector-arrow"></span></div>
<section data-component="web">Web UI</section>
<div data-connector data-from="web" data-to="api"><span class="connector-label">request</span><span class="connector-arrow"></span></div>
<section data-component="api">API</section>
<div data-connector data-from="api" data-to="agent"><span class="connector-label">invoke</span><span class="connector-arrow"></span></div>
<section data-component="agent">Foundry Agent</section>
<div data-connector data-from="agent" data-to="store"><span class="connector-label">write</span><span class="connector-arrow"></span></div>
<section data-component="store">Asset Store</section>
</main></body></html>`
        : JSON.stringify(DECK);
    return new Response(JSON.stringify({ result: { content } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

async function createProject(
  app: ReturnType<typeof createApp>,
  repositoryUrl?: string,
): Promise<ProjectManifest> {
  const response = await request(app).post("/projects").send({
    title: "Presentation Agent",
    idea: "Turn a product idea into an approved technical presentation.",
    audience: "Engineering leaders",
    purpose: "Explain the solution and secure approval",
    repositoryUrl,
  });
  expect(response.status).toBe(201);
  createdProjects.push(response.body.project.id);
  return response.body.project as ProjectManifest;
}

async function approveStory(
  app: ReturnType<typeof createApp>,
  projectId: string,
  context: string,
) {
  const response = await request(app)
    .put(`/projects/${projectId}/story`)
    .send({
      context,
      approvedSections: ["problem", "userStory", "architecture"],
    });
  expect(response.status).toBe(200);
}

async function generatePresentation(
  app: ReturnType<typeof createApp>,
  projectId: string,
) {
  const architecture = await request(app).post("/architecture").send({
    projectId,
    idea: "Turn a product idea into an approved technical presentation.",
    audience: "Engineering leaders",
    purpose: "Explain the solution and secure approval",
    context: "All three story sections are approved.",
  });
  expect(architecture.status).toBe(200);
  const slides = await request(app).post("/slides").send({ projectId });
  expect(slides.status).toBe(201);
  expect(slides.body.deck.slides).toHaveLength(4);
  expect(slides.body.deck.slides.some(
    (slide: { kind: string }) => slide.kind === "architecture",
  )).toBe(true);
  return architecture.body.architecture as typeof GRAPH;
}

describe("presentation workflows end to end", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv(
      "PRESENTATION_AGENT_INVOCATIONS_ENDPOINT",
      "http://127.0.0.1:8088/invocations",
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await Promise.all(createdProjects.splice(0).map(projectId =>
      rm(projectDirectory(projectId), { recursive: true, force: true })));
  });

  it("generates slides from repository evidence", async () => {
    const app = createApp();
    const project = await createProject(
      app,
      "https://github.com/example/presentation-agent",
    );
    const evidence: RepositoryEvidence = {
      schemaVersion: 1,
      repository: {
        owner: "example",
        name: "presentation-agent",
        url: "https://github.com/example/presentation-agent",
        defaultBranch: "main",
        requestedRef: "main",
        commitSha: "abc123",
        private: false,
        archived: false,
      },
      scan: {
        scannedAt: "2026-08-11T00:00:00.000Z",
        treePathCount: 3,
        selectedFileCount: 3,
        extractedBytes: 300,
        truncated: false,
        limits: {
          maximumTreePaths: 5_000,
          maximumSelectedFiles: 60,
          maximumFileBytes: 80_000,
          maximumTotalBytes: 1_500_000,
        },
      },
      technologies: ["React", "Express", "Microsoft Foundry"],
      componentHints: [
        { label: "Web application", evidencePaths: ["src/web/App.tsx"] },
        { label: "API service", evidencePaths: ["src/api/index.ts"] },
      ],
      files: [
        {
          path: "src/web/App.tsx",
          sha: "web",
          size: 100,
          contentHash: "web-hash",
          excerpt: "React presentation workflow UI.",
        },
        {
          path: "src/api/index.ts",
          sha: "api",
          size: 100,
          contentHash: "api-hash",
          excerpt: "Express presentation API.",
        },
        {
          path: "src/hosted-agent/index.ts",
          sha: "agent",
          size: 100,
          contentHash: "agent-hash",
          excerpt: "Foundry Hosted Agent invocations adapter.",
        },
      ],
      warnings: [],
    };
    await storeProjectJsonAsset(
      project.id,
      "repository-evidence",
      evidence,
      [project.currentAssets.brief!],
    );
    await approveStory(
      app,
      project.id,
      "Problem Statement, User Story, and Architecture are grounded in the repository.",
    );
    const fetchMock = hostedFetch(GRAPH);
    vi.stubGlobal("fetch", fetchMock);

    const architecture = await generatePresentation(app, project.id);

    expect(architecture.layers.flatMap(layer => layer.nodes).some(
      node => node.evidencePaths.length > 0,
    )).toBe(true);
    const architectureInvocation = JSON.parse(
      String(fetchMock.mock.calls[0][1]?.body),
    );
    expect(architectureInvocation.input.repositoryEvidence).toContain(
      "src/web/App.tsx",
    );
  });

  it("generates slides from three manually described story sections", async () => {
    const app = createApp();
    const project = await createProject(app);
    await approveStory(
      app,
      project.id,
      [
        "Problem Statement: Teams spend too long preparing post-PoC demos.",
        "User Story: As a product team, we approve a story before generation.",
        "Architecture: A Web UI calls an API and Foundry Agent, then stores assets.",
      ].join("\n"),
    );
    const manualGraph = {
      ...GRAPH,
      layers: GRAPH.layers.map(layer => ({
        ...layer,
        nodes: layer.nodes
          .filter(node => node.id !== "github")
          .map(node => ({ ...node, evidencePaths: [] })),
      })),
      platforms: GRAPH.platforms.map(platform => ({
        ...platform,
        componentNodeIds: platform.componentNodeIds.filter(nodeId => nodeId !== "github"),
      })),
      connections: GRAPH.connections
        .filter(connection => connection.to !== "github")
        .map(connection => ({ ...connection, evidencePaths: [] })),
    };
    const fetchMock = hostedFetch(manualGraph);
    vi.stubGlobal("fetch", fetchMock);

    const architecture = await generatePresentation(app, project.id);

    expect(architecture.layers.flatMap(layer => layer.nodes).every(
      node => node.evidencePaths.length === 0,
    )).toBe(true);
    const architectureInvocation = JSON.parse(
      String(fetchMock.mock.calls[0][1]?.body),
    );
    expect(architectureInvocation.input.repositoryEvidence).toBeUndefined();
    expect(JSON.stringify(architectureInvocation)).not.toContain("package.json");
  });
});
