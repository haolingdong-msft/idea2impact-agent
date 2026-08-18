import { DefaultAzureCredential, ManagedIdentityCredential } from "@azure/identity";

export type ArchitectureVisualNode = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ArchitectureVisualConnection = {
  from: string;
  to: string;
  points: Array<{ x: number; y: number }>;
  labelX: number;
  labelY: number;
};

export type ArchitectureVisualLayout = {
  width: 1600;
  height: 900;
  nodes: ArchitectureVisualNode[];
  connections: ArchitectureVisualConnection[];
};

export type ArchitectureVisual = {
  mode:
    | "dual"
    | "html"
    | "image"
    | "narrative-image"
    | "narrative-html"
    | "validated-json-html"
    | "image-html"
    | "legacy";
  imageUrl?: string;
  pptxDownloadUrl?: string;
  pptxGenerateUrl?: string;
  narrativeImageUrl?: string;
  htmlUrl?: string;
  validatedJsonHtmlUrl?: string;
  imageDerivedHtmlUrl?: string;
  narrativeHtmlUrl?: string;
  layout?: ArchitectureVisualLayout;
  fallbackReason?: string;
  failures?: Array<{ mode: string; error: string }>;
};

type Credential = {
  getToken(scope: string): Promise<{ token: string } | null>;
};

let credential: Credential | null = null;

const TOKEN_SCOPE = "https://cognitiveservices.azure.com/.default";
const IMAGE_TIMEOUT_MS = 120_000;
const LAYOUT_TIMEOUT_MS = 120_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_PROMPT_LENGTH = 12_000;
const MAX_MODEL_ATTEMPTS = 4;

export type ModelRetryNotice = {
  attempt: number;
  delaySeconds: number;
  status: number;
};

let imageGenerationQueue: Promise<void> = Promise.resolve();

async function getCredential(): Promise<Credential> {
  if (credential) return credential;
  credential = process.env.NODE_ENV === "production"
    ? process.env.AZURE_CLIENT_ID
      ? new ManagedIdentityCredential(process.env.AZURE_CLIENT_ID)
      : new ManagedIdentityCredential()
    : new DefaultAzureCredential();
  return credential;
}

async function authorizationHeader(): Promise<string> {
  const result = await (await getCredential()).getToken(TOKEN_SCOPE);
  if (!result) {
    throw new Error("Managed identity could not acquire a Foundry model token.");
  }
  return `Bearer ${result.token}`;
}

function configuredValue(name: string): string {
  return process.env[name]?.trim() || "";
}

async function modelHeaders(): Promise<Record<string, string>> {
  const localApiKey = process.env.NODE_ENV !== "production"
    ? configuredValue("ARCHITECTURE_MODEL_API_KEY")
    : "";
  return {
    ...(localApiKey
      ? { "api-key": localApiKey }
      : { Authorization: await authorizationHeader() }),
    "Content-Type": "application/json",
  };
}

export function isArchitectureVisualConfigured(): boolean {
  return Boolean(
    configuredValue("ARCHITECTURE_MODEL_ENDPOINT") &&
    configuredValue("ARCHITECTURE_IMAGE_DEPLOYMENT") &&
    configuredValue("ARCHITECTURE_VISION_DEPLOYMENT"),
  );
}

export function isArchitectureImageConfigured(): boolean {
  return Boolean(
    configuredValue("ARCHITECTURE_MODEL_ENDPOINT") &&
    configuredValue("ARCHITECTURE_IMAGE_DEPLOYMENT"),
  );
}

export function architectureImageConfiguration(): {
  deployment: string;
  width: number;
  height: number;
} {
  const deployment = configuredValue("ARCHITECTURE_IMAGE_DEPLOYMENT");
  const isGptImage2 = deployment.toLowerCase().includes("gpt-image-2");
  return {
    deployment,
    width: 1536,
    height: isGptImage2 ? 864 : 1024,
  };
}

function deploymentUrl(deployment: string, operation: string, apiVersion: string): string {
  const endpoint = configuredValue("ARCHITECTURE_MODEL_ENDPOINT").replace(/\/$/, "");
  return `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/${operation}?api-version=${encodeURIComponent(apiVersion)}`;
}

