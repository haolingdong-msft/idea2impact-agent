import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { raw, Router, type Request, type Response } from "express";
import { getClient } from "../client.js";
import { enhanceModelError, getSessionOptions } from "../model-config.js";
import {
  ARCHITECTURE_GRAPH_PROMPT,
  ARCHITECTURE_GRAPH_REPAIR_PROMPT,
  ARCHITECTURE_HTML_PROMPT,
  ARCHITECTURE_HTML_REPAIR_PROMPT,
  ARCHITECTURE_IMAGE_HTML_PROMPT,
  ARCHITECTURE_IMAGE_BRIEF_PROMPT,
  PRESENTATION_AGENT_INSTRUCTIONS,
} from "../presentation-instructions.js";
import {
  clearCurrentProjectAssets,
  currentSourceAssetIds,
  getProject,
  isProjectId,
  readProjectBinaryAsset,
  readProjectAsset,
  storeProjectBinaryAsset,
  storeProjectJsonAsset,
  storeProjectTextAsset,
} from "./project-store.js";
import {
  invokeHostedAgent,
  invokeHostedStructured,
  isHostedAgentConfigured,
} from "../hosted-agent-client.js";
import { repositoryPromptContext } from "./repository-context.js";
import {
  applyArchitectureImageLayoutGuard,
} from "../architecture-html-layout.js";
import {
  architectureImageConfiguration,
  generateArchitectureImage,
  isArchitectureImageConfigured,
  type ArchitectureVisual,
} from "../architecture-visual.js";

const router = Router();
const EDITABLE_PPT_SKILL_TIMEOUT_MS = 15 * 60_000;
type EditablePptSkillPayload = {
  jobId?: unknown;
  status?: unknown;
  invocationId?: unknown;
  runId?: unknown;
  workflow?: unknown;
  validationPassed?: unknown;
  sourceImageSha256?: unknown;
  sourceImageSha256s?: unknown;
  pptxBase64?: unknown;
  error?: unknown;
};
type EditablePptGatewayJob = {
  remoteJobId: string;
  sessionId: string;
  sourceImageSha256: string;
  startedAt: string;
  logs: string[];
  status: "running" | "completed" | "failed";
  pptx?: Buffer;
  invocationId?: string;
  runId?: string;
  error?: string;
};
const editablePptGatewayJobs = new Map<string, EditablePptGatewayJob>();
const editablePptSkillInvocations = new Map<
  string,
  Promise<{
    invocationId: string;
    runId: string;
    assetId: string;
  }>
>();

export type ArchitectureNode = {
  id: string;
  label: string;
  description: string;
  kind: "actor" | "interface" | "agent" | "service" | "data" | "integration" | "security";
  technology: string;
  provenance: "confirmed" | "assumed";
  evidencePaths?: string[];
};

export type ArchitectureLayer = {
  id: string;
  label: string;
  purpose: string;
  tone: "navy" | "blue" | "teal" | "violet" | "amber";
  nodes: ArchitectureNode[];
};

export type ArchitectureGraph = {
  title: string;
  summary: string;
  layers: ArchitectureLayer[];
  platforms: Array<{
    id: string;
    label: string;
    description: string;
    technology: string;
    componentNodeIds: string[];
    toolings: Array<{
      id: string;
      label: string;
      description: string;
      technology: string;
      componentNodeId: string;
    }>;
    provenance: "confirmed" | "assumed";
  }>;
  workflow: {
    actor: string;
    goal: string;
    steps: Array<{
      id: string;
      order: number;
      label: string;
      userAction: string;
      platformCalls: Array<{
        platformId: string;
        toolingId: string;
        nodeId: string;
        action: string;
        mechanism: string;
        output: string;
      }>;
    }>;
  };
  connections: Array<{
    from: string;
    to: string;
    label: string;
    type: "request" | "event" | "data" | "auth";
    mechanism: string;
    payload: string;
    provenance: "confirmed" | "assumed";
    primary: boolean;
    evidencePaths?: string[];
  }>;
  assumptions: string[];
};

interface ArchitectureSession {
  sendAndWait(
    msg: {
      prompt: string;
      attachments?: Array<{
        type: "file";
        path: string;
        displayName?: string;
      }>;
    },
    timeout: number,
  ): Promise<{ data?: unknown } | undefined>;
  destroy(): Promise<void>;
}

type GeneratedArchitecture = {
  architecture: ArchitectureGraph;
  visual: ArchitectureVisual;
};

type ArchitectureVisualMode =
  | "html"
  | "image"
  | "narrative-image"
  | "narrative-html"
  | "validated-json-html"
  | "image-html";

const NODE_KINDS = new Set([
  "actor",
  "interface",
  "agent",
  "service",
  "data",
  "integration",
  "security",
]);
const TONES = new Set(["navy", "blue", "teal", "violet", "amber"]);
const PROVENANCE = new Set(["confirmed", "assumed"]);
const CONNECTION_TYPES = new Set(["request", "event", "data", "auth"]);
const VISUAL_MODES = new Set<ArchitectureVisualMode>([
  "html",
  "image",
  "narrative-image",
  "narrative-html",
  "validated-json-html",
  "image-html",
]);
const MAX_REPAIR_RESPONSE = 58_000;
const MAX_VALIDATION_FEEDBACK = 1_000;

type ArchitectureProgress = {
  status: "idle" | "running" | "completed" | "failed";
  stage: string;
  percent: number;
  completedTasks: number;
  totalTasks: number;
  tasks: Array<{
    id: string;
    label: string;
    status: "pending" | "running" | "completed" | "failed";
    error?: string;
  }>;
  startedAt: string;
  updatedAt: string;
  error?: string;
};

const architectureProgress = new Map<string, ArchitectureProgress>();
const VISUAL_TASKS = [
  ["validated-json-image", "Validated JSON → GPT-Image-2"],
] as const;

function updateArchitectureProgress(
  projectId: string,
  update: Partial<ArchitectureProgress>,
): void {
  const current = architectureProgress.get(projectId);
  if (!current) return;
  architectureProgress.set(projectId, {
    ...current,
    ...update,
    updatedAt: new Date().toISOString(),
  });
}

function startArchitectureProgress(projectId: string): void {
  const now = new Date().toISOString();
  architectureProgress.set(projectId, {
    status: "running",
    stage: "Generating validated overview",
    percent: 5,
    completedTasks: 0,
    totalTasks: VISUAL_TASKS.length,
    tasks: VISUAL_TASKS.map(([id, label]) => ({
      id,
      label,
      status: "pending",
    })),
    startedAt: now,
    updatedAt: now,
  });
}

async function runVisualTask<T>(
  projectId: string,
  taskId: string,
  task: () => Promise<T>,
): Promise<T> {
  const current = architectureProgress.get(projectId);
  if (current) {
    updateArchitectureProgress(projectId, {
      stage: "Generating the overview image",
      tasks: current.tasks.map(item =>
        item.id === taskId ? { ...item, status: "running" } : item),
    });
  }
  try {
    const result = await task();
    const latest = architectureProgress.get(projectId);
    if (latest) {
      const completedTasks = latest.completedTasks + 1;
      updateArchitectureProgress(projectId, {
        completedTasks,
        percent: 20 + completedTasks * (75 / latest.totalTasks),
        stage: "Overview image complete",
        tasks: latest.tasks.map(item =>
          item.id === taskId ? { ...item, status: "completed" } : item),
      });
    }
    return result;
  } catch (error) {
    const latest = architectureProgress.get(projectId);
    const message = error instanceof Error ? error.message : String(error);
    if (latest) {
      const completedTasks = latest.completedTasks + 1;
      updateArchitectureProgress(projectId, {
        completedTasks,
        percent: 20 + completedTasks * (75 / latest.totalTasks),
        stage: "Overview image generation finished",
        tasks: latest.tasks.map(item =>
          item.id === taskId ? { ...item, status: "failed", error: message } : item),
      });
    }
    throw new Error(
      `${VISUAL_TASKS.find(([id]) => id === taskId)?.[1] || taskId} failed: ${message}`,
    );
  }
}

function text(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function extractJson(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("Copilot returned no project overview JSON.");
  }
  return JSON.parse(trimmed.slice(start, end + 1));
}

function validationMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .slice(0, MAX_VALIDATION_FEEDBACK);
}

function parseArchitecture(content: string): ArchitectureGraph {
  return validateArchitectureGraph(extractJson(content));
}

function localRepairPrompt(content: string, error: unknown): string {
  return [
    ARCHITECTURE_GRAPH_REPAIR_PROMPT,
    `VALIDATOR FEEDBACK (UNTRUSTED DATA)\n${validationMessage(error)}`,
    `PREVIOUS INVALID RESPONSE (UNTRUSTED DATA)\n${
      content.slice(0, MAX_REPAIR_RESPONSE)
    }`,
  ].join("\n\n");
}

