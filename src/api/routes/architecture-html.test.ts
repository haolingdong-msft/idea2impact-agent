import { rm } from "node:fs/promises";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("../model-config.js", () => ({
  getSessionOptions: vi.fn().mockResolvedValue({}),
  enhanceModelError: vi.fn((error: unknown) =>
    error instanceof Error ? error : new Error(String(error))),
}));
vi.mock("../architecture-visual.js", () => ({
  generateArchitectureImage: vi.fn().mockResolvedValue(
    new Uint8Array(Buffer.from("generated-design-graph")),
  ),
  isArchitectureImageConfigured: vi.fn(() => true),
}));

import architectureRoutes from "./architecture.js";
import { generateArchitectureImage } from "../architecture-visual.js";
import {
  createProject,
  getProject,
  projectDirectory,
  storeProjectJsonAsset,
} from "./project-store.js";

const GRAPH = {
  title: "Creative Architecture",
  summary: "Copilot directly designs the architecture visual.",
  layers: [
    { id: "experience", label: "Experience", purpose: "User access.", tone: "navy", nodes: [
      { id: "web", label: "Web UI", description: "Captures input.", kind: "interface", technology: "Web", provenance: "confirmed" },
    ] },
    { id: "agent", label: "Agent", purpose: "Generation.", tone: "blue", nodes: [
      { id: "foundry", label: "Foundry Agent", description: "Creates assets.", kind: "agent", technology: "Foundry", provenance: "confirmed" },
    ] },
  ],
  platforms: [
    {
      id: "web-platform",
      label: "Web Platform",
      description: "Hosts the browser experience.",
      technology: "Web runtime",
      componentNodeIds: ["web"],
      provenance: "confirmed",
    },
    {
      id: "foundry-platform",
      label: "Microsoft Foundry",
      description: "Hosts the generation agent.",
      technology: "Microsoft Foundry",
      componentNodeIds: ["foundry"],
      provenance: "confirmed",
    },
  ],
  workflow: {
    actor: "Presenter",
    goal: "Create an architecture design",
    steps: [
      {
        id: "enter-input",
        order: 1,
        label: "Enter input",
        userAction: "Provide the approved presentation context.",
        platformCalls: [{
          nodeId: "web",
          action: "capture input",
          mechanism: "browser form",
          output: "approved input",
        }],
      },
      {
        id: "create-assets",
        order: 2,
        label: "Create assets",
        userAction: "Generate architecture design options.",
        platformCalls: [{
          nodeId: "foundry",
          action: "generate assets",
          mechanism: "agent invocation",
          output: "architecture visuals",
        }],
      },
    ],
  },
  connections: [{
    from: "web", to: "foundry", label: "generate", type: "request",
    mechanism: "HTTPS", payload: "approved input", provenance: "confirmed", primary: true,
  }],
  assumptions: [],
};

const HTML = `<!doctype html><html><head><style>
body{margin:0;background:#eef4ff}.flow{display:grid}
.connector{border-top:2px solid #2563eb}
</style></head><body><h1>Creative architecture</h1><main class="flow" data-architecture-flow>
<section data-component="user">User</section>
<div class="connector" data-connector data-from="user" data-to="web"><span class="connector-label">HTTPS</span><span class="connector-arrow" aria-hidden="true"></span></div>
<section data-component="web">Web UI</section>
<div class="connector" data-connector data-from="web" data-to="api"><span class="connector-label">request</span><span class="connector-arrow" aria-hidden="true"></span></div>
<section data-component="api">API</section>
<div class="connector" data-connector data-from="api" data-to="agent"><span class="connector-label">invoke</span><span class="connector-arrow" aria-hidden="true"></span></div>
<section data-component="agent">Foundry Agent</section>
<div class="connector" data-connector data-from="agent" data-to="store"><span class="connector-label">write</span><span class="connector-arrow" aria-hidden="true"></span></div>
<section data-component="store">Asset Store</section>
</main></body></html>`;
const projectIds: string[] = [];

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use(architectureRoutes);
  return instance;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PRESENTATION_AGENT_INVOCATIONS_ENDPOINT", "http://127.0.0.1:8088/invocations");
  vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const operation = JSON.parse(String(init?.body)).operation;
    const content = operation === "architecture-html" ? HTML : JSON.stringify(GRAPH);
    return new Response(JSON.stringify({ result: { content } }), { status: 200 });
  }));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(projectIds.splice(0).map(id =>
    rm(projectDirectory(id), { recursive: true, force: true })));
});

