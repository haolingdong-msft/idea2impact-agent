import { CopilotClient } from "@github/copilot-sdk";

let client: CopilotClient | null = null;

async function getGitHubToken(): Promise<string | undefined> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const secretUri = process.env.GITHUB_TOKEN_SECRET_URI;
  if (!secretUri) return undefined;

  const { DefaultAzureCredential, ManagedIdentityCredential } =
    await import("@azure/identity");
  const credential = process.env.NODE_ENV === "production"
    ? process.env.AZURE_CLIENT_ID
      ? new ManagedIdentityCredential(process.env.AZURE_CLIENT_ID)
      : new ManagedIdentityCredential()
    : new DefaultAzureCredential();
  const accessToken = await credential.getToken(
    "https://vault.azure.net/.default",
  );
  if (!accessToken) {
    throw new Error("Hosted Agent could not acquire a Key Vault access token.");
  }
  const separator = secretUri.includes("?") ? "&" : "?";
  const response = await fetch(`${secretUri}${separator}api-version=7.4`, {
    headers: { Authorization: `Bearer ${accessToken.token}` },
  });
  if (!response.ok) {
    throw new Error(
      `Hosted Agent could not read its GitHub token (${response.status}).`,
    );
  }
  const payload = await response.json() as { value?: unknown };
  if (typeof payload.value !== "string" || !payload.value) {
    throw new Error("Key Vault returned an empty GitHub token.");
  }
  return payload.value;
}

export async function getClient(): Promise<CopilotClient> {
  if (!client) {
    client = new CopilotClient({
      githubToken: await getGitHubToken(),
    });
  }
  return client;
}