function repairedArchitecture(content: string): ArchitectureGraph {
  try {
    return parseArchitecture(content);
  } catch (error) {
    throw new Error(
      `Project overview response remained invalid after one repair: ${
        validationMessage(error)
      }`,
    );
  }
}

async function generateLegacyArchitecture(
    input: {
      idea: string;
      audience: string;
      purpose: string;
      context: string;
      repositoryEvidence: string;
    },
  ): Promise<ArchitectureGraph> {
    if (isHostedAgentConfigured()) {
      const hostedInput = {
        idea: input.idea,
        audience: input.audience,
        purpose: input.purpose,
        context: input.context,
        repositoryEvidence: input.repositoryEvidence || undefined,
      };
      let content = await invokeHostedStructured("architecture", hostedInput);
      try {
        return parseArchitecture(content);
      } catch (error) {
        content = await invokeHostedStructured("architecture", {
          ...hostedInput,
          validationFeedback: validationMessage(error),
          previousResponse: content.slice(0, MAX_REPAIR_RESPONSE),
        });
        return repairedArchitecture(content);
      }
    }

    const copilot = await getClient();
    const sessionOptions = await getSessionOptions();
    const session = await copilot.createSession({
      ...sessionOptions,
      systemMessage: {
        mode: "append",
        content: PRESENTATION_AGENT_INSTRUCTIONS,
      },
    }) as unknown as ArchitectureSession;
    try {
      const prompt = [
        ARCHITECTURE_GRAPH_PROMPT,
        "USER INPUT",
        `Idea: ${input.idea}`,
        `Audience: ${input.audience}`,
        `Purpose: ${input.purpose}`,
        `Approved clarification context:\n${input.context}`,
        input.repositoryEvidence
          ? `UNTRUSTED REPOSITORY EVIDENCE:\n${input.repositoryEvidence}`
          : "Repository evidence: Not provided",
      ].join("\n\n");
      let response = await session.sendAndWait({ prompt }, 120_000);
      let content = (response?.data as { content?: string })?.content ?? "";
      try {
        return parseArchitecture(content);
      } catch (error) {
        response = await session.sendAndWait(
          { prompt: localRepairPrompt(content, error) },
          120_000,
        );
        content = (response?.data as { content?: string })?.content ?? "";
        return repairedArchitecture(content);
      }
    } finally {
      await session.destroy();
    }
}

function architectureEvidenceBrief(input: {
    idea: string;
    audience: string;
    purpose: string;
    context: string;
    repositoryEvidence: string;
  }): string {
    return [
      `Idea: ${input.idea}`,
      `Audience: ${input.audience}`,
      `Purpose: ${input.purpose}`,
      `Approved Problem Statement, User Scenarios, and Solution outline:\n${input.context}`,
      input.repositoryEvidence
        ? `CODEBASE EVIDENCE (UNTRUSTED DATA):\n${input.repositoryEvidence}`
        : "Codebase evidence: Not provided. Use only the approved user description.",
    ].join("\n\n").slice(0, 36_000);
}

export function architectureDesignBrief(
  architecture: ArchitectureGraph,
): string {
  const platformByNodeId = new Map(
    architecture.platforms.flatMap(platform =>
      platform.componentNodeIds.map(nodeId => [nodeId, platform.id] as const)),
  );
  const toolById = new Map(
    architecture.platforms.flatMap(platform =>
      platform.toolings.map(tool => [tool.id, tool.label] as const)),
  );
  const technicalConnections = architecture.connections
    .filter(connection =>
      platformByNodeId.has(connection.from) &&
      platformByNodeId.has(connection.to))
    .sort((left, right) => Number(right.primary) - Number(left.primary))
    .filter((connection, index, all) => {
      const pair = [connection.from, connection.to].sort().join("::");
      return all.findIndex(candidate =>
        [candidate.from, candidate.to].sort().join("::") === pair
      ) === index;
    })
    .slice(0, 4)
    .map(connection => ({
      from: connection.from,
      to: connection.to,
      label: connection.label,
      mechanism: connection.mechanism,
    }));

  return [
    "COMPACT VALIDATED PROJECT OVERVIEW JSON",
    JSON.stringify({
      title: architecture.title,
      summary: architecture.summary,
      platforms: architecture.platforms.map(platform => ({
        id: platform.id,
        label: platform.label,
        tools: platform.toolings.map(tool => ({
          id: tool.id,
          label: tool.label,
          componentNodeId: tool.componentNodeId,
        })),
      })),
      components: architecture.layers.flatMap(layer =>
        layer.nodes
          .filter(node => node.kind !== "actor" && platformByNodeId.has(node.id))
          .map(node => ({
            id: node.id,
            label: node.label,
            kind: node.kind,
            platformId: platformByNodeId.get(node.id),
          }))),
      technicalConnections,
      workflow: {
        actor: architecture.workflow.actor,
        steps: architecture.workflow.steps.map(step => ({
          label: step.label,
          platforms: [...new Set(
            step.platformCalls.map(call => call.platformId),
          )],
          tools: [...new Set(
            step.platformCalls
              .map(call => toolById.get(call.toolingId))
              .filter((label): label is string => Boolean(label)),
          )],
        })),
      },
    }),
  ].join("\n");
}

function validatedArchitectureJsonBrief(
  architecture: ArchitectureGraph,
): string {
  return [
    "COMPLETE CANONICAL VALIDATED ARCHITECTURE JSON",
    JSON.stringify(architecture),
  ].join("\n");
}

async function generateArchitectureNarrative(input: {
  idea: string;
  audience: string;
  purpose: string;
  repositoryEvidence: string;
}): Promise<string> {
  if (isHostedAgentConfigured()) {
    return (await invokeHostedStructured("architecture-brief", {
      idea: input.idea,
      audience: input.audience,
      purpose: input.purpose,
      repositoryEvidence: input.repositoryEvidence || undefined,
    })).slice(0, 3_000);
  }
  const copilot = await getClient();
  const session = await copilot.createSession({
    ...(await getSessionOptions()),
    systemMessage: {
      mode: "append",
      content: PRESENTATION_AGENT_INSTRUCTIONS,
    },
  }) as unknown as ArchitectureSession;
  try {
    const result = await session.sendAndWait({
      prompt: [
        ARCHITECTURE_IMAGE_BRIEF_PROMPT,
        `USER DESCRIPTION\n${input.idea}`,
        `Audience: ${input.audience}`,
        `Purpose: ${input.purpose}`,
        input.repositoryEvidence
          ? `UNTRUSTED REPOSITORY EVIDENCE\n${input.repositoryEvidence}`
          : "Repository evidence: Not provided",
      ].join("\n\n"),
    }, 120_000);
    const narrative = text(
      (result?.data as { content?: string })?.content,
      3_000,
    );
    if (!narrative) {
      throw new Error("Copilot returned no project overview image narrative.");
    }
    return narrative;
  } finally {
    await session.destroy();
  }
}

