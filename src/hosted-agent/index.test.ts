import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("./client.js", () => ({ getClient: vi.fn() }));
vi.mock("./model-config.js", () => ({
  getSessionOptions: vi.fn().mockResolvedValue({}),
  enhanceModelError: vi.fn((error: unknown) =>
    error instanceof Error ? error : new Error(String(error))),
}));

import { getClient } from "./client.js";
import { app } from "./index.js";

function oneShot(content: string) {
  return {
    sendAndWait: vi.fn().mockResolvedValue({ data: { content } }),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
}

function streaming(deltas: string[]) {
  const handlers: Record<string, ((event: unknown) => void)[]> = {};
  return {
    on: vi.fn((event: string, callback: (event: unknown) => void) => {
      handlers[event] ??= [];
      handlers[event].push(callback);
      return () => {
        handlers[event] = handlers[event].filter(item => item !== callback);
      };
    }),
    send: vi.fn(async () => {
      for (const delta of deltas) {
        handlers["assistant.message_delta"]?.forEach(callback =>
          callback({ data: { deltaContent: delta } }));
      }
      setTimeout(() =>
        handlers["session.idle"]?.forEach(callback => callback({})), 0);
    }),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
}

describe("Foundry invocations adapter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports health", async () => {
    const response = await request(app).get("/health");
    expect(response.status).toBe(200);
    expect(response.body.service).toBe("presentation-hosted-agent");
  });

  it("reports Foundry runtime readiness", async () => {
    const response = await request(app).get("/readiness");
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
  });

  it("rejects unsupported contract versions", async () => {
    const response = await request(app).post("/invocations").send({
      version: "2.0",
      operation: "chat",
      input: { message: "hello" },
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Unsupported invocation version");
  });

  it("streams chat deltas", async () => {
    const session = streaming(["Hello", " world"]);
    (getClient as Mock).mockResolvedValue({
      createSession: vi.fn().mockResolvedValue(session),
    });
    const response = await request(app).post("/invocations").send({
      version: "1.0",
      operation: "chat",
      requestId: "request-1",
      input: { message: "hello", history: [] },
    });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.text).toContain('data: {"content":"Hello"}');
    expect(response.text).toContain("data: [DONE]");
    expect(session.destroy).toHaveBeenCalledOnce();
  });

  it("returns structured architecture content", async () => {
    const session = oneShot('{"title":"Architecture"}');
    (getClient as Mock).mockResolvedValue({
      createSession: vi.fn().mockResolvedValue(session),
    });
    const response = await request(app).post("/invocations").send({
      version: "1.0",
      operation: "architecture",
      requestId: "request-2",
      input: {
        idea: "Build a technical presentation creation agent.",
        audience: "Engineers",
        purpose: "Explain the design",
        context: "Approved",
      },
    });
    expect(response.status).toBe(200);
    expect(response.body.operation).toBe("architecture");
    expect(response.body.result.content).toContain("Architecture");
    expect(session.destroy).toHaveBeenCalledOnce();
  });

  it("rejects incomplete slide generation inputs", async () => {
    const response = await request(
      express().use(express.json()).use(app),
    ).post("/invocations").send({
      version: "1.0",
      operation: "slides",
      input: { brief: {} },
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Slides require");
  });
});
