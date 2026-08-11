type Credential = {
  getToken(scope: string): Promise<{
    token: string;
    expiresOnTimestamp: number;
  }>;
};

let cachedCredential: Credential | null = null;
let cachedToken: { token: string; expiresOn: number } | null = null;

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const SUPPORTED_MODEL_PREFIXES = ["o3", "o4-mini", "gpt-5", "codex-mini"];

export function isModelSupported(modelName: string): boolean {
  const lower = modelName.toLowerCase();
  return SUPPORTED_MODEL_PREFIXES.some(prefix =>
    lower === prefix ||
    lower.startsWith(`${prefix}-`) ||
    lower.startsWith(`${prefix}.`),
  );
}

export function enhanceModelError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Encrypted content is not supported")) {
    return new Error(
      `Model "${process.env.MODEL_NAME ?? "(unknown)"}" does not support ` +
      "Copilot SDK encrypted content. Use o3, o4-mini, or a gpt-5 model.",
    );
  }
  return error instanceof Error ? error : new Error(message);
}

async function createCredential(): Promise<Credential> {
  const { DefaultAzureCredential, ManagedIdentityCredential } =
    await import("@azure/identity");
  if (process.env.NODE_ENV === "production") {
    return process.env.AZURE_CLIENT_ID
      ? new ManagedIdentityCredential(process.env.AZURE_CLIENT_ID)
      : new ManagedIdentityCredential();
  }
  return new DefaultAzureCredential();
}

async function getAzureBearerToken(): Promise<string> {
  if (
    cachedToken &&
    Date.now() < cachedToken.expiresOn - TOKEN_REFRESH_BUFFER_MS
  ) {
    return cachedToken.token;
  }
  cachedCredential ??= await createCredential();
  const result = await cachedCredential.getToken(
    "https://cognitiveservices.azure.com/.default",
  );
  cachedToken = {
    token: result.token,
    expiresOn: result.expiresOnTimestamp,
  };
  return result.token;
}

export async function getSessionOptions(
  options?: { streaming?: boolean },
): Promise<Record<string, unknown>> {
  const provider = process.env.MODEL_PROVIDER;
  const modelName = process.env.MODEL_NAME;
  const streaming = options?.streaming ?? false;

  if (provider === "azure") {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    if (!endpoint || !modelName) {
      throw new Error(
        "AZURE_OPENAI_ENDPOINT and MODEL_NAME are required for Azure BYOM.",
      );
    }
    if (!isModelSupported(modelName)) {
      throw new Error(
        `MODEL_NAME "${modelName}" does not support Copilot SDK encrypted content.`,
      );
    }
    return {
      model: modelName,
      streaming,
      provider: {
        type: "azure",
        baseUrl: endpoint.replace(/\/$/, ""),
        bearerToken: await getAzureBearerToken(),
        wireApi: "completions",
        azure: { apiVersion: "2025-04-01-preview" },
      },
    };
  }

  return modelName ? { model: modelName, streaming } : { streaming };
}