function sanitizeArchitectureHtml(value: string): string {
  let sanitized = value.trim()
    .replace(/^```(?:html)?\s*/i, "")
    .replace(/\s*```$/, "");
  if (!/^<!doctype html>/i.test(sanitized) || sanitized.length > 120_000) {
    throw new Error("Copilot returned invalid project overview HTML.");
  }
  sanitized = sanitized
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<\/?script\b[^>]*>/gi, "")
    .replace(/<\s*(iframe|object|embed|form|button|textarea|select)\b[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, "")
    .replace(/<\s*(input|link|base)\b[^>]*\/?>/gi, "")
    .replace(/<meta\b[^>]*http-equiv[^>]*\/?>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+(?:href|src)\s*=\s*(?:"(?:https?:|data:|javascript:)[^"]*"|'(?:https?:|data:|javascript:)[^']*')/gi, "")
    .replace(/@import[^;]+;/gi, "")
    .replace(/url\s*\(\s*["']?\s*(?!#)[^)]+\)/gi, "none")
    .replace(/javascript:/gi, "");
  return sanitized;
}

const ARCHITECTURE_LAYOUT_GUARD = `<style id="architecture-layout-guard">
html,body{width:100%;height:100%;max-width:100%;overflow:hidden}
*,*::before,*::after{box-sizing:border-box}
body{margin:0}
[data-architecture-flow]{width:100%!important;max-width:100%!important;min-width:0!important;min-height:68vh!important}
[data-component]{width:auto!important;min-width:0!important;max-width:100%!important;overflow:hidden!important;overflow-wrap:anywhere!important}
[data-connector]{min-width:72px!important;min-height:38px!important;overflow:visible!important}
[data-direction="right"],[data-direction="left"],[data-direction="bidirectional"]{max-width:180px!important;max-height:80px!important;justify-self:center!important;align-self:center!important}
[data-direction="up"],[data-direction="down"]{max-width:240px!important;max-height:140px!important;justify-self:center!important;align-self:center!important}
[data-connector] .connector-label{max-width:none!important;overflow:visible!important;text-overflow:clip!important;white-space:normal!important;padding:4px 7px!important;border-radius:999px!important;background:#f8fafc!important;font-size:14px!important;line-height:1.2!important}
</style>`;

function applyArchitectureLayoutGuard(
  html: string,
  viewportLocked = false,
): string {
  const guarded = /<\/head\s*>/i.test(html)
    ? html.replace(/<\/head\s*>/i, `${ARCHITECTURE_LAYOUT_GUARD}</head>`)
    : html.replace(/<body\b/i, `${ARCHITECTURE_LAYOUT_GUARD}<body`);
  return viewportLocked
    ? applyArchitectureImageLayoutGuard(guarded)
    : guarded;
}

function validateArchitectureHtml(
  value: string,
  viewportLocked = false,
): string {
  const html = sanitizeArchitectureHtml(value);
  if (/<svg\b/i.test(html)) {
    throw new Error("Project overview HTML connectors must not use SVG.");
  }
  if (
    /position\s*:\s*(?:absolute|fixed)/i.test(html) ||
    /margin(?:-[a-z]+)?\s*:\s*-\d/i.test(html) ||
    /transform\s*:[^;}]*(?:translate|matrix)/i.test(html)
  ) {
    throw new Error("Project overview HTML connectors must use in-flow Grid/Flex cells.");
  }

  const componentIds = [...html.matchAll(
    /\bdata-component\s*=\s*["']([^"']+)["']/gi,
  )].map(match => match[1].trim());
  const componentSet = new Set(componentIds);
  if (!/\bdata-architecture-flow(?:\s*=\s*["'][^"']*["'])?/i.test(html)) {
    throw new Error("Project overview HTML requires one responsive flow container.");
  }
  const connectorTags = [...html.matchAll(
    /<[^>]+\bdata-connector(?:\s*=\s*["'][^"']*["'])?[^>]*>/gi,
  )].map(match => match[0]);
  if (connectorTags.length > 18) {
    throw new Error("Project overview HTML exceeds the 18-connector visual limit.");
  }
  for (const tag of connectorTags) {
    const from = tag.match(/\bdata-from\s*=\s*["']([^"']+)["']/i)?.[1]?.trim();
    const to = tag.match(/\bdata-to\s*=\s*["']([^"']+)["']/i)?.[1]?.trim();
    if (
      from &&
      to &&
      (from === to ||
        (componentSet.size > 0 &&
          (!componentSet.has(from) || !componentSet.has(to))))
    ) {
      throw new Error("Every project overview connector must reference two real components.");
    }
  }

  const labels = [...html.matchAll(
    /\bclass\s*=\s*["'][^"']*\bconnector-label\b[^"']*["']/gi,
  )];
  const arrows = [...html.matchAll(
    /\bclass\s*=\s*["'][^"']*\bconnector-arrow\b[^"']*["']/gi,
  )];
  void labels;
  void arrows;
  return applyArchitectureLayoutGuard(html, viewportLocked);
}

async function generateArchitectureHtml(input: {
  idea: string;
  audience: string;
  purpose: string;
  context: string;
  repositoryEvidence: string;
}, referenceImage?: Uint8Array): Promise<string> {
  const operation = referenceImage
    ? "architecture-image-html"
    : "architecture-html";
  const basePrompt = referenceImage
    ? ARCHITECTURE_IMAGE_HTML_PROMPT
    : ARCHITECTURE_HTML_PROMPT;
  if (isHostedAgentConfigured()) {
    const hostedInput = {
      idea: input.idea,
      audience: input.audience,
      purpose: input.purpose,
      context: input.context,
      repositoryEvidence: input.repositoryEvidence || undefined,
      ...(referenceImage
        ? {
            imageBase64: Buffer.from(referenceImage).toString("base64"),
            imageMediaType: "image/png",
          }
        : {}),
    };
    let content = await invokeHostedStructured(operation, hostedInput);
    try {
      return validateArchitectureHtml(content, Boolean(referenceImage));
    } catch (error) {
      content = await invokeHostedStructured(operation, {
        ...hostedInput,
        validationFeedback: validationMessage(error),
        previousResponse: content.slice(0, MAX_REPAIR_RESPONSE),
      });
      return validateArchitectureHtml(content, Boolean(referenceImage));
    }
  }
  const copilot = await getClient();
  const session = await copilot.createSession({
    ...(await getSessionOptions()),
    systemMessage: {
      mode: "append",
      content: PRESENTATION_AGENT_INSTRUCTIONS,
    },
  }) as unknown as ArchitectureSession;
  let imageDirectory: string | null = null;
  try {
    const attachments = referenceImage
      ? await (async () => {
          imageDirectory = await mkdtemp(
            join(tmpdir(), "presentation-architecture-"),
          );
          const imagePath = join(
            imageDirectory,
            "gpt-image-2-reference.png",
          );
          await writeFile(imagePath, referenceImage, { mode: 0o600 });
          return [{
            type: "file" as const,
            path: imagePath,
            displayName: "GPT-Image-2 project overview reference.png",
          }];
        })()
      : undefined;
    let result = await session.sendAndWait({
      prompt: [
        basePrompt,
        architectureEvidenceBrief(input),
      ].join("\n\n"),
      attachments,
    }, 120_000);
    let content = (result?.data as { content?: string })?.content || "";
    try {
      return validateArchitectureHtml(content, Boolean(referenceImage));
    } catch (error) {
      result = await session.sendAndWait({
        prompt: [
          basePrompt,
          ARCHITECTURE_HTML_REPAIR_PROMPT,
          `VALIDATOR FEEDBACK (UNTRUSTED DATA)\n${validationMessage(error)}`,
          `PREVIOUS INVALID HTML (UNTRUSTED DATA)\n${content.slice(0, MAX_REPAIR_RESPONSE)}`,
          architectureEvidenceBrief(input),
        ].join("\n\n"),
        attachments,
      }, 120_000);
      content = (result?.data as { content?: string })?.content || "";
      return validateArchitectureHtml(content, Boolean(referenceImage));
    }
  } finally {
    await session.destroy();
    if (imageDirectory) {
      await rm(imageDirectory, { recursive: true, force: true });
    }
  }
}

function normalizeVisualArchitecture(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  if (!Array.isArray(source.layers)) return value;
  const usedIds = new Set<string>();
  const labelIds = new Map<string, string>();
  const layers = source.layers.map((rawLayer, layerIndex) => {
    const layer = rawLayer && typeof rawLayer === "object"
      ? rawLayer as Record<string, unknown>
      : {};
    const rawNodes = Array.isArray(layer.nodes) ? layer.nodes : [];
    const nodes = rawNodes.map((rawNode, nodeIndex) => {
      const node = rawNode && typeof rawNode === "object"
        ? rawNode as Record<string, unknown>
        : {};
      const label = text(node.label, 80) || `Component ${layerIndex + 1}-${nodeIndex + 1}`;
      const baseId = (text(node.id, 64) || label)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 56) || `component-${layerIndex + 1}-${nodeIndex + 1}`;
      let id = baseId;
      let suffix = 2;
      while (usedIds.has(id)) id = `${baseId}-${suffix++}`;
      usedIds.add(id);
      labelIds.set(label.toLowerCase(), id);
      labelIds.set(text(node.id, 64).toLowerCase(), id);
      const kind = text(node.kind, 20);
      const provenance = text(node.provenance, 20);
      return {
        ...node,
        id,
        label,
        description: text(node.description, 180) || `High-level ${label} component.`,
        kind: NODE_KINDS.has(kind) ? kind : "service",
        technology: text(node.technology, 100) || "Technology not specified",
        provenance: PROVENANCE.has(provenance) ? provenance : "assumed",
      };
    });
    const tone = text(layer.tone, 20);
    return {
      ...layer,
      id: text(layer.id, 64) || `layer-${layerIndex + 1}`,
      label: text(layer.label, 80) || `Layer ${layerIndex + 1}`,
      purpose: text(layer.purpose, 180) || "Groups related high-level components.",
      tone: TONES.has(tone) ? tone : "blue",
      nodes,
    };
  });
  const rawConnections = Array.isArray(source.connections) ? source.connections : [];
  const hasPrimary = rawConnections.some(raw =>
    raw && typeof raw === "object" &&
    (raw as Record<string, unknown>).primary === true);
  const resolveNodeId = (value: unknown) => {
    const candidate = text(value, 80);
    return usedIds.has(candidate)
      ? candidate
      : labelIds.get(candidate.toLowerCase()) || candidate;
  };
  const connections = rawConnections.map((rawConnection, index) => {
    const connection = rawConnection && typeof rawConnection === "object"
      ? rawConnection as Record<string, unknown>
      : {};
    const type = text(connection.type, 20);
    const provenance = text(connection.provenance, 20);
    return {
      ...connection,
      from: resolveNodeId(connection.from),
      to: resolveNodeId(connection.to),
      label: text(connection.label, 100) || "connects to",
      type: CONNECTION_TYPES.has(type) ? type : "request",
      mechanism: text(connection.mechanism, 80) || "visual interaction",
      payload: text(connection.payload, 120) || "project overview data",
      provenance: PROVENANCE.has(provenance) ? provenance : "assumed",
      primary: typeof connection.primary === "boolean"
        ? connection.primary || (!hasPrimary && index === 0)
        : index === 0,
    };
  });
  const platformNodeIds = layers
    .flatMap(layer => layer.nodes)
    .filter(node => node.kind !== "actor")
    .map(node => node.id);
  const rawPlatforms = Array.isArray(source.platforms) ? source.platforms : [];
  const platforms = rawPlatforms.length > 0
    ? rawPlatforms.map((rawPlatform, platformIndex) => {
        const platform = rawPlatform && typeof rawPlatform === "object"
          ? rawPlatform as Record<string, unknown>
          : {};
        const rawComponentNodeIds = Array.isArray(platform.componentNodeIds)
          ? platform.componentNodeIds
          : [];
        return {
          id: text(platform.id, 64) || `platform-${platformIndex + 1}`,
          label: text(platform.label, 80) || `Platform ${platformIndex + 1}`,
          description: text(platform.description, 160) || "Hosts related runtime components.",
          technology: text(platform.technology, 100) || "Platform not specified",
          componentNodeIds: rawComponentNodeIds
            .map(resolveNodeId)
            .filter(nodeId => platformNodeIds.includes(nodeId)),
          provenance: PROVENANCE.has(text(platform.provenance, 20))
            ? text(platform.provenance, 20)
            : "assumed",
        };
      })
    : layers.map((layer, platformIndex) => ({
        id: `platform-${platformIndex + 1}`,
        label: layer.label,
        description: layer.purpose,
        technology: "Platform not specified",
        componentNodeIds: layer.nodes
          .filter(node => node.kind !== "actor")
          .map(node => node.id),
        provenance: "assumed",
      })).filter(platform => platform.componentNodeIds.length > 0);
  const rawWorkflow = source.workflow && typeof source.workflow === "object"
    ? source.workflow as Record<string, unknown>
    : {};
  const rawSteps = Array.isArray(rawWorkflow.steps) ? rawWorkflow.steps : [];
  const fallbackSteps = connections.slice(0, 6).map((connection, index) => ({
    id: `step-${index + 1}`,
    order: index + 1,
    label: connection.label,
    userAction: connection.label,
    platformCalls: [{
      nodeId: platformNodeIds.includes(connection.to)
        ? connection.to
        : platformNodeIds[0],
      action: connection.label,
      mechanism: connection.mechanism,
      output: connection.payload,
    }],
  }));
  while (fallbackSteps.length < 2 && platformNodeIds.length > 0) {
    const index = fallbackSteps.length;
    const nodeId = platformNodeIds[Math.min(index, platformNodeIds.length - 1)];
    fallbackSteps.push({
      id: `step-${index + 1}`,
      order: index + 1,
      label: index === 0 ? "Submit request" : "Review result",
      userAction: index === 0 ? "Submit the workflow request." : "Review the platform result.",
      platformCalls: [{
        nodeId,
        action: index === 0 ? "accept request" : "return result",
        mechanism: "application interaction",
        output: index === 0 ? "validated request" : "workflow result",
      }],
    });
  }
  const workflow = {
    actor: text(rawWorkflow.actor, 80) || "User",
    goal: text(rawWorkflow.goal, 180) || text(source.summary, 180) ||
      "Complete the project overview workflow.",
    steps: rawSteps.length > 0 ? rawSteps : fallbackSteps,
  };
  return {
    ...source,
    title: text(source.title, 120) || "Project Overview",
    summary: text(source.summary, 300) || "Image-generated high-level project overview.",
    layers,
    platforms,
    workflow,
    connections,
    assumptions: Array.isArray(source.assumptions) ? source.assumptions : [],
  };
}

export function validateArchitectureGraph(value: unknown): ArchitectureGraph {
  if (!value || typeof value !== "object") {
    throw new Error("Project overview response must be an object.");
  }
  const source = value as Record<string, unknown>;
  if (!Array.isArray(source.layers) || source.layers.length < 2 || source.layers.length > 4) {
    throw new Error("Project overview must contain between 2 and 4 high-level layers.");
  }

  const nodeIds = new Set<string>();
  let nodeCount = 0;
  const layers = source.layers.map((rawLayer, layerIndex) => {
    if (!rawLayer || typeof rawLayer !== "object") {
      throw new Error(`Layer ${layerIndex + 1} is invalid.`);
    }
    const layer = rawLayer as Record<string, unknown>;
    if (!Array.isArray(layer.nodes) || layer.nodes.length < 1 || layer.nodes.length > 3) {
      throw new Error(`Layer ${layerIndex + 1} must contain between 1 and 3 high-level components.`);
    }
    const nodes = layer.nodes.map((rawNode, nodeIndex) => {
      if (!rawNode || typeof rawNode !== "object") {
        throw new Error(`Node ${nodeIndex + 1} in layer ${layerIndex + 1} is invalid.`);
      }
      const node = rawNode as Record<string, unknown>;
      const id = text(node.id, 64);
      const label = text(node.label, 80);
      const kind = text(node.kind, 20);
      const description = text(node.description, 180);
      const technology = text(node.technology, 100);
      const provenance = text(node.provenance, 20);
      if (
        !id ||
        !label ||
        !description ||
        !technology ||
        nodeIds.has(id) ||
        !NODE_KINDS.has(kind) ||
        !PROVENANCE.has(provenance)
      ) {
        throw new Error(`Node ${nodeIndex + 1} in layer ${layerIndex + 1} has invalid fields.`);
      }
      nodeIds.add(id);
      nodeCount += 1;
      return {
        id,
        label,
        description,
        kind: kind as ArchitectureNode["kind"],
        technology,
        provenance: provenance as ArchitectureNode["provenance"],
        evidencePaths: Array.isArray(node.evidencePaths)
          ? node.evidencePaths.map(item => text(item, 180)).filter(Boolean).slice(0, 8)
          : [],
      };
    });
    const tone = text(layer.tone, 20);
    return {
      id: text(layer.id, 64) || `layer-${layerIndex + 1}`,
      label: text(layer.label, 80) || `Layer ${layerIndex + 1}`,
      purpose: text(layer.purpose, 180),
      tone: (TONES.has(tone) ? tone : "blue") as ArchitectureLayer["tone"],
      nodes,
    };
  });

  if (nodeCount > 8) {
    throw new Error("Project overview exceeds the 8-component simplicity limit.");
  }
  const rawPlatforms = Array.isArray(source.platforms) ? source.platforms : [];
  if (rawPlatforms.length < 1 || rawPlatforms.length > 4) {
    throw new Error("Project overview must contain 1-4 runtime platforms.");
  }
  const platformIds = new Set<string>();
  const toolingIds = new Set<string>();
  const assignedComponentIds = new Set<string>();
  const platforms = rawPlatforms.map((rawPlatform, platformIndex) => {
    if (!rawPlatform || typeof rawPlatform !== "object") {
      throw new Error(`Platform ${platformIndex + 1} is invalid.`);
    }
    const platform = rawPlatform as Record<string, unknown>;
    const id = text(platform.id, 64);
    const label = text(platform.label, 80);
    const description = text(platform.description, 160);
    const technology = text(platform.technology, 100);
    const provenance = text(platform.provenance, 20);
    const componentNodeIds = Array.isArray(platform.componentNodeIds)
      ? platform.componentNodeIds.map(nodeId => text(nodeId, 64)).filter(Boolean)
      : [];
    if (
      !id ||
      platformIds.has(id) ||
      !label ||
      !description ||
      !technology ||
      !PROVENANCE.has(provenance) ||
      componentNodeIds.length < 1 ||
      componentNodeIds.length > 6
    ) {
      throw new Error(`Platform ${platformIndex + 1} has invalid fields.`);
    }
    for (const nodeId of componentNodeIds) {
      if (!nodeIds.has(nodeId) || assignedComponentIds.has(nodeId)) {
        throw new Error(
          `Platform ${platformIndex + 1} must contain unique, real component node IDs.`,
        );
      }
      assignedComponentIds.add(nodeId);
    }
    const toolingCandidates = Array.isArray(platform.toolings)
      ? platform.toolings
      : [];
    if (toolingCandidates.length < 1 || toolingCandidates.length > 6) {
      throw new Error(`Platform ${platformIndex + 1} requires 1-6 important toolings.`);
    }
    const toolings = toolingCandidates.map((rawTooling, toolingIndex) => {
      if (!rawTooling || typeof rawTooling !== "object") {
        throw new Error(`Tooling ${toolingIndex + 1} in platform ${platformIndex + 1} is invalid.`);
      }
      const tooling = rawTooling as Record<string, unknown>;
      const toolingId = text(tooling.id, 64);
      const toolingLabel = text(tooling.label, 80);
      const toolingDescription = text(tooling.description, 160);
      const toolingTechnology = text(tooling.technology, 100);
      const componentNodeId = text(tooling.componentNodeId, 64);
      if (
        !toolingId ||
        toolingIds.has(toolingId) ||
        !toolingLabel ||
        !toolingDescription ||
        !toolingTechnology ||
        !componentNodeIds.includes(componentNodeId)
      ) {
        throw new Error(
          `Tooling ${toolingIndex + 1} in platform ${platformIndex + 1} must be unique and reference a component hosted by that platform.`,
        );
      }
      toolingIds.add(toolingId);
      return {
        id: toolingId,
        label: toolingLabel,
        description: toolingDescription,
        technology: toolingTechnology,
        componentNodeId,
      };
    });
    platformIds.add(id);
    return {
      id,
      label,
      description,
      technology,
      componentNodeIds,
      toolings,
      provenance: provenance as "confirmed" | "assumed",
    };
  });
  const unassignedComponents = layers
    .flatMap(layer => layer.nodes)
    .filter(node => node.kind !== "actor" && !assignedComponentIds.has(node.id));
  if (unassignedComponents.length > 0) {
    throw new Error(
      `Every non-actor component must belong to one platform: ${
        unassignedComponents.map(node => node.label).join(", ")
      }.`,
    );
  }
  const platformByNodeId = new Map(
    platforms.flatMap(platform =>
      platform.componentNodeIds.map(nodeId => [nodeId, platform] as const)),
  );
  const toolingById = new Map(
    platforms.flatMap(platform =>
      platform.toolings.map(tooling => [
        tooling.id,
        { platform, tooling },
      ] as const)),
  );

  const rawConnections = Array.isArray(source.connections) ? source.connections : [];
  if (rawConnections.length === 0) {
    throw new Error("Project overview must contain labeled component interactions.");
  }
  if (rawConnections.length > 10) {
    throw new Error("Project overview exceeds the 10-connection simplicity limit.");
  }
  const connections = rawConnections.map((rawConnection, index) => {
    if (!rawConnection || typeof rawConnection !== "object") {
      throw new Error(`Connection ${index + 1} is invalid.`);
    }
    const connection = rawConnection as Record<string, unknown>;
    const from = text(connection.from, 64);
    const to = text(connection.to, 64);
    if (!nodeIds.has(from) || !nodeIds.has(to)) {
      throw new Error(`Connection ${index + 1} references an unknown node.`);
    }
    const label = text(connection.label, 100);
    const type = text(connection.type, 20);
    const mechanism = text(connection.mechanism, 80);
    const payload = text(connection.payload, 120);
    const provenance = text(connection.provenance, 20);
    if (
      !label ||
      !CONNECTION_TYPES.has(type) ||
      !mechanism ||
      !payload ||
      !PROVENANCE.has(provenance) ||
      typeof connection.primary !== "boolean"
    ) {
      throw new Error(`Connection ${index + 1} requires a technical interaction label.`);
    }
    return {
      from,
      to,
      label,
      type: type as ArchitectureGraph["connections"][number]["type"],
      mechanism,
      payload,
      provenance: provenance as ArchitectureGraph["connections"][number]["provenance"],
      primary: connection.primary,
      evidencePaths: Array.isArray(connection.evidencePaths)
        ? connection.evidencePaths.map(item => text(item, 180)).filter(Boolean).slice(0, 8)
        : [],
    };
  });

  const connectedNodeIds = new Set(connections.flatMap(connection => [
    connection.from,
    connection.to,
  ]));
  const disconnected = layers
    .flatMap(layer => layer.nodes)
    .filter(node => node.kind !== "actor" && !connectedNodeIds.has(node.id));
  if (disconnected.length > 0) {
    throw new Error(
      `Technical components must be connected: ${disconnected.map(node => node.label).join(", ")}.`,
    );
  }
  if (!connections.some(connection => connection.primary)) {
    throw new Error("Project overview must identify at least one primary interaction.");
  }

  const rawWorkflow = source.workflow;
  if (!rawWorkflow || typeof rawWorkflow !== "object") {
    throw new Error("Project overview must include a user workflow.");
  }
  const workflowSource = rawWorkflow as Record<string, unknown>;
  const actor = text(workflowSource.actor, 80);
  const goal = text(workflowSource.goal, 180);
  const rawSteps = Array.isArray(workflowSource.steps) ? workflowSource.steps : [];
  if (!actor || !goal || rawSteps.length < 2 || rawSteps.length > 7) {
    throw new Error("User workflow requires an actor, goal, and 2-7 consolidated steps.");
  }
  const workflowStepIds = new Set<string>();
  const workflow = {
    actor,
    goal,
    steps: rawSteps.map((rawStep, index) => {
      if (!rawStep || typeof rawStep !== "object") {
        throw new Error(`Workflow step ${index + 1} is invalid.`);
      }
      const step = rawStep as Record<string, unknown>;
      const id = text(step.id, 64);
      const label = text(step.label, 80);
      const userAction = text(step.userAction, 160);
      if (
        !id ||
        workflowStepIds.has(id) ||
        step.order !== index + 1 ||
        !label ||
        !userAction
      ) {
        throw new Error(`Workflow step ${index + 1} requires a unique ID, contiguous order, label, and user action.`);
      }
      workflowStepIds.add(id);
      const rawPlatformCalls = Array.isArray(step.platformCalls)
        ? step.platformCalls
        : [];
      if (rawPlatformCalls.length < 1 || rawPlatformCalls.length > 2) {
        throw new Error(`Workflow step ${index + 1} requires 1-2 platform calls.`);
      }
      const platformCalls = rawPlatformCalls.map((rawCall, callIndex) => {
        if (!rawCall || typeof rawCall !== "object") {
          throw new Error(`Platform call ${callIndex + 1} in workflow step ${index + 1} is invalid.`);
        }
        const call = rawCall as Record<string, unknown>;
        const nodeId = text(call.nodeId, 64);
        const inferredPlatform = platformByNodeId.get(nodeId);
        const platformId = text(call.platformId, 64);
        const toolingId = text(call.toolingId, 64);
        const action = text(call.action, 100);
        const mechanism = text(call.mechanism, 80);
        const output = text(call.output, 120);
        const toolingReference = toolingById.get(toolingId);
        if (
          !nodeIds.has(nodeId) ||
          !platformIds.has(platformId) ||
          inferredPlatform?.id !== platformId ||
          toolingReference?.platform.id !== platformId ||
          toolingReference?.tooling.componentNodeId !== nodeId ||
          !action ||
          !mechanism ||
          !output
        ) {
          throw new Error(
            `Platform call ${callIndex + 1} in workflow step ${index + 1} must reference a real platform, tooling, and component, then describe action, mechanism, and output.`,
          );
        }
        return { platformId, toolingId, nodeId, action, mechanism, output };
      });
      return {
        id,
        order: index + 1,
        label,
        userAction,
        platformCalls,
      };
    }),
  };

  const assumptions = Array.isArray(source.assumptions)
    ? source.assumptions.map((item) => text(item, 240)).filter(Boolean).slice(0, 8)
    : [];

  return {
    title: text(source.title, 120) || "Project Overview",
    summary: text(source.summary, 300),
    layers,
    platforms,
    workflow,
    connections,
    assumptions,
  };
}

router.post("/architecture", async (req, res) => {
  const {
    idea,
    audience,
    purpose,
    context,
    projectId,
    generateVisuals,
    visualMode,
  } = req.body as {
    idea?: unknown;
    audience?: unknown;
    purpose?: unknown;
    context?: unknown;
    projectId?: unknown;
    generateVisuals?: unknown;
    visualMode?: unknown;
  };

  if (typeof idea !== "string" || !idea.trim()) {
    res.status(400).json({ error: "'idea' must be a non-empty string" });
    return;
  }
  if (idea.length > 12000) {
    res.status(413).json({ error: "'idea' exceeds maximum length of 12000 characters" });
    return;
  }
  if (context !== undefined && typeof context !== "string") {
    res.status(400).json({ error: "'context' must be a string when provided" });
    return;
  }
  if (typeof context === "string" && context.length > 20000) {
    res.status(413).json({ error: "'context' exceeds maximum length of 20000 characters" });
    return;
  }
  if (generateVisuals !== undefined && typeof generateVisuals !== "boolean") {
    res.status(400).json({ error: "'generateVisuals' must be a boolean when provided" });
    return;
  }
  if (
    visualMode !== undefined &&
    (typeof visualMode !== "string" ||
      !VISUAL_MODES.has(visualMode as ArchitectureVisualMode))
  ) {
    res.status(400).json({ error: "'visualMode' must name a supported project overview visual" });
    return;
  }
  const project = projectId === undefined
    ? null
    : isProjectId(projectId)
      ? await getProject(projectId)
      : null;
  if (project && generateVisuals !== false) {
    startArchitectureProgress(project.id);
  }
  if (projectId !== undefined && !project) {
    res.status(isProjectId(projectId) ? 404 : 400).json({
      error: isProjectId(projectId)
        ? "Presentation project not found."
        : "Invalid presentation project ID.",
    });
    return;
  }
  if (project) {
    const outlineAssetId = project.currentAssets.outline;
    const storedOutline = outlineAssetId
      ? await readProjectAsset(project.id, outlineAssetId)
      : null;
    const outline = storedOutline
      ? JSON.parse(storedOutline.content) as { status?: unknown }
      : null;
    if (outline?.status !== "approved") {
      res.status(409).json({
        error: "An approved outline is required before overview generation.",
      });
      return;
    }
  }

  try {
    const repositoryEvidence = await repositoryPromptContext(project?.id);
    const generationInput = {
      idea: idea.trim(),
      audience: text(audience, 200) || "Not specified",
      purpose: text(purpose, 300) || "Not specified",
      context: text(context, 20000) || "Not provided",
      repositoryEvidence,
    };
    const architecture = await generateLegacyArchitecture(generationInput);
    if (project && generateVisuals !== false) {
      updateArchitectureProgress(project.id, {
        stage: "Validated overview complete; generating image",
        percent: 20,
      });
    }
    let visual: ArchitectureVisual = { mode: "legacy" };
    let htmlAssetId: string | null = null;
    let validatedJsonHtmlAssetId: string | null = null;
    let imageDerivedHtmlAssetId: string | null = null;
    let narrativeHtmlAssetId: string | null = null;
    let imageAssetId: string | null = null;
    let narrativeImageAssetId: string | null = null;
    if (
      project &&
      generateVisuals !== false &&
      isArchitectureImageConfigured()
    ) {
      const imageConfiguration = architectureImageConfiguration();
      const results = await Promise.allSettled([
        runVisualTask(
          project.id,
          "validated-json-image",
          () => generateArchitectureImage(architectureDesignBrief(architecture)),
        ),
      ]);
      const resultValue = <T,>(index: number): T | null =>
        results[index].status === "fulfilled"
          ? results[index].value as T
          : null;
      const html = null;
      const validatedJsonHtml = null;
      const narrativeHtml = null;
      const image = resultValue<Uint8Array>(0);
      const imageDerivedHtml = null;
      const narrativeImage = null;
      const failures = results.flatMap((result, index) =>
        result.status === "rejected"
          ? [{
              mode: VISUAL_TASKS[index][0],
              error: result.reason instanceof Error
                ? result.reason.message
                : String(result.reason),
            }]
          : []);
      if (failures.length === results.length) {
        throw new Error(
          `All architecture visual options failed: ${
            failures.map(failure => failure.error).join("; ")
          }`,
        );
      }
      updateArchitectureProgress(project.id, {
        stage: "Saving overview image",
        percent: 95,
      });
      await clearCurrentProjectAssets(project.id, [
        "architecture-html",
        "architecture-validated-json-html",
        "architecture-image-derived-html",
        "architecture-narrative-html",
        "architecture-image",
        "architecture-pptx",
        "architecture-pptx-preview",
        "architecture-narrative-image",
        "architecture-layout",
      ]);
      if (html) {
        const storedHtml = await storeProjectTextAsset(
          project.id,
          "architecture-html",
          "html",
          html,
          currentSourceAssetIds(project, ["brief", "repository-evidence", "outline"]),
          { renderer: "copilot-html-css", sandboxed: true },
        );
        htmlAssetId = storedHtml.asset.id;
      }
      if (validatedJsonHtml) {
        const storedHtml = await storeProjectTextAsset(
          project.id,
          "architecture-validated-json-html",
          "html",
          validatedJsonHtml,
          currentSourceAssetIds(project, ["brief", "repository-evidence", "outline"]),
          { renderer: "copilot-html-css", source: "validated-json", sandboxed: true },
        );
        validatedJsonHtmlAssetId = storedHtml.asset.id;
      }
      if (imageDerivedHtml) {
        const storedHtml = await storeProjectTextAsset(
          project.id,
          "architecture-image-derived-html",
          "html",
          imageDerivedHtml,
          currentSourceAssetIds(project, ["brief", "repository-evidence", "outline"]),
          {
            renderer: "copilot-html-css",
            source: "gpt-image-2-direct-copilot-attachment",
            imageDeployment: imageConfiguration.deployment,
            sandboxed: true,
          },
        );
        imageDerivedHtmlAssetId = storedHtml.asset.id;
      }
      if (narrativeHtml) {
        const storedHtml = await storeProjectTextAsset(
          project.id,
          "architecture-narrative-html",
          "html",
          narrativeHtml,
          currentSourceAssetIds(project, ["brief", "repository-evidence", "outline"]),
          { renderer: "copilot-html-css", source: "agent-narrative", sandboxed: true },
        );
        narrativeHtmlAssetId = storedHtml.asset.id;
      }
      if (image) {
        const storedImage = await storeProjectBinaryAsset(
          project.id,
          "architecture-image",
          "png",
          image,
          currentSourceAssetIds(project, ["brief", "repository-evidence", "outline"]),
          {
            renderer: "foundry-image-model",
            designed: true,
            deployment: imageConfiguration.deployment,
            width: imageConfiguration.width,
            height: imageConfiguration.height,
          },
        );
        imageAssetId = storedImage.asset.id;
      }
      if (narrativeImage) {
        const storedImage = await storeProjectBinaryAsset(
          project.id,
          "architecture-narrative-image",
          "png",
          narrativeImage,
          currentSourceAssetIds(project, ["brief", "repository-evidence"]),
          {
            renderer: "foundry-image-model",
            designed: true,
            source: "agent-narrative",
            deployment: imageConfiguration.deployment,
            width: imageConfiguration.width,
            height: imageConfiguration.height,
          },
        );
        narrativeImageAssetId = storedImage.asset.id;
      }
      visual = {
        mode: "image",
        ...(imageAssetId
          ? { imageUrl: `/projects/${project.id}/architecture/image` }
          : {}),
        pptxDownloadUrl:
          `/projects/${project.id}/architecture/download.pptx`,
        pptxGenerateUrl:
          `/projects/${project.id}/architecture/generate-editable-pptx`,
      };
    } else if (project) {
      await clearCurrentProjectAssets(project.id, [
        "architecture-html",
        "architecture-validated-json-html",
        "architecture-image-derived-html",
        "architecture-narrative-html",
        "architecture-image",
        "architecture-pptx",
        "architecture-pptx-preview",
        "architecture-narrative-image",
        "architecture-layout",
      ]);
      if (generateVisuals !== false) {
        visual = {
          mode: "legacy",
          fallbackReason:
            "Image generation is not configured; showing the validated overview.",
        };
        updateArchitectureProgress(project.id, {
          stage: "Validated overview is ready",
          percent: 95,
          completedTasks: 0,
          totalTasks: 0,
          tasks: [],
        });
      }
    }
    const stored = project
      ? await storeProjectJsonAsset(
          project.id,
          "architecture",
          architecture,
          currentSourceAssetIds(project, ["brief", "repository-evidence", "outline"]),
          {
            title: architecture.title,
            layerCount: architecture.layers.length,
            componentCount: architecture.layers.reduce(
              (count, layer) => count + layer.nodes.length,
              0,
            ),
            interactionCount: architecture.connections.length,
            assumptionCount:
              architecture.layers.flatMap(layer => layer.nodes)
                .filter(node => node.provenance === "assumed").length +
              architecture.connections.filter(
                connection => connection.provenance === "assumed",
              ).length,
            visualMode: visual.mode,
            htmlAssetId,
            validatedJsonHtmlAssetId,
            imageDerivedHtmlAssetId,
            narrativeHtmlAssetId,
            imageAssetId,
            narrativeImageAssetId,
          },
        )
      : null;
    if (project) {
      await clearCurrentProjectAssets(project.id, [
        "slide-model",
        "slide-deck",
        "slide-deck-pptx",
        ...Object.keys(project.currentAssets)
          .filter(type => type.startsWith("slide-image-")) as `slide-image-${string}`[],
        "speech-script",
      ]);
    }
    if (project && generateVisuals !== false) {
      const currentProgress = architectureProgress.get(project.id);
      const failedCount = currentProgress?.tasks.filter(
        task => task.status === "failed",
      ).length || 0;
      updateArchitectureProgress(project.id, {
        status: "completed",
        stage: visual.mode === "legacy"
          ? "Validated overview is ready"
          : failedCount > 0
            ? `${VISUAL_TASKS.length - failedCount}/${VISUAL_TASKS.length} designs ready; ${failedCount} failed`
            : "Overview image is ready",
        percent: 100,
        ...(failedCount > 0
          ? {
              error: currentProgress?.tasks
                .filter(task => task.status === "failed")
                .map(task => `${task.label}: ${task.error}`)
                .join(" | "),
            }
          : {}),
      });
    }
    res.json({ architecture, visual, asset: stored?.asset });
  } catch (error) {
    const enhanced = enhanceModelError(error);
    if (project && generateVisuals !== false) {
      updateArchitectureProgress(project.id, {
        status: "failed",
        stage: "Overview generation failed",
        percent: 100,
        error: enhanced.message,
      });
    }
    res.status(500).json({ error: enhanced.message });
  }
});

router.get("/projects/:projectId/architecture/progress", (req, res) => {
  const progress = architectureProgress.get(req.params.projectId);
  res.json(progress || {
    status: "idle",
    stage: "No overview generation is running",
    percent: 0,
    completedTasks: 0,
    totalTasks: VISUAL_TASKS.length,
    tasks: VISUAL_TASKS.map(([id, label]) => ({
      id,
      label,
      status: "pending",
    })),
  });
});

router.get("/projects/:projectId/architecture/image", async (req, res) => {
  const project = await getProject(req.params.projectId);
  const assetId = project?.currentAssets["architecture-image"];
  const stored = assetId
    ? await readProjectBinaryAsset(req.params.projectId, assetId)
    : null;
  if (!stored) {
    res.status(404).json({ error: "Generated project overview image not found." });
    return;
  }
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "private, max-age=300");
  res.send(Buffer.from(stored.content));
});

function appendEditablePptLog(
  job: EditablePptGatewayJob,
  message: string,
): void {
  job.logs.push(`${new Date().toISOString()} ${message}`);
  job.logs = job.logs.slice(-100);
}

async function startUploadedImageToPptx(req: Request, res: Response) {
    if (!isHostedAgentConfigured()) {
      res.status(503).json({
        error:
          "The image-to-editable-ppt skill runner is not deployed. " +
          "Configure PRESENTATION_AGENT_INVOCATIONS_ENDPOINT.",
      });
      return;
    }
    const sourceImage = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.alloc(0);
    if (
      sourceImage.length < 8 ||
      !sourceImage.subarray(0, 8).equals(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      )
    ) {
      res.status(400).json({ error: "Upload a valid PNG image." });
      return;
    }
    const sourceImageSha256 = createHash("sha256")
      .update(sourceImage)
      .digest("hex");
    try {
      const source = {
        sourceAssetId: `quick-test-${sourceImageSha256}`,
        sourceImageBase64: sourceImage.toString("base64"),
        sourceImageSha256,
      };
      const startResponse = await invokeHostedAgent(
        "start-images-to-editable-ppt",
        {
          projectId: "editable-ppt",
          sourceImages: [source],
        },
        randomUUID(),
        60_000,
      );
      const started = await startResponse.json() as EditablePptSkillPayload;
      const jobId =
        typeof started.jobId === "string" ? started.jobId.trim() : "";
      const sessionId =
        startResponse.headers.get("x-agent-session-id") || "";
      if (!jobId || started.status !== "running" || !sessionId) {
        throw new Error("Skill runner did not start an editable PPT job.");
      }
      const gatewayJobId = randomUUID();
      const job: EditablePptGatewayJob = {
        remoteJobId: jobId,
        sessionId,
        sourceImageSha256,
        startedAt: new Date().toISOString(),
        logs: [],
        status: "running",
      };
      appendEditablePptLog(job, "Upload accepted; source SHA-256 verified.");
      appendEditablePptLog(job, `Foundry job ${jobId} started.`);
      editablePptGatewayJobs.set(gatewayJobId, job);
      res.status(202).json({
        jobId: gatewayJobId,
        status: job.status,
        statusUrl: `/editable-pptx/${gatewayJobId}`,
        logs: job.logs,
      });
    } catch (error) {
      res.status(502).json({
        error:
          error instanceof Error
            ? `image-to-editable-ppt skill invocation failed: ${error.message}`
            : "image-to-editable-ppt skill invocation failed.",
      });
    }
}

router.post(
  "/editable-pptx",
  raw({ type: "image/png", limit: "10mb" }),
  startUploadedImageToPptx,
);

router.get("/editable-pptx/:jobId", async (req, res) => {
  const job = editablePptGatewayJobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "Editable PPT job not found." });
    return;
  }
  if (job.status === "failed") {
    res.status(502).json({ status: job.status, error: job.error, logs: job.logs });
    return;
  }
  if (job.status === "completed") {
    res.json({
      status: job.status,
      logs: job.logs,
      invocationId: job.invocationId,
      runId: job.runId,
      sourceImageSha256: job.sourceImageSha256,
      downloadUrl: `/editable-pptx/${req.params.jobId}/download`,
    });
    return;
  }
  appendEditablePptLog(
    job,
    `Checking Foundry worker (${Math.floor(
      (Date.now() - Date.parse(job.startedAt)) / 1000,
    )}s elapsed).`,
  );
  try {
      const statusResponse = await invokeHostedAgent(
        "editable-ppt-status",
        { jobId: job.remoteJobId },
        randomUUID(),
        60_000,
        job.sessionId,
      );
      const payload = await statusResponse.json() as EditablePptSkillPayload;
      if (payload.status === "running") {
        res.status(202).json({ status: job.status, logs: job.logs });
        return;
      }
      if (payload.status !== "completed") {
        throw new Error(
          typeof payload.error === "string"
            ? payload.error
            : "Foundry worker returned an invalid status.",
        );
      }
      const invocationId =
        typeof payload.invocationId === "string"
          ? payload.invocationId.trim()
          : "";
      const runId =
        typeof payload.runId === "string" ? payload.runId.trim() : "";
      if (
        payload.workflow !== "image-to-editable-ppt" ||
        payload.validationPassed !== true ||
        JSON.stringify(payload.sourceImageSha256s) !==
          JSON.stringify([job.sourceImageSha256]) ||
        !invocationId ||
        !runId ||
        typeof payload.pptxBase64 !== "string"
      ) {
        throw new Error(
          "Skill runner response is missing validated image lineage.",
        );
      }
      const pptx = Buffer.from(payload.pptxBase64, "base64");
      if (pptx.length < 4 || !pptx.subarray(0, 2).equals(Buffer.from("PK"))) {
        throw new Error("Skill runner did not return a valid PPTX package.");
      }
      job.status = "completed";
      job.pptx = pptx;
      job.invocationId = invocationId;
      job.runId = runId;
      appendEditablePptLog(job, "Validation passed; editable PPTX is ready.");
      res.json({
        status: job.status,
        logs: job.logs,
        invocationId,
        runId,
        sourceImageSha256: job.sourceImageSha256,
        downloadUrl: `/editable-pptx/${req.params.jobId}/download`,
      });
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      appendEditablePptLog(job, `FAILED: ${job.error}`);
      res.status(502).json({ status: job.status, error: job.error, logs: job.logs });
    }
});

