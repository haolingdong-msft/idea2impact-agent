import {
  createHmac,
  createPrivateKey,
  randomBytes,
  sign,
} from "node:crypto";
import { Router, type Request, type Response } from "express";
import { DefaultAzureCredential, ManagedIdentityCredential } from "@azure/identity";
import type { GitHubRepositoryLocation } from "./repository.js";

const router = Router();
const SESSION_COOKIE = "presentation_session";
const OAUTH_STATE_COOKIE = "github_oauth_state";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const STATE_TTL_SECONDS = 10 * 60;
const localSessionSecret = randomBytes(32).toString("base64url");

export type GitHubUserSession = {
  kind: "github";
  userId: number;
  login: string;
  installationIds: number[];
  expiresAt: number;
};

type OAuthState = {
  state: string;
  returnTo: string;
  expiresAt: number;
};

function parseCookies(request: Request): Record<string, string> {
  return Object.fromEntries(
    (request.headers.cookie || "")
      .split(";")
      .map(item => item.trim())
      .filter(Boolean)
      .map(item => {
        const separator = item.indexOf("=");
        return separator < 0
          ? [item, ""]
          : [item.slice(0, separator), decodeURIComponent(item.slice(separator + 1))];
      }),
  );
}

function sessionSecret(): string {
  const configured = process.env.SESSION_SECRET;
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET is required in production.");
  }
  return localSessionSecret;
}

function signed<T>(value: T): string {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  const signature = createHmac("sha256", sessionSecret())
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function verifySigned<T>(value: string | undefined): T | null {
  if (!value) return null;
  const separator = value.lastIndexOf(".");
  if (separator < 1) return null;
  const payload = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expected = createHmac("sha256", sessionSecret())
    .update(payload)
    .digest("base64url");
  if (signature.length !== expected.length) return null;
  let mismatch = 0;
  for (let index = 0; index < signature.length; index += 1) {
    mismatch |= signature.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  if (mismatch !== 0) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

function cookie(
  name: string,
  value: string,
  maximumAge: number,
): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maximumAge}${secure}`;
}

function clearCookie(name: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export function getGitHubUserSession(request: Request): GitHubUserSession | null {
  const value = verifySigned<GitHubUserSession>(parseCookies(request)[SESSION_COOKIE]);
  if (
    !value ||
    value.kind !== "github" ||
    !Number.isInteger(value.userId) ||
    !Array.isArray(value.installationIds) ||
    value.expiresAt <= Date.now()
  ) {
    return null;
  }
  return value;
}

function requiredConfig() {
  const clientId = process.env.GITHUB_APP_CLIENT_ID;
  const callbackUrl = process.env.GITHUB_APP_CALLBACK_URL;
  if (!clientId || !callbackUrl) {
    throw new Error(
      "GitHub App login is not configured. Set GITHUB_APP_CLIENT_ID and GITHUB_APP_CALLBACK_URL.",
    );
  }
  return { clientId, callbackUrl };
}

async function secretValue(
  directName: string,
  uriName: string,
): Promise<string> {
  const direct = process.env[directName];
  if (direct) return direct.replaceAll("\\n", "\n");
  const uri = process.env[uriName];
  if (!uri) throw new Error(`${directName} or ${uriName} is required.`);
  const credential = process.env.NODE_ENV === "production"
    ? process.env.AZURE_CLIENT_ID
      ? new ManagedIdentityCredential(process.env.AZURE_CLIENT_ID)
      : new ManagedIdentityCredential()
    : new DefaultAzureCredential();
  const token = await credential.getToken("https://vault.azure.net/.default");
  if (!token) throw new Error("Could not acquire a Key Vault access token.");
  const response = await fetch(
    `${uri}${uri.includes("?") ? "&" : "?"}api-version=7.4`,
    { headers: { Authorization: `Bearer ${token.token}` } },
  );
  if (!response.ok) {
    throw new Error(`Could not read GitHub App secret (${response.status}).`);
  }
  const body = await response.json() as { value?: unknown };
  if (typeof body.value !== "string" || !body.value) {
    throw new Error("GitHub App secret is empty.");
  }
  return body.value.replaceAll("\\n", "\n");
}

async function setKeyVaultSecret(
  vaultUrl: string,
  name: string,
  value: string,
): Promise<string> {
  const credential = new DefaultAzureCredential();
  const token = await credential.getToken("https://vault.azure.net/.default");
  if (!token) throw new Error("Could not acquire a Key Vault access token.");
  const uri = `${vaultUrl.replace(/\/$/, "")}/secrets/${name}`;
  const response = await fetch(`${uri}?api-version=7.4`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ value }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Could not store ${name} in Key Vault (${response.status}): ${detail.slice(0, 300)}`,
    );
  }
  const body = await response.json() as { id?: unknown };
  if (typeof body.id !== "string") {
    throw new Error(`Key Vault did not return a secret URI for ${name}.`);
  }
  return body.id.replace(/\/[0-9a-f]+$/i, "");
}

function githubAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" }))
    .toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iat: now - 30,
    exp: now + 9 * 60,
    iss: appId,
  })).toString("base64url");
  const unsigned = `${header}.${payload}`;
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(unsigned),
    createPrivateKey(privateKey),
  ).toString("base64url");
  return `${unsigned}.${signature}`;
}

async function appAuthorization(): Promise<string> {
  const appId = process.env.GITHUB_APP_ID;
  if (!appId) throw new Error("GITHUB_APP_ID is required.");
  const privateKey = await secretValue(
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_PRIVATE_KEY_SECRET_URI",
  );
  return `Bearer ${githubAppJwt(appId, privateKey)}`;
}

export async function installationTokenForRepository(
  session: GitHubUserSession,
  location: GitHubRepositoryLocation,
): Promise<string> {
  const authorization = await appAuthorization();
  const installationResponse = await fetch(
    `https://api.github.com/repos/${location.owner}/${location.repository}/installation`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: authorization,
        "User-Agent": "idea2impact-agent",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!installationResponse.ok) {
    throw new Error("The GitHub App is not installed on this repository.");
  }
  const installation = await installationResponse.json() as { id?: unknown };
  if (
    typeof installation.id !== "number" ||
    !session.installationIds.includes(installation.id)
  ) {
    throw new Error("This GitHub App installation is not authorized for the current user.");
  }
  const tokenResponse = await fetch(
    `https://api.github.com/app/installations/${installation.id}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: authorization,
        "User-Agent": "idea2impact-agent",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!tokenResponse.ok) {
    throw new Error(`Could not create a GitHub installation token (${tokenResponse.status}).`);
  }
  const tokenBody = await tokenResponse.json() as { token?: unknown };
  if (typeof tokenBody.token !== "string" || !tokenBody.token) {
    throw new Error("GitHub returned an empty installation token.");
  }
  return tokenBody.token;
}

router.get("/auth/github/status", (request, response) => {
  const session = getGitHubUserSession(request);
  response.json({
    configured: Boolean(
      process.env.GITHUB_APP_CLIENT_ID &&
      process.env.GITHUB_APP_CALLBACK_URL &&
      process.env.GITHUB_APP_ID,
    ),
    authenticated: Boolean(session),
    user: session ? { id: session.userId, login: session.login } : null,
    installationCount: session?.installationIds.length ?? 0,
    app: process.env.NODE_ENV === "production"
      ? undefined
      : {
          id: process.env.GITHUB_APP_ID || null,
          clientId: process.env.GITHUB_APP_CLIENT_ID || null,
          callbackUrl: process.env.GITHUB_APP_CALLBACK_URL || null,
        },
  });
});

router.get("/auth/github/app/setup", (_request, response) => {
  if (process.env.NODE_ENV === "production") {
    response.status(404).end();
    return;
  }
  const setupNonce = randomBytes(24).toString("base64url");
  const manifest = {
    name: process.env.GITHUB_APP_NAME || "Idea2Impact Agent haolingdong-msft",
    url: process.env.GITHUB_APP_HOME_URL || "http://127.0.0.1:5173",
    redirect_url:
      process.env.GITHUB_APP_MANIFEST_CALLBACK_URL ||
      "http://127.0.0.1:3000/auth/github/app/manifest-callback",
    callback_urls: [
      process.env.GITHUB_APP_CALLBACK_URL ||
      "http://127.0.0.1:3000/auth/github/callback",
    ],
    public: false,
    request_oauth_on_install: true,
    default_permissions: {
      contents: "read",
      metadata: "read",
    },
    default_events: [],
  };
  response.setHeader(
    "Set-Cookie",
    cookie(OAUTH_STATE_COOKIE, signed({
      state: setupNonce,
      returnTo: "/",
      expiresAt: Date.now() + STATE_TTL_SECONDS * 1000,
    }), STATE_TTL_SECONDS),
  );
  response.type("html").send(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Create Idea2Impact Agent GitHub App</title></head>
  <body>
    <p>Redirecting to GitHub to create the least-privilege Idea2Impact Agent App...</p>
    <form id="create-app" method="post" action="https://github.com/settings/apps/new">
      <input type="hidden" name="manifest" value="${JSON.stringify(manifest)
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")}">
    </form>
    <script>document.getElementById("create-app").submit()</script>
  </body>
</html>`);
});

