import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from "@azure/identity";

type Credential = {
  getToken(scope: string): Promise<{ token: string } | null>;
};

const SPEECH_SCOPE = "https://cognitiveservices.azure.com/.default";
const DEFAULT_VOICE = "en-US-AvaMultilingualNeural";
let credential: Credential | null = null;

function configuredValue(name: string): string {
  return process.env[name]?.trim() || "";
}

function getCredential(): Credential {
  if (credential) return credential;
  credential = process.env.NODE_ENV === "production"
    ? configuredValue("AZURE_CLIENT_ID")
      ? new ManagedIdentityCredential(configuredValue("AZURE_CLIENT_ID"))
      : new ManagedIdentityCredential()
    : new DefaultAzureCredential();
  return credential;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function speechEndpoint(): string {
  const configured = configuredValue("AZURE_SPEECH_ENDPOINT");
  if (configured) {
    return `${configured.replace(/\/$/, "")}/tts/cognitiveservices/v1`;
  }
  const architectureEndpoint = configuredValue("ARCHITECTURE_MODEL_ENDPOINT");
  if (
    architectureEndpoint &&
    new URL(architectureEndpoint).hostname.endsWith(".cognitiveservices.azure.com")
  ) {
    return `${architectureEndpoint.replace(/\/$/, "")}/tts/cognitiveservices/v1`;
  }
  const accountName = configuredValue("AZURE_AI_ACCOUNT_NAME");
  if (accountName) {
    return `https://${accountName}.cognitiveservices.azure.com/tts/cognitiveservices/v1`;
  }
  const region = configuredValue("AZURE_SPEECH_REGION") || "eastus2";
  return `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
}

export function supportedSpeechVoice(value: unknown): string {
  const allowed = new Set([
    "en-US-AvaMultilingualNeural",
    "en-US-AndrewMultilingualNeural",
    "zh-CN-XiaoxiaoNeural",
    "zh-CN-YunxiNeural",
  ]);
  return typeof value === "string" && allowed.has(value)
    ? value
    : DEFAULT_VOICE;
}

export async function synthesizeSpeech(
  text: string,
  voice = DEFAULT_VOICE,
): Promise<Uint8Array> {
  const apiKey = configuredValue("AZURE_SPEECH_KEY");
  const token = apiKey ? null : await getCredential().getToken(SPEECH_SCOPE);
  if (!apiKey && !token) {
    throw new Error("Azure Speech authentication is unavailable.");
  }
  const language = voice.startsWith("zh-CN") ? "zh-CN" : "en-US";
  const response = await fetch(speechEndpoint(), {
    method: "POST",
    headers: {
      ...(apiKey
        ? { "Ocp-Apim-Subscription-Key": apiKey }
        : { Authorization: `Bearer ${token!.token}` }),
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "riff-24khz-16bit-mono-pcm",
      "User-Agent": "idea2impact-agent",
    },
    body: [
      `<speak version="1.0" xml:lang="${language}">`,
      `<voice name="${voice}">`,
      escapeXml(text),
      "</voice></speak>",
    ].join(""),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(
      `Azure Speech synthesis failed (${response.status}): ` +
      `${detail || response.statusText}`,
    );
  }
  const audio = new Uint8Array(await response.arrayBuffer());
  if (audio.length < 44) {
    throw new Error("Azure Speech returned an empty narration segment.");
  }
  return audio;
}