router.get("/editable-pptx/:jobId/download", (req, res) => {
  const job = editablePptGatewayJobs.get(req.params.jobId);
  if (!job?.pptx || job.status !== "completed") {
    res.status(409).json({ error: "Editable PPTX is not ready." });
    return;
  }
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  );
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="uploaded-image-editable.pptx"',
  );
  res.setHeader("X-Source-Image-Sha256", job.sourceImageSha256);
  res.setHeader("X-Skill-Invocation-Id", job.invocationId!);
  res.setHeader("X-Editppt-Run-Id", job.runId!);
  res.send(job.pptx);
});

router.post(
  "/projects/:projectId/architecture/generate-editable-pptx",
  async (req, res) => {
    const project = await getProject(req.params.projectId);
    const imageAssetId = project?.currentAssets["architecture-image"];
    const storedImage = imageAssetId
      ? await readProjectBinaryAsset(req.params.projectId, imageAssetId)
      : null;
    if (!project || !storedImage) {
      res.status(404).json({ error: "Generated overview image not found." });
      return;
    }

    if (!isHostedAgentConfigured()) {
      res.status(503).json({
        error:
          "The image-to-editable-ppt skill runner is not deployed. " +
          "Configure PRESENTATION_AGENT_INVOCATIONS_ENDPOINT.",
      });
      return;
    }

    const sourceImage = Buffer.from(storedImage.content);
    const sourceImageSha256 = createHash("sha256")
      .update(sourceImage)
      .digest("hex");
    try {
      const invocationKey = `${project.id}:${storedImage.asset.id}`;
      let invocation = editablePptSkillInvocations.get(invocationKey);
      if (!invocation) {
        invocation = (async () => {
          const skillResponse = await invokeHostedAgent(
            "image-to-editable-ppt",
            {
              projectId: project.id,
              sourceAssetId: storedImage.asset.id,
              sourceImageMediaType: "image/png",
              sourceImageBase64: sourceImage.toString("base64"),
              sourceImageSha256,
            },
            randomUUID(),
            EDITABLE_PPT_SKILL_TIMEOUT_MS,
          );
          const payload =
            await skillResponse.json() as EditablePptSkillPayload;
          if (!skillResponse.ok) {
            throw new Error(
              typeof payload.error === "string"
                ? payload.error
                : `Skill runner failed (${skillResponse.status}).`,
            );
          }
          const invocationId =
            typeof payload.invocationId === "string"
              ? payload.invocationId.trim()
              : "";
          const runId =
            typeof payload.runId === "string" ? payload.runId.trim() : "";
          if (
            payload.workflow !== "image-to-editable-ppt" ||
            payload.validationPassed !== true ||
            payload.sourceImageSha256 !== sourceImageSha256 ||
            !invocationId ||
            !runId ||
            typeof payload.pptxBase64 !== "string"
          ) {
            throw new Error(
              "Skill runner response is missing validated invocation provenance.",
            );
          }
          const pptx = Buffer.from(payload.pptxBase64, "base64");
          if (
            pptx.length < 4 ||
            !pptx.subarray(0, 2).equals(Buffer.from("PK"))
          ) {
            throw new Error("Skill runner did not return a valid PPTX package.");
          }
          const storedPptx = await storeProjectBinaryAsset(
            project.id,
            "architecture-pptx",
            "pptx",
            pptx,
            [storedImage.asset.id],
            {
              conversionWorkflow: "image-to-editable-ppt",
              editpptValidationPassed: true,
              skillInvocationId: invocationId,
              editpptRunId: runId,
              skillInvokedAt: new Date().toISOString(),
              sourceImageSha256,
              fullSlideScreenshot: false,
            },
          );
          return {
            invocationId,
            runId,
            assetId: storedPptx.asset.id,
          };
        })();
        editablePptSkillInvocations.set(invocationKey, invocation);
        void invocation.then(
          () => editablePptSkillInvocations.delete(invocationKey),
          () => editablePptSkillInvocations.delete(invocationKey),
        );
      }
      const result = await invocation;
      res.status(201).json({
        invocationId: result.invocationId,
        runId: result.runId,
        assetId: result.assetId,
        downloadUrl:
          `/projects/${project.id}/architecture/download.pptx`,
      });
    } catch (error) {
      res.status(502).json({
        error:
          error instanceof Error
            ? `image-to-editable-ppt skill invocation failed: ${error.message}`
            : "image-to-editable-ppt skill invocation failed.",
      });
    }
  },
);

