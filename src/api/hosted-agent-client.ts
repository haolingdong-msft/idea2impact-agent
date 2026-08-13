import { randomUUID } from "node:crypto";

const FOUNDRY_SCOPE = "https://ai.azure.com/.default";
const REQUEST_TIMEOUT_MS = 130_000;

type Credential = {
  getToken(scope: string): Promise<{ token: string } | null>;
};

let credential: Credential | null = null;

async function getCredential(): Promise<Credential> {
  if (credential) return credential;
  const { DefaultAzureCredential, ManagedIdentityCredential } =
    await import("@azure/identity");
  credential = process.env.NODE_ENV === "production"
    ? process.env.AZURE_CLIENT_ID
      ? new ManagedIdentityCredential(process.env.AZURE_CLIENT_ID)
      : new ManagedIdentityCredential()
    : new DefaultAzureCredential();
  return credential;
}

export function isHostedAgentConfigured(): boolean {
  const endpoint = process.env.PRESENTATION_AGENT_INVOCATIONS_ENDPOINT?.trim();
  if (!endpoint) return false;

  const override = process.env.USE_HOSTED_AGENT?.trim().toLowerCase();
  if (override === "false") return false;
  if (override === "true") return true;

  try {
    const url = new URL(endpoint);
    return url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname);
  } catch {
    return false;
  }
}

async function authorizationHeader(endpoint: string): Promise<string | null> {
  const url = new URL(endpoint);
  if (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)) {
    return null;
  }
  if (url.protocol !== "https:") {
    throw new Error("Hosted Agent endpoint must use HTTPS outside local development.");
  }
  const result = await (await getCredential()).getToken(FOUNDRY_SCOPE);
  if (!result) {
    throw new Error("Managed identity could not acquire a Foundry access token.");
  }
  return `Bearer ${result.token}`;
}

export async function invokeHostedAgent(
  operation: "chat" | "outline" | "architecture" | "architecture-html" | "architecture-image-html" | "architecture-brief" | "slides" | "speech-script",
  input: Record<string, unknown>,
  requestId = randomUUID(),
): Promise<Response> {
  const endpoint = process.env.PRESENTATION_AGENT_INVOCATIONS_ENDPOINT?.trim();
  if (!endpoint) {
    throw new Error("PRESENTATION_AGENT_INVOCATIONS_ENDPOINT is not configured.");
  }
  const authorization = await authorizationHeader(endpoint);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: operation === "chat" ? "text/event-stream" : "application/json",
    "X-Request-Id": requestId,
  };
  if (authorization) headers.Authorization = authorization;

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      version: "1.0",
      operation,
      requestId,
      input,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(
      `Hosted Agent ${operation} invocation failed (${response.status}): ` +
      `${message.slice(0, 500) || response.statusText}`,
    );
  }
  return response;
}

export async function invokeHostedStructured(
  operation: "outline" | "architecture" | "architecture-html" | "architecture-image-html" | "architecture-brief" | "slides" | "speech-script",
  input: Record<string, unknown>,
): Promise<string> {
  const response = await invokeHostedAgent(operation, input);
  const body = await response.json() as {
    result?: { content?: unknown };
  };
  if (typeof body.result?.content !== "string" || !body.result.content.trim()) {
    throw new Error(`Hosted Agent returned no ${operation} content.`);
  }
  return body.result.content;
}
