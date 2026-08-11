import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  invokeHostedAgent,
  invokeHostedStructured,
  isHostedAgentConfigured,
} from "./hosted-agent-client.js";

describe("Hosted Agent client", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("reports whether an endpoint is configured", () => {
    vi.stubEnv("PRESENTATION_AGENT_INVOCATIONS_ENDPOINT", "");
    expect(isHostedAgentConfigured()).toBe(false);
    vi.stubEnv(
      "PRESENTATION_AGENT_INVOCATIONS_ENDPOINT",
      "http://127.0.0.1:8088/invocations",
    );
    expect(isHostedAgentConfigured()).toBe(true);
  });

  it("invokes a local agent without an authorization header", async () => {
    vi.stubEnv(
      "PRESENTATION_AGENT_INVOCATIONS_ENDPOINT",
      "http://127.0.0.1:8088/invocations",
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: { content: "{}" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await invokeHostedAgent("architecture", { idea: "A valid idea" }, "request-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8088/invocations",
      expect.objectContaining({
        method: "POST",
        headers: expect.not.objectContaining({ Authorization: expect.anything() }),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.version).toBe("1.0");
    expect(body.operation).toBe("architecture");
  });

  it("extracts structured content", async () => {
    vi.stubEnv(
      "PRESENTATION_AGENT_INVOCATIONS_ENDPOINT",
      "http://localhost:8088/invocations",
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        result: { content: '{"title":"Architecture"}' },
      }), { status: 200 }),
    ));
    await expect(
      invokeHostedStructured("architecture", { idea: "A valid technical idea" }),
    ).resolves.toContain("Architecture");
  });

  it("surfaces a bounded upstream error", async () => {
    vi.stubEnv(
      "PRESENTATION_AGENT_INVOCATIONS_ENDPOINT",
      "http://localhost:8088/invocations",
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("upstream failed", { status: 502 }),
    ));
    await expect(
      invokeHostedStructured("slides", { brief: {}, story: {}, architecture: {} }),
    ).rejects.toThrow("Hosted Agent slides invocation failed (502)");
  });
});