router.get("/projects/:projectId/architecture/download.pptx", async (req, res) => {
  const project = await getProject(req.params.projectId);
  const imageAssetId = project?.currentAssets["architecture-image"];
  const pptxAssetId = project?.currentAssets["architecture-pptx"];
  const stored = pptxAssetId
    ? await readProjectBinaryAsset(req.params.projectId, pptxAssetId)
    : null;
  const isCurrentSkillConversion = Boolean(
    imageAssetId &&
    stored?.asset.metadata.conversionWorkflow === "image-to-editable-ppt" &&
    stored.asset.metadata.editpptValidationPassed === true &&
    typeof stored.asset.metadata.skillInvocationId === "string" &&
    Boolean(stored.asset.metadata.skillInvocationId) &&
    typeof stored.asset.metadata.editpptRunId === "string" &&
    Boolean(stored.asset.metadata.editpptRunId) &&
    typeof stored.asset.metadata.skillInvokedAt === "string" &&
    Boolean(stored.asset.metadata.skillInvokedAt) &&
    stored.asset.sourceAssetIds.includes(imageAssetId),
  );
  if (!stored || !isCurrentSkillConversion) {
    res.status(409).json({
      error:
        "The current Validated JSON → Image 2 overview has not completed " +
        "the image-to-editable-ppt workflow.",
    });
    return;
  }
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  );
  res.setHeader(
    "Content-Disposition",
      'attachment; filename="presentation-overview-editable.pptx"',
  );
  res.send(Buffer.from(stored.content));
});

