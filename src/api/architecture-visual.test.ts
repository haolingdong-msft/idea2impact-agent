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
  architectureImageConfiguration,
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
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).size).toBe("1536x1024");
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

  it("retries transient DeploymentNotFound responses", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          error: { code: "DeploymentNotFound", message: "Try again." },
        }), { status: 404 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          data: [{ b64_json: Buffer.from("png-image").toString("base64") }],
        }), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const generation = generateArchitectureImage("approved evidence");
      await vi.advanceTimersByTimeAsync(750);

      expect(Buffer.from(await generation).toString()).toBe("png-image");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors image-model rate-limit retry guidance", async () => {
    vi.useFakeTimers();
    try {
      const onRetry = vi.fn();
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          error: { code: "RateLimitReached", message: "Please retry after 60 seconds." },
        }), { status: 429, headers: { "retry-after": "60" } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          data: [{ b64_json: Buffer.from("png-image").toString("base64") }],
        }), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const generation = generateArchitectureImage(
        "approved evidence",
        "validated-architecture",
        onRetry,
      );
      await vi.advanceTimersByTimeAsync(60_000);

      expect(Buffer.from(await generation).toString()).toBe("png-image");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(onRetry).toHaveBeenCalledWith({
        attempt: 2,
        delaySeconds: 60,
        status: 429,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a native 16:9 canvas for GPT-Image-2", async () => {
    vi.stubEnv("ARCHITECTURE_IMAGE_DEPLOYMENT", "gpt-image-2");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        data: [{ b64_json: Buffer.from("png-image").toString("base64") }],
      }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await generateArchitectureImage("approved evidence");

    const request = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(request.size).toBe("1536x864");
    expect(architectureImageConfiguration()).toEqual({
      deployment: "gpt-image-2",
      width: 1536,
      height: 864,
    });
    expect(request.quality).toBe("high");
    expect(request.output_format).toBe("png");
  });

  it("supports an unpersisted API key for local model development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ARCHITECTURE_MODEL_API_KEY", "local-test-key");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        data: [{ b64_json: Buffer.from("png-image").toString("base64") }],
      }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await generateArchitectureImage("approved evidence");

    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      "api-key": "local-test-key",
      "Content-Type": "application/json",
    });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
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
    expect(request.prompt).toContain("VALIDATED PROJECT OVERVIEW SUMMARY");
    expect(request.prompt).toContain(
      "Choose the composition yourself while keeping the architecture and workflow easy to scan",
    );
    expect(request.prompt).toContain(
      "short thin orthogonal lines with small arrowheads",
    );
    expect(request.prompt).toContain(
      "no more than about 20% of the canvas width or height",
    );
    expect(request.prompt).toContain(
      "Connect only adjacent workflow steps with short thin arrows",
    );
    expect(request.prompt).toContain(
      "Never connect workflow steps to architecture components",
    );
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
      "outside the project overview canvas",
    );
  });
});
