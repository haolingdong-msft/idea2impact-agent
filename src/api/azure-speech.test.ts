import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: class {
    async getToken() {
      return { token: "test-token" };
    }
  },
  ManagedIdentityCredential: class {
    async getToken() {
      return { token: "test-token" };
    }
  },
}));

import { synthesizeSpeech } from "./azure-speech.js";

describe("Azure Speech synthesis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.stubEnv(
      "AZURE_SPEECH_ENDPOINT",
      "https://example-resource.cognitiveservices.azure.com/",
    );
  });

  it("uses the TTS route for a configured Cognitive Services endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array(44), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await synthesizeSpeech("A complete narration sentence for testing.");

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://example-resource.cognitiveservices.azure.com/tts/cognitiveservices/v1",
    );
  });

  it("reuses the Foundry custom domain for Entra-authenticated speech", async () => {
    vi.stubEnv("AZURE_SPEECH_ENDPOINT", "");
    vi.stubEnv(
      "ARCHITECTURE_MODEL_ENDPOINT",
      "https://foundry-resource.cognitiveservices.azure.com/",
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array(44), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await synthesizeSpeech("A complete narration sentence for testing.");

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://foundry-resource.cognitiveservices.azure.com/tts/cognitiveservices/v1",
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: expect.objectContaining({
        Authorization: "Bearer test-token",
      }),
    });
  });
});