router.get("/auth/github/app/manifest-callback", async (request, response) => {
  if (process.env.NODE_ENV === "production") {
    response.status(404).end();
    return;
  }
  const state = verifySigned<OAuthState>(
    parseCookies(request)[OAUTH_STATE_COOKIE],
  );
  const code = typeof request.query.code === "string" ? request.query.code : "";
  if (!state || state.expiresAt <= Date.now() || !code) {
    response.status(400).send("GitHub App setup state is invalid or expired.");
    return;
  }
  try {
    const exchangeResponse = await fetch(
      `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "idea2impact-agent",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!exchangeResponse.ok) {
      throw new Error(`GitHub App manifest exchange failed (${exchangeResponse.status}).`);
    }
    const app = await exchangeResponse.json() as {
      id?: unknown;
      client_id?: unknown;
      client_secret?: unknown;
      pem?: unknown;
      html_url?: unknown;
    };
    if (
      typeof app.id !== "number" ||
      typeof app.client_id !== "string" ||
      typeof app.client_secret !== "string" ||
      typeof app.pem !== "string"
    ) {
      throw new Error("GitHub returned incomplete App credentials.");
    }
    const vaultUrl =
      process.env.GITHUB_APP_KEY_VAULT_URL ||
      "https://kv-haoling-hackathon.vault.azure.net";
    const generatedSessionSecret = randomBytes(48).toString("base64url");
    const [clientSecretUri, privateKeyUri, sessionSecretUri] = await Promise.all([
      setKeyVaultSecret(
        vaultUrl,
        "presentation-agent-github-client-secret",
        app.client_secret,
      ),
      setKeyVaultSecret(
        vaultUrl,
        "presentation-agent-github-private-key",
        app.pem,
      ),
      setKeyVaultSecret(
        vaultUrl,
        "presentation-agent-session-secret",
        generatedSessionSecret,
      ),
    ]);
    process.env.GITHUB_APP_ID = String(app.id);
    process.env.GITHUB_APP_CLIENT_ID = app.client_id;
    process.env.GITHUB_APP_CLIENT_SECRET_URI = clientSecretUri;
    process.env.GITHUB_APP_PRIVATE_KEY_SECRET_URI = privateKeyUri;
    process.env.SESSION_SECRET_URI = sessionSecretUri;
    process.env.SESSION_SECRET = generatedSessionSecret;
    process.env.GITHUB_APP_CALLBACK_URL =
      "http://127.0.0.1:3000/auth/github/callback";
    response.setHeader("Set-Cookie", clearCookie(OAUTH_STATE_COOKIE));
    if (typeof app.html_url === "string") {
      response.redirect(`${app.html_url}/installations/new`);
      return;
    }
    response.type("html").send(
      `GitHub App created. App ID: ${app.id}. Install it on the repositories you want to use.`,
    );
  } catch (error) {
    response.status(502).send(
      error instanceof Error ? error.message : "GitHub App setup failed.",
    );
  }
});

router.get("/auth/github/login", (request, response) => {
  try {
    const { clientId, callbackUrl } = requiredConfig();
    const returnTo =
      typeof request.query.returnTo === "string" &&
      request.query.returnTo.startsWith("/") &&
      !request.query.returnTo.startsWith("//")
        ? request.query.returnTo
        : "/";
    const state = randomBytes(24).toString("base64url");
    const stateValue: OAuthState = {
      state,
      returnTo,
      expiresAt: Date.now() + STATE_TTL_SECONDS * 1000,
    };
    response.setHeader(
      "Set-Cookie",
      cookie(OAUTH_STATE_COOKIE, signed(stateValue), STATE_TTL_SECONDS),
    );
    const authorize = new URL("https://github.com/login/oauth/authorize");
    authorize.searchParams.set("client_id", clientId);
    authorize.searchParams.set("redirect_uri", callbackUrl);
    authorize.searchParams.set("state", state);
    response.redirect(authorize.toString());
  } catch (error) {
    response.status(503).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

router.get("/auth/github/callback", async (request, response) => {
  const cookies = parseCookies(request);
  const state = verifySigned<OAuthState>(cookies[OAUTH_STATE_COOKIE]);
  const code = typeof request.query.code === "string" ? request.query.code : "";
  const returnedState =
    typeof request.query.state === "string" ? request.query.state : "";
  if (
    !state ||
    state.expiresAt <= Date.now() ||
    !code ||
    returnedState !== state.state
  ) {
    response.status(400).send("GitHub OAuth state is invalid or expired.");
    return;
  }
  try {
    const { clientId, callbackUrl } = requiredConfig();
    const clientSecret = await secretValue(
      "GITHUB_APP_CLIENT_SECRET",
      "GITHUB_APP_CLIENT_SECRET_URI",
    );
    const tokenResponse = await fetch(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: callbackUrl,
        }),
      },
    );
    const tokenBody = await tokenResponse.json() as {
      access_token?: unknown;
      error_description?: unknown;
    };
    if (typeof tokenBody.access_token !== "string") {
      throw new Error(
        typeof tokenBody.error_description === "string"
          ? tokenBody.error_description
          : "GitHub OAuth token exchange failed.",
      );
    }
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${tokenBody.access_token}`,
      "User-Agent": "idea2impact-agent",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    const [userResponse, installationResponse] = await Promise.all([
      fetch("https://api.github.com/user", { headers }),
      fetch("https://api.github.com/user/installations?per_page=100", { headers }),
    ]);
    if (!userResponse.ok || !installationResponse.ok) {
      throw new Error("GitHub user or installation lookup failed.");
    }
    const user = await userResponse.json() as { id?: unknown; login?: unknown };
    const installations = await installationResponse.json() as {
      installations?: Array<{ id?: unknown }>;
    };
    if (typeof user.id !== "number" || typeof user.login !== "string") {
      throw new Error("GitHub returned an invalid user identity.");
    }
    const session: GitHubUserSession = {
      kind: "github",
      userId: user.id,
      login: user.login,
      installationIds: (installations.installations || [])
        .map(item => item.id)
        .filter((id): id is number => typeof id === "number")
        .slice(0, 100),
      expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
    };
    response.setHeader("Set-Cookie", [
      cookie(SESSION_COOKIE, signed(session), SESSION_TTL_SECONDS),
      clearCookie(OAUTH_STATE_COOKIE),
    ]);
    const webOrigin =
      process.env.WEB_APP_ORIGIN ||
      (process.env.NODE_ENV === "production" ? "" : "http://127.0.0.1:5173");
    response.redirect(`${webOrigin}${state.returnTo}`);
  } catch (error) {
    response.status(502).send(
      error instanceof Error ? error.message : "GitHub authentication failed.",
    );
  }
});

router.post("/auth/github/logout", (_request, response) => {
  response.setHeader("Set-Cookie", clearCookie(SESSION_COOKIE));
  response.status(204).end();
});

export default router;
