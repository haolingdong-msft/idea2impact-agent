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

function structuredStreaming(content: string, emitIdle = true) {
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
      handlers["assistant.message"]?.forEach(callback =>
        callback({ data: { content } }));
      if (emitIdle) {
        handlers["session.idle"]?.forEach(callback => callback({}));
      }
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
    expect(session.send).toHaveBeenCalledWith({
      prompt: expect.stringContaining("NO REPOSITORY EVIDENCE WAS PROVIDED"),
    });
    expect(session.destroy).toHaveBeenCalledOnce();
  });

  it("uses repository evidence only for the presentation workflow", async () => {
    const session = streaming(["Problem statement summary"]);
    (getClient as Mock).mockResolvedValue({
      createSession: vi.fn().mockResolvedValue(session),
    });
    const response = await request(app).post("/invocations").send({
      version: "1.0",
      operation: "chat",
      requestId: "request-repository-story",
      input: {
        message: "Build a presentation agent.",
        history: [],
        repositoryEvidence: JSON.stringify({
          files: [{ path: "README.md", excerpt: "Presentation agent" }],
        }),
      },
    });
    expect(response.status).toBe(200);
    const prompt = session.send.mock.calls[0][0].prompt;
    expect(prompt).toContain("REPOSITORY PRESENTATION MODE");
    expect(prompt).toContain(
      "Do not ask what task to perform on the repository",
    );
    expect(prompt).toContain("Problem Statement, User Scenarios, or Solution");
  });

  it("does not restart approvals for post-generation refinement", async () => {
    const session = streaming(["Revised architecture"]);
    (getClient as Mock).mockResolvedValue({
      createSession: vi.fn().mockResolvedValue(session),
    });
    const response = await request(app).post("/invocations").send({
      version: "1.0",
      operation: "chat",
      input: {
        message: "Highlight the Foundry Agent in the architecture.",
        history: [],
        workflowMode: "refinement",
      },
    });
    expect(response.status).toBe(200);
    const prompt = session.send.mock.calls[0][0].prompt;
    expect(prompt).toContain("POST-GENERATION REFINEMENT MODE");
    expect(prompt).toContain("Do not restart the outline workflow");
    expect(prompt).toContain("or ask for approval");
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
    const prompt = session.sendAndWait.mock.calls[0][0].prompt;
    expect(prompt).toContain('"platforms"');
    expect(prompt).toContain('"toolings"');
    expect(prompt).toContain('"platformCalls"');
    expect(prompt).toContain('"toolingId"');
    expect(session.destroy).toHaveBeenCalledOnce();
  });

  it("returns a structured combined outline", async () => {
    const session = oneShot(JSON.stringify({
      problemStatement: "Teams lose presentation context.",
      userScenarios: "Presenters refine one shared outline.",
      solution: "Copilot generates grounded presentation assets.",
    }));
    (getClient as Mock).mockResolvedValue({
      createSession: vi.fn().mockResolvedValue(session),
    });
    const response = await request(app).post("/invocations").send({
      version: "1.0",
      operation: "outline",
      input: {
        brief: { idea: "Build a presentation agent." },
        currentOutline: {},
        conversation: "user: Build a presentation agent.",
      },
    });
    expect(response.status).toBe(200);
    expect(response.body.operation).toBe("outline");
    const prompt = session.sendAndWait.mock.calls[0][0].prompt;
    expect(prompt).toContain("problemStatement");
    expect(prompt).toContain("CURRENT OUTLINE");
    expect(prompt).toContain("automatically summarize the codebase");
    expect(prompt).toContain("repository evidence is absent");
    expect(prompt).toContain("complete initial version");
    expect(prompt).not.toContain("approve each");
  });

  it("returns slide-grounded speech script content", async () => {
    const session = oneShot(JSON.stringify({
      title: "Speaker notes",
      notes: [],
    }));
    (getClient as Mock).mockResolvedValue({
      createSession: vi.fn().mockResolvedValue(session),
    });
    const response = await request(app).post("/invocations").send({
      version: "1.0",
      operation: "speech-script",
      input: {
        outline: { status: "approved" },
        deck: { slides: [] },
      },
    });
    expect(response.status).toBe(200);
    const prompt = session.sendAndWait.mock.calls[0][0].prompt;
    expect(prompt).toContain("speaker notes");
    expect(prompt).toContain("APPROVED OUTLINE");
    expect(prompt).toContain("SLIDE DECK");
  });

  it("returns structured content without waiting for session idle", async () => {
    const session = structuredStreaming('{"title":"Architecture"}', false);
    (getClient as Mock).mockResolvedValue({
      createSession: vi.fn().mockResolvedValue(session),
    });

    const response = await request(app).post("/invocations").send({
      version: "1.0",
      operation: "architecture",
      input: { idea: "Build a technical presentation creation agent." },
    });

    expect(response.status).toBe(200);
    expect(response.body.result.content).toContain("Architecture");
    expect(session.send).toHaveBeenCalledOnce();
    expect(session.destroy).toHaveBeenCalledOnce();
  });

  it("creates a concise prose architecture brief for image generation", async () => {
    const session = oneShot("Web UI sends HTTPS requests to the Presentation API.");
    (getClient as Mock).mockResolvedValue({
      createSession: vi.fn().mockResolvedValue(session),
    });
    const response = await request(app).post("/invocations").send({
      version: "1.0",
      operation: "architecture-brief",
      input: {
        idea: "Build a presentation agent from a user idea and repository.",
        repositoryEvidence: "README: Web UI calls an API.",
      },
    });
    expect(response.status).toBe(200);
    const prompt = session.sendAndWait.mock.calls[0][0].prompt;
    expect(prompt).toContain("natural-language architecture narrative");
    expect(prompt).toContain("UNTRUSTED REPOSITORY EVIDENCE");
    expect(prompt).toContain("Do not return JSON");
  });

  it("asks creative HTML architecture to avoid connector overlap", async () => {
    const session = oneShot("<!doctype html><html></html>");
    (getClient as Mock).mockResolvedValue({
      createSession: vi.fn().mockResolvedValue(session),
    });
    const response = await request(app).post("/invocations").send({
      version: "1.0",
      operation: "architecture-html",
      input: {
        idea: "Build a technical presentation creation agent.",
        context: "Approved",
      },
    });
    expect(response.status).toBe(200);
    const prompt = session.sendAndWait.mock.calls[0][0].prompt;
    expect(prompt).toContain("whitespace corridors");
    expect(prompt).toContain("No arrow or connector label may cross a card");
    expect(prompt).toContain("4-7 essential connectors");
    expect(prompt).toContain("two-dimensional CSS Grid composition");
    expect(prompt).toContain("at least 14px");
    expect(prompt).toContain("80-90% of the available 16:9 canvas");
    expect(prompt).toContain("data-connector");
    expect(prompt).toContain("Never use SVG");
    expect(prompt).toContain("dedicated CSS Grid/Flex cell");
  });

  it("passes the GPT-Image-2 reference directly to Copilot", async () => {
    const session = oneShot("<!doctype html><html></html>");
    (getClient as Mock).mockResolvedValue({
      createSession: vi.fn().mockResolvedValue(session),
    });
    const response = await request(app).post("/invocations").send({
      version: "1.0",
      operation: "architecture-image-html",
      input: {
        idea: "Build a technical presentation creation agent.",
        context: "Validated architecture JSON",
        imageMediaType: "image/png",
        imageBase64: Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]).toString("base64"),
      },
    });

    expect(response.status).toBe(200);
    const message = session.sendAndWait.mock.calls[0][0];
    expect(message.prompt).toContain("visual source of truth");
    expect(message.prompt).toContain("reconstruction of that exact design");
    expect(message.attachments).toEqual([
      expect.objectContaining({
        type: "file",
        displayName: "GPT-Image-2 architecture reference.png",
      }),
    ]);
  });

  it("includes connector validator feedback in HTML repair prompts", async () => {
    const session = oneShot("<!doctype html><html></html>");
    (getClient as Mock).mockResolvedValue({
      createSession: vi.fn().mockResolvedValue(session),
    });
    const response = await request(app).post("/invocations").send({
      version: "1.0",
      operation: "architecture-html",
      input: {
        idea: "Build a technical presentation creation agent.",
        context: "Approved",
        validationFeedback: "Architecture HTML connectors must not use SVG.",
        previousResponse: "<!doctype html><html><svg></svg></html>",
      },
    });
    expect(response.status).toBe(200);
    const prompt = session.sendAndWait.mock.calls[0][0].prompt;
    expect(prompt).toContain("failed connector validation");
    expect(prompt).toContain("connectors must not use SVG");
    expect(prompt).toContain("PREVIOUS INVALID HTML");
  });

  it("adds bounded validator feedback for architecture repair", async () => {
    const session = oneShot('{"title":"Repaired architecture"}');
    (getClient as Mock).mockResolvedValue({
      createSession: vi.fn().mockResolvedValue(session),
    });
    const response = await request(app).post("/invocations").send({
      version: "1.0",
      operation: "architecture",
      requestId: "request-repair",
      input: {
        idea: "Build a technical presentation creation agent.",
        validationFeedback: "Connection 12 requires a technical interaction label.",
        previousResponse: `{"connections":[{"label":""}]}${"x".repeat(70_000)}`,
      },
    });
    expect(response.status).toBe(200);
    const prompt = session.sendAndWait.mock.calls[0][0].prompt;
    expect(prompt).toContain(
      "Connection 12 requires a technical interaction label.",
    );
    expect(prompt).toContain("PREVIOUS INVALID RESPONSE");
    expect(prompt.length).toBeLessThan(65_000);
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
