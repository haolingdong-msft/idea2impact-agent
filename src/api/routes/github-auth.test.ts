import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import githubAuthRoutes from "./github-auth.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(githubAuthRoutes);
  return app;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GitHub App authentication", () => {
  it("reports unconfigured anonymous status", async () => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "");
    vi.stubEnv("GITHUB_APP_CALLBACK_URL", "");
    vi.stubEnv("GITHUB_APP_ID", "");
    const response = await request(createApp()).get("/auth/github/status");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      configured: false,
      authenticated: false,
      installationCount: 0,
    });
  });

  it("starts OAuth with signed state and a safe return path", async () => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "client-id");
    vi.stubEnv(
      "GITHUB_APP_CALLBACK_URL",
      "http://127.0.0.1:3000/auth/github/callback",
    );
    vi.stubEnv("SESSION_SECRET", "test-session-secret-with-enough-entropy");
    const response = await request(createApp())
      .get("/auth/github/login?returnTo=/workspace")
      .redirects(0);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.location);
    expect(location.hostname).toBe("github.com");
    expect(location.searchParams.get("client_id")).toBe("client-id");
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(response.headers["set-cookie"][0]).toContain("HttpOnly");
    expect(response.headers["set-cookie"][0]).toContain("SameSite=Lax");
  });

  it("renders the least-privilege GitHub App manifest", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SESSION_SECRET", "test-session-secret-with-enough-entropy");
    const response = await request(createApp()).get("/auth/github/app/setup");
    expect(response.status).toBe(200);
    expect(response.text).toContain("https://github.com/settings/apps/new");
    expect(response.text).toContain("&quot;contents&quot;:&quot;read&quot;");
    expect(response.text).toContain("&quot;metadata&quot;:&quot;read&quot;");
    expect(response.text).not.toContain("&quot;issues&quot;");
  });

  it("rejects callbacks without valid OAuth state", async () => {
    vi.stubEnv("SESSION_SECRET", "test-session-secret-with-enough-entropy");
    const response = await request(createApp())
      .get("/auth/github/callback?code=code&state=invalid");
    expect(response.status).toBe(400);
    expect(response.text).toContain("invalid or expired");
  });
});
