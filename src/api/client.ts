import { CopilotClient } from "@github/copilot-sdk";

let client: CopilotClient | null = null;

/** Shared CopilotClient singleton — one CLI subprocess for the entire server. */
export async function getClient(): Promise<CopilotClient> {
  if (!client) {
    if (!process.env.GITHUB_TOKEN?.trim()) {
      throw new Error(
        "GITHUB_TOKEN is required for local Copilot generation. " +
        "Restart the API with a token from `gh auth token`.",
      );
    }
    client = new CopilotClient({
      githubToken: process.env.GITHUB_TOKEN,
    });
  }
  return client;
}