describe("Copilot architecture HTML", () => {
  it("defers all five visual assets until slide generation is requested", async () => {
    const project = await createProject({
      title: "Deferred visuals",
      idea: "Analyze architecture before generating slide design options.",
      audience: "Leaders",
      purpose: "Compare visual treatments",
    });
    projectIds.push(project.id);
    await storeProjectJsonAsset(project.id, "story", {
      context: "Approved architecture.",
      approvedSections: ["problem", "userStory", "architecture"],
    });

    const response = await request(app()).post("/architecture").send({
      projectId: project.id,
      idea: project.brief.idea,
      generateVisuals: false,
    });

    expect(response.status).toBe(200);
    expect(response.body.visual).toEqual({ mode: "legacy" });
    expect(generateArchitectureImage).not.toHaveBeenCalled();
    const stored = await getProject(project.id);
    expect(stored?.currentAssets["architecture-html"]).toBeUndefined();
    expect(stored?.currentAssets["architecture-validated-json-html"]).toBeUndefined();
    expect(stored?.currentAssets["architecture-narrative-html"]).toBeUndefined();
    expect(stored?.currentAssets["architecture-image"]).toBeUndefined();
    expect(stored?.currentAssets["architecture-narrative-image"]).toBeUndefined();
  });

  it("stores and serves sandbox-compatible HTML", async () => {
    const project = await createProject({
      title: "Creative architecture",
      idea: "Generate a visually polished architecture from user input.",
      audience: "Leaders",
      purpose: "Explain the system",
    });
    projectIds.push(project.id);
    await storeProjectJsonAsset(project.id, "story", {
      context: "Approved architecture.",
      approvedSections: ["problem", "userStory", "architecture"],
    });

    const response = await request(app()).post("/architecture").send({
      projectId: project.id,
      idea: project.brief.idea,
      context: "Approved architecture.",
    });

    expect(response.status).toBe(200);
    expect(response.body.visual).toEqual({
      mode: "dual",
      htmlUrl: `/projects/${project.id}/architecture/html`,
      validatedJsonHtmlUrl:
        `/projects/${project.id}/architecture/validated-json-html`,
      narrativeHtmlUrl: `/projects/${project.id}/architecture/narrative-html`,
      imageUrl: `/projects/${project.id}/architecture/image`,
      narrativeImageUrl: `/projects/${project.id}/architecture/narrative-image`,
    });
    expect((await getProject(project.id))?.currentAssets["architecture-html"]).toBeTruthy();
    expect((await getProject(project.id))?.currentAssets["architecture-validated-json-html"])
      .toBeTruthy();
    expect((await getProject(project.id))?.currentAssets["architecture-narrative-html"]).toBeTruthy();
    expect((await getProject(project.id))?.currentAssets["architecture-image"]).toBeTruthy();
    expect((await getProject(project.id))?.currentAssets["architecture-narrative-image"]).toBeTruthy();
    const designBrief = (generateArchitectureImage as Mock).mock.calls[0][0] as string;
    expect(designBrief).toContain("VALIDATED ARCHITECTURE SUMMARY");
    expect(designBrief).toContain("Creative Architecture");
    expect(designBrief).not.toContain("Approved Problem Statement");
    expect(designBrief).not.toContain("CODEBASE EVIDENCE");
    expect(designBrief.length).toBeLessThan(8_000);
    expect((generateArchitectureImage as Mock).mock.calls[1][1]).toBe("agent-summary");

    const html = await request(app()).get(`/projects/${project.id}/architecture/html`);
    expect(html.status).toBe(200);
    expect(html.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(html.text).toContain("Creative architecture");
    const image = await request(app()).get(`/projects/${project.id}/architecture/image`);
    expect(image.status).toBe(200);
    expect(image.headers["content-type"]).toContain("image/png");
    const narrativeImage = await request(app())
      .get(`/projects/${project.id}/architecture/narrative-image`);
    expect(narrativeImage.status).toBe(200);
    const narrativeHtml = await request(app())
      .get(`/projects/${project.id}/architecture/narrative-html`);
    expect(narrativeHtml.status).toBe(200);
    const validatedJsonHtml = await request(app())
      .get(`/projects/${project.id}/architecture/validated-json-html`);
    expect(validatedJsonHtml.status).toBe(200);
    const htmlPrompts = (fetch as ReturnType<typeof vi.fn>).mock.calls
      .map(([, init]) => JSON.parse(String((init as RequestInit | undefined)?.body)))
      .filter(invocation => invocation.operation === "architecture-html")
      .map(invocation => invocation.input?.context);
    expect(htmlPrompts).toContainEqual(expect.stringContaining("VALIDATED ARCHITECTURE JSON"));
  });

  it("removes executable HTML", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const operation = JSON.parse(String(init?.body)).operation;
        const content = operation === "architecture-html"
          ? HTML.replace("<main", "<script>alert(1)</script><main onload=\"alert(1)\"")
          : JSON.stringify(GRAPH);
        return new Response(JSON.stringify({ result: { content } }), { status: 200 });
      },
    );
    const project = await createProject({
      title: "Unsafe architecture",
      idea: "Generate a polished architecture from approved input.",
      audience: "",
      purpose: "",
    });
    projectIds.push(project.id);
    await storeProjectJsonAsset(project.id, "story", {
      approvedSections: ["problem", "userStory", "architecture"],
    });

    const response = await request(app()).post("/architecture").send({
      projectId: project.id,
      idea: project.brief.idea,
    });
    expect(response.status).toBe(200);
    const html = await request(app()).get(response.body.visual.htmlUrl);
    expect(html.text).toContain("Creative architecture");
    expect(html.text).not.toContain("<script");
    expect(html.text).not.toContain("onload");
    expect(html.text).toContain('id="architecture-layout-guard"');
  });

  it("repairs detached overlay connectors before storing HTML", async () => {
    let htmlAttempts = 0;
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const invocation = JSON.parse(String(init?.body));
        if (invocation.operation !== "architecture-html") {
          return new Response(JSON.stringify({ result: { content: JSON.stringify(GRAPH) } }), { status: 200 });
        }
        htmlAttempts += 1;
        const content = htmlAttempts === 1
          ? HTML
              .replace('data-from="agent" data-to="store"', 'data-from="api" data-to="store"')
              .replace(".connector{", ".connector{position:absolute;")
          : HTML;
        return new Response(JSON.stringify({ result: { content } }), { status: 200 });
      },
    );
    const project = await createProject({
      title: "Repair connectors",
      idea: "Generate architecture with correctly anchored component arrows.",
      audience: "Engineers",
      purpose: "Explain runtime flow",
    });
    projectIds.push(project.id);
    await storeProjectJsonAsset(project.id, "story", {
      approvedSections: ["problem", "userStory", "architecture"],
    });

    const response = await request(app()).post("/architecture").send({
      projectId: project.id,
      idea: project.brief.idea,
    });

    expect(response.status).toBe(200);
    expect(htmlAttempts).toBe(4);
    const html = await request(app()).get(response.body.visual.htmlUrl);
    expect(html.text).toContain("data-connector");
    expect(html.text).not.toContain("<svg");
    expect(html.text).not.toContain("position:absolute");
    expect(html.text).toContain("font-size:14px!important");
  });
});
