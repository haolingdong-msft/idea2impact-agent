import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import healthRoutes from "./routes/health.js";

function createApp() {
  const app = express();
  app.use(healthRoutes);
  return app;
}

describe("GET /health", () => {
  it("returns status ok", async () => {
    const res = await request(createApp()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("GET /config", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the fixed GitHub model when no env vars are set", async () => {
    vi.stubEnv("MODEL_PROVIDER", "");
    vi.stubEnv("MODEL_NAME", "");
    const res = await request(createApp()).get("/config");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      model: "gpt-5.6-sol",
      provider: "github",
      architectureImageConfigured: false,
      architectureVisionConfigured: false,
    });
  });

  it("returns azure provider when MODEL_PROVIDER=azure", async () => {
    vi.stubEnv("MODEL_PROVIDER", "azure");
    vi.stubEnv("MODEL_NAME", "o4-mini");
    const res = await request(createApp()).get("/config");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      model: "o4-mini",
      provider: "azure",
      architectureImageConfigured: false,
      architectureVisionConfigured: false,
    });
  });

  it("returns github provider with model name", async () => {
    vi.stubEnv("MODEL_PROVIDER", "");
    vi.stubEnv("MODEL_NAME", "gpt-5");
    const res = await request(createApp()).get("/config");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      model: "gpt-5",
      provider: "github",
      architectureImageConfigured: false,
      architectureVisionConfigured: false,
    });
  });

  it("reports configured architecture image and vision models", async () => {
    vi.stubEnv("ARCHITECTURE_MODEL_ENDPOINT", "https://models.example.test");
    vi.stubEnv("ARCHITECTURE_IMAGE_DEPLOYMENT", "gpt-image-2");
    vi.stubEnv("ARCHITECTURE_VISION_DEPLOYMENT", "gpt-5.6-sol");
    const res = await request(createApp()).get("/config");
    expect(res.body).toMatchObject({
      architectureImageConfigured: true,
      architectureVisionConfigured: true,
    });
  });
});