async function modelFetch(
  url: string,
  body: unknown,
  timeout: number,
  onRetry?: (notice: ModelRetryNotice) => void,
): Promise<Response> {
  for (let attempt = 1; attempt <= MAX_MODEL_ATTEMPTS; attempt += 1) {
    const response = await fetch(url, {
      method: "POST",
      headers: await modelHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    if (response.ok) {
      return response;
    }
    const detail = (await response.text()).slice(0, 800);
    const deploymentNotFound =
      response.status === 404 && /DeploymentNotFound/i.test(detail);
    if (deploymentNotFound && attempt < MAX_MODEL_ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, attempt * 750));
      continue;
    }
    if (response.status === 429 && attempt < MAX_MODEL_ATTEMPTS) {
      const retryAfterHeader = Number(response.headers.get("retry-after"));
      const retryAfterMessage = Number(
        detail.match(/retry after\s+(\d+)\s+seconds?/i)?.[1],
      );
      const delaySeconds = Math.min(
        120,
        Math.max(
          1,
          Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
            ? retryAfterHeader
            : Number.isFinite(retryAfterMessage) && retryAfterMessage > 0
              ? retryAfterMessage
              : attempt * 15,
        ),
      );
      onRetry?.({ attempt: attempt + 1, delaySeconds, status: response.status });
      await new Promise(resolve => setTimeout(resolve, delaySeconds * 1_000));
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Project overview model access failed (${response.status}). Grant the API managed identity ` +
        `Cognitive Services OpenAI User on the model resource. ${detail}`,
      );
    }
    const target = new URL(url);
    const deployment = decodeURIComponent(
      target.pathname.match(/\/deployments\/([^/]+)/)?.[1] || "unknown",
    );
    throw new Error(
      `Project overview model request failed (${response.status}) for deployment ` +
      `"${deployment}" on "${target.host}": ${detail || response.statusText}`,
    );
  }
  throw new Error("Project overview model request failed after retrying.");
}

async function serializeImageGeneration<T>(task: () => Promise<T>): Promise<T> {
  const previous = imageGenerationQueue;
  let release!: () => void;
  imageGenerationQueue = new Promise<void>(resolve => {
    release = resolve;
  });
  await previous;
  try {
    return await task();
  } finally {
    release();
  }
}

function imagePrompt(
  evidenceBrief: string,
  inputKind: "validated-architecture" | "agent-summary",
): string {
  const instructions = [
    "Create a polished, simple executive overview on a landscape canvas.",
    "The compact validated JSON below is the sole factual source; preserve names and connection endpoints.",
    inputKind === "validated-architecture"
      ? "Choose the composition yourself while keeping the architecture and workflow easy to scan."
      : "Choose the clearest composition from the narrative.",
    "Place components that interact directly close together. Do not create large empty corridors for arrows.",
    "Draw the supplied technicalConnections as short thin orthogonal lines with small arrowheads and at most one bend.",
    "A technical connector should use no more than about 20% of the canvas width or height; rearrange components instead of extending a long line.",
    "Show each connection label in a compact badge near an endpoint, not as a paragraph occupying the middle of the line.",
    "Render workflow steps as one compact sequence. Connect only adjacent workflow steps with short thin arrows.",
    "Never connect workflow steps to architecture components, platforms, or technical arrows.",
    "Use short labels, recognizable symbols, generous whitespace, and clear flow.",
    "Avoid duplicate cards, crossing lines, parallel lines, long text, citations, tiny text, unsupported facts, and watermarks.",
  ].join("\n");
  const evidenceHeading = inputKind === "validated-architecture"
    ? "\n\nVALIDATED PROJECT OVERVIEW SUMMARY\n"
    : "\n\nAGENT-ANALYZED PROJECT OVERVIEW NARRATIVE\n";
  const evidenceBudget =
    MAX_IMAGE_PROMPT_LENGTH - instructions.length - evidenceHeading.length;
  return `${instructions}${evidenceHeading}${evidenceBrief.slice(
    0,
    Math.max(0, evidenceBudget),
  )}`;
}

async function imageBytesFromResponse(response: Response): Promise<Uint8Array> {
  const payload = await response.json() as {
    data?: Array<{ b64_json?: unknown; url?: unknown }>;
  };
  const first = payload.data?.[0];
  if (typeof first?.b64_json === "string" && first.b64_json) {
    const bytes = Buffer.from(first.b64_json, "base64");
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new Error("Generated project overview image exceeds the 8 MB limit.");
    }
    return bytes;
  }
  if (typeof first?.url === "string" && first.url) {
    const imageResponse = await fetch(first.url, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!imageResponse.ok) {
      throw new Error(`Generated project overview image download failed (${imageResponse.status}).`);
    }
    const length = Number(imageResponse.headers.get("content-length") || 0);
    if (length > MAX_IMAGE_BYTES) {
      throw new Error("Generated project overview image exceeds the 8 MB limit.");
    }
    const bytes = new Uint8Array(await imageResponse.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new Error("Generated project overview image exceeds the 8 MB limit.");
    }
    return bytes;
  }
  throw new Error("Foundry image model returned no image.");
}

export async function generateArchitectureImage(
  evidenceBrief: string,
  inputKind: "validated-architecture" | "agent-summary" =
    "validated-architecture",
  onRetry?: (notice: ModelRetryNotice) => void,
): Promise<Uint8Array> {
  const { deployment, width, height } = architectureImageConfiguration();
  return serializeImageGeneration(async () => {
    const response = await modelFetch(
      deploymentUrl(
        deployment,
        "images/generations",
        configuredValue("ARCHITECTURE_IMAGE_API_VERSION") || "2025-04-01-preview",
      ),
      {
        prompt: imagePrompt(evidenceBrief, inputKind),
        n: 1,
        size: `${width}x${height}`,
        quality: "high",
        output_format: "png",
      },
      IMAGE_TIMEOUT_MS,
      onRetry,
    );
    return imageBytesFromResponse(response);
  });
}

function extractJson(content: string): unknown {
  const cleaned = content.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("Vision model returned no project overview layout JSON.");
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

export async function parseArchitectureImage(
  image: Uint8Array,
  evidenceBrief: string,
): Promise<unknown> {
  const response = await modelFetch(
    deploymentUrl(
      configuredValue("ARCHITECTURE_VISION_DEPLOYMENT"),
      "chat/completions",
      configuredValue("ARCHITECTURE_VISION_API_VERSION") || "2025-04-01-preview",
    ),
    {
      response_format: { type: "json_object" },
      messages: [{
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "Reconstruct this project overview as JSON for deterministic SVG rendering.",
              "Use the image for layout and labels, and the approved evidence to reject hallucinated technology claims.",
              "Return exactly { architecture, layout }.",
              "architecture must contain title, summary, 2-4 layers, 6-10 total high-level nodes, labeled connections, and assumptions.",
              "Each layer must contain 1-3 nodes. Never place more than 3 nodes in one layer.",
              "Each node requires id, label, description, kind, technology, provenance, and optional evidencePaths.",
              "Each connection requires from, to, label, type, mechanism, payload, provenance, primary, and optional evidencePaths.",
              "layout must be { width:1600, height:900, nodes, connections }.",
              "Each layout node must use an architecture node id and integer x,y,width,height inside the canvas.",
              "Each layout connection must use matching from/to ids, 2-6 integer points, labelX, and labelY.",
              "Never return HTML, SVG, CSS, markdown, or URLs.",
              "",
              "APPROVED PROJECT OVERVIEW EVIDENCE",
              evidenceBrief,
            ].join("\n"),
          },
          {
            type: "image_url",
            image_url: {
              url: `data:image/png;base64,${Buffer.from(image).toString("base64")}`,
              detail: "high",
            },
          },
        ],
      }],
    },
    LAYOUT_TIMEOUT_MS,
  );
  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("Vision model returned no project overview layout content.");
  }
  return extractJson(content);
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} is outside the project overview canvas.`);
  }
  return Number(value);
}