router.get("/projects/:projectId/architecture/pptx-preview", async (req, res) => {
  const project = await getProject(req.params.projectId);
  const assetId = project?.currentAssets["architecture-pptx-preview"];
  const stored = assetId
    ? await readProjectBinaryAsset(req.params.projectId, assetId)
    : null;
  if (!stored) {
    res.status(404).json({ error: "Editable project overview PPTX preview not found." });
    return;
  }
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "private, max-age=300");
  res.send(Buffer.from(stored.content));
});

router.get("/projects/:projectId/architecture/narrative-image", async (req, res) => {
  const project = await getProject(req.params.projectId);
  const assetId = project?.currentAssets["architecture-narrative-image"];
  const stored = assetId
    ? await readProjectBinaryAsset(req.params.projectId, assetId)
    : null;
  if (!stored) {
    res.status(404).json({ error: "Generated narrative project overview image not found." });
    return;
  }
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "private, max-age=300");
  res.send(Buffer.from(stored.content));
});

router.get("/projects/:projectId/architecture/narrative-html", async (req, res) => {
  const project = await getProject(req.params.projectId);
  const assetId = project?.currentAssets["architecture-narrative-html"];
  const stored = assetId ? await readProjectAsset(req.params.projectId, assetId) : null;
  if (!stored) {
    res.status(404).json({ error: "Generated narrative project overview HTML not found." });
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'");
  res.setHeader("Cache-Control", "private, max-age=300");
  res.send(stored.content);
});

router.get("/projects/:projectId/architecture/validated-json-html", async (req, res) => {
  const project = await getProject(req.params.projectId);
  const assetId = project?.currentAssets["architecture-validated-json-html"];
  const stored = assetId ? await readProjectAsset(req.params.projectId, assetId) : null;
  if (!stored) {
    res.status(404).json({ error: "Generated validated JSON project overview HTML not found." });
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'");
  res.setHeader("Cache-Control", "private, max-age=300");
  res.send(stored.content);
});

router.get("/projects/:projectId/architecture/image-derived-html", async (req, res) => {
  const project = await getProject(req.params.projectId);
  const assetId = project?.currentAssets["architecture-image-derived-html"];
  const stored = assetId ? await readProjectAsset(req.params.projectId, assetId) : null;
  if (!stored) {
    res.status(404).json({ error: "Generated GPT-Image-2-derived HTML not found." });
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'self'",
  );
  res.send(applyArchitectureImageLayoutGuard(stored.content));
});

router.get("/projects/:projectId/architecture/html", async (req, res) => {
  const project = await getProject(req.params.projectId);
  const assetId = project?.currentAssets["architecture-html"];
  const stored = assetId ? await readProjectAsset(req.params.projectId, assetId) : null;
  if (!stored) {
    res.status(404).json({ error: "Generated project overview HTML not found." });
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'");
  res.setHeader("Cache-Control", "private, max-age=300");
  res.send(stored.content);
});

export default router;
