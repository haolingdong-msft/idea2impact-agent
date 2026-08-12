import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: class {
    async getToken() {
      return { token: "test-token" };
    }
  },
  ManagedIdentityCredential: class {
    async getToken() {
      return { token: "test-token" };
    }
  },
}));

import {
  generateArchitectureImage,
  parseArchitectureImage,
  validateArchitectureVisualLayout,
} from "./architecture-visual.js";

describe("architecture visual models", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.stubEnv("ARCHITECTURE_MODEL_ENDPOINT", "https://models.example.test");
    vi.stubEnv("ARCHITECTURE_IMAGE_DEPLOYMENT", "image-model");
    vi.stubEnv("ARCHITECTURE_VISION_DEPLOYMENT", "vision-model");
  });

  it("generates an image and parses layout JSON", async () => {
    const image = Buffer.from("png-image");
    const parsed = { architecture: { title: "Test" }, layout: { width: 1600 } };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ b64_json: image.toString("base64") }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(parsed) } }],
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const generated = await generateArchitectureImage("approved evidence");
    const result = await parseArchitectureImage(generated, "approved evidence");

    expect(Buffer.from(generated).toString()).toBe("png-image");
    expect(result).toEqual(parsed);
    expect(fetchMock.mock.calls[0][0]).toContain("images/generations");
    expect(fetchMock.mock.calls[1][0]).toContain("chat/completions");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer test-token");
  });

  it("surfaces the managed identity role required for 403 responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("permission denied", { status: 403 }),
    ));

    await expect(generateArchitectureImage("approved evidence")).rejects.toThrow(
      "Cognitive Services OpenAI User",
    );
  });

  it("keeps image prompts below the model character limit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        data: [{ b64_json: Buffer.from("png-image").toString("base64") }],
      }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await generateArchitectureImage("evidence ".repeat(10_000));

    const request = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(request.prompt.length).toBeLessThanOrEqual(12_000);
    expect(request.prompt).toContain("VALIDATED ARCHITECTURE SUMMARY");
    expect(request.prompt).toContain("art-directed executive software architecture");
    expect(request.prompt).toContain("single horizontal row of all components is forbidden");
    expect(request.prompt).toContain("never truncate labels");
    expect(request.prompt).toContain("80-90% of the usable canvas");
  });

  it("validates bounded layout nodes and matching connections", () => {
    const layout = validateArchitectureVisualLayout({
      width: 1600,
      height: 900,
      nodes: [
        { id: "web", x: 100, y: 100, width: 280, height: 140 },
        { id: "agent", x: 700, y: 100, width: 280, height: 140 },
      ],
      connections: [{
        from: "web",
        to: "agent",
        points: [{ x: 380, y: 170 }, { x: 700, y: 170 }],
        labelX: 540,
        labelY: 145,
      }],
    }, new Set(["web", "agent"]), new Set(["web->agent"]));

    expect(layout.nodes).toHaveLength(2);
    expect(layout.connections[0].points).toHaveLength(2);
    expect(() => validateArchitectureVisualLayout({
      ...layout,
      nodes: [
        { ...layout.nodes[0], x: 1500 },
        layout.nodes[1],
      ],
    }, new Set(["web", "agent"]), new Set(["web->agent"]))).toThrow(
      "outside the architecture canvas",
    );
  });
});