export function validateArchitectureVisualLayout(
  value: unknown,
  nodeIds: Set<string>,
  connectionKeys: Set<string>,
): ArchitectureVisualLayout {
  if (!value || typeof value !== "object") {
    throw new Error("Project overview visual layout must be an object.");
  }
  const source = value as Record<string, unknown>;
  if (source.width !== 1600 || source.height !== 900) {
    throw new Error("Project overview visual layout must use a 1600x900 canvas.");
  }
  if (!Array.isArray(source.nodes) || source.nodes.length !== nodeIds.size) {
    throw new Error("Project overview visual layout must position every component.");
  }
  const seen = new Set<string>();
  const nodes = source.nodes.map((rawNode, index) => {
    if (!rawNode || typeof rawNode !== "object") {
      throw new Error(`Visual node ${index + 1} is invalid.`);
    }
    const node = rawNode as Record<string, unknown>;
    const id = typeof node.id === "string" ? node.id.trim() : "";
    if (!nodeIds.has(id) || seen.has(id)) {
      throw new Error(`Visual node ${index + 1} has an unknown or duplicate id.`);
    }
    seen.add(id);
    const width = integer(node.width, 120, 520, `Visual node ${id} width`);
    const height = integer(node.height, 70, 260, `Visual node ${id} height`);
    const x = integer(node.x, 0, 1600 - width, `Visual node ${id} x`);
    const y = integer(node.y, 0, 900 - height, `Visual node ${id} y`);
    return { id, x, y, width, height };
  });
  if (!Array.isArray(source.connections) || source.connections.length > 14) {
    throw new Error("Project overview visual layout has invalid connections.");
  }
  const connections = source.connections.map((rawConnection, index) => {
    if (!rawConnection || typeof rawConnection !== "object") {
      throw new Error(`Visual connection ${index + 1} is invalid.`);
    }
    const connection = rawConnection as Record<string, unknown>;
    const from = typeof connection.from === "string" ? connection.from.trim() : "";
    const to = typeof connection.to === "string" ? connection.to.trim() : "";
    if (!connectionKeys.has(`${from}->${to}`)) {
      throw new Error(`Visual connection ${index + 1} does not match the project overview.`);
    }
    if (!Array.isArray(connection.points) ||
        connection.points.length < 2 ||
        connection.points.length > 6) {
      throw new Error(`Visual connection ${index + 1} requires 2-6 points.`);
    }
    const points = connection.points.map((rawPoint, pointIndex) => {
      if (!rawPoint || typeof rawPoint !== "object") {
        throw new Error(`Visual connection ${index + 1} point ${pointIndex + 1} is invalid.`);
      }
      const point = rawPoint as Record<string, unknown>;
      return {
        x: integer(point.x, 0, 1600, `Visual connection ${index + 1} point x`),
        y: integer(point.y, 0, 900, `Visual connection ${index + 1} point y`),
      };
    });
    return {
      from,
      to,
      points,
      labelX: integer(connection.labelX, 0, 1600, `Visual connection ${index + 1} labelX`),
      labelY: integer(connection.labelY, 0, 900, `Visual connection ${index + 1} labelY`),
    };
  });
  return { width: 1600, height: 900, nodes, connections };
}

function boundedNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const candidate = typeof value === "number" && Number.isFinite(value)
    ? Math.round(value)
    : fallback;
  return Math.min(maximum, Math.max(minimum, candidate));
}

export function normalizeArchitectureVisualLayout(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const nodes = Array.isArray(source.nodes)
    ? source.nodes.map((rawNode) => {
        const node = rawNode && typeof rawNode === "object"
          ? rawNode as Record<string, unknown>
          : {};
        const width = boundedNumber(node.width, 120, 520, 280);
        const height = boundedNumber(node.height, 70, 260, 140);
        return {
          ...node,
          x: boundedNumber(node.x, 0, 1600 - width, 0),
          y: boundedNumber(node.y, 0, 900 - height, 0),
          width,
          height,
        };
      })
    : source.nodes;
  const connections = Array.isArray(source.connections)
    ? source.connections.map((rawConnection) => {
        const connection = rawConnection && typeof rawConnection === "object"
          ? rawConnection as Record<string, unknown>
          : {};
        const points = Array.isArray(connection.points)
          ? connection.points.map((rawPoint) => {
              const point = rawPoint && typeof rawPoint === "object"
                ? rawPoint as Record<string, unknown>
                : {};
              return {
                x: boundedNumber(point.x, 0, 1600, 0),
                y: boundedNumber(point.y, 0, 900, 0),
              };
            })
          : connection.points;
        return {
          ...connection,
          points,
          labelX: boundedNumber(connection.labelX, 0, 1600, 800),
          labelY: boundedNumber(connection.labelY, 0, 900, 450),
        };
      })
    : source.connections;
  return { ...source, width: 1600, height: 900, nodes, connections };
}
