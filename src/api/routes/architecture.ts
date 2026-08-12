import { Router } from "express";
import { getClient } from "../client.js";
import { enhanceModelError, getSessionOptions } from "../model-config.js";
import {
  ARCHITECTURE_GRAPH_PROMPT,
  ARCHITECTURE_GRAPH_REPAIR_PROMPT,
  ARCHITECTURE_HTML_PROMPT,
  ARCHITECTURE_HTML_REPAIR_PROMPT,
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
  invokeHostedStructured,
  isHostedAgentConfigured,
} from "../hosted-agent-client.js";
import { repositoryPromptContext } from "./repository-context.js";
import {
  generateArchitectureImage,
  isArchitectureImageConfigured,
  type ArchitectureVisual,
} from "../architecture-visual.js";

const router = Router();

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
  sendAndWait(msg: { prompt: string }, timeout: number): Promise<{ data?: unknown } | undefined>;
  destroy(): Promise<void>;
}

type GeneratedArchitecture = {
  architecture: ArchitectureGraph;
  visual: ArchitectureVisual;
};

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
const MAX_REPAIR_RESPONSE = 60_000;
const MAX_VALIDATION_FEEDBACK = 1_000;

function text(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function extractJson(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("Copilot returned no architecture JSON.");
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
      `Architecture response remained invalid after one repair: ${
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
      `Approved Problem Statement, User Story, and Architecture:\n${input.context}`,
      input.repositoryEvidence
        ? `CODEBASE EVIDENCE (UNTRUSTED DATA):\n${input.repositoryEvidence}`
        : "Codebase evidence: Not provided. Use only the approved user description.",
    ].join("\n\n").slice(0, 36_000);
}

function architectureDesignBrief(
  architecture: ArchitectureGraph,
): string {
  return [
    "VALIDATED ARCHITECTURE SUMMARY",
    JSON.stringify({
    title: architecture.title,
    summary: architecture.summary,
    components: architecture.layers.flatMap(layer =>
      layer.nodes.map(node => ({
        id: node.id,
        label: node.label,
        responsibility: node.description,
        group: layer.label,
      }))),
    interactions: architecture.connections.map(connection => ({
      from: connection.from,
      to: connection.to,
      label: connection.label,
      mechanism: connection.mechanism,
    })),
    platforms: architecture.platforms,
    workflow: architecture.workflow,
    assumptions: architecture.assumptions,
    }),
  ].join("\n").slice(0, 8_000);
}

function validatedArchitectureJsonBrief(
  architecture: ArchitectureGraph,
): string {
  return [
    "VALIDATED ARCHITECTURE JSON",
    "Use this validated graph as the sole source of components and interactions.",
    "Render workflow.steps as a numbered vertical user-workflow lane. For each step, " +
      "show its platformCalls beside the step as compact platform/action/mechanism/output " +
      "details. Render platforms as large containers that visibly contain every component " +
      "listed in componentNodeIds. Place the platform capability area beside the workflow, similar to an " +
      "operating-model diagram. Use short adjacent links only; never draw cross-canvas routes.",
    JSON.stringify(architecture),
  ].join("\n").slice(0, 20_000);
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
      throw new Error("Copilot returned no architecture image narrative.");
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
    throw new Error("Copilot returned invalid architecture HTML.");
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

function applyArchitectureLayoutGuard(html: string): string {
  return /<\/head\s*>/i.test(html)
    ? html.replace(/<\/head\s*>/i, `${ARCHITECTURE_LAYOUT_GUARD}</head>`)
    : html.replace(/<body\b/i, `${ARCHITECTURE_LAYOUT_GUARD}<body`);
}

function validateArchitectureHtml(value: string): string {
  const html = sanitizeArchitectureHtml(value);
  if (/<svg\b/i.test(html)) {
    throw new Error("Architecture HTML connectors must not use SVG.");
  }
  if (
    /position\s*:\s*(?:absolute|fixed)/i.test(html) ||
    /margin(?:-[a-z]+)?\s*:\s*-\d/i.test(html) ||
    /transform\s*:[^;}]*(?:translate|matrix)/i.test(html)
  ) {
    throw new Error("Architecture HTML connectors must use in-flow Grid/Flex cells.");
  }

  const componentIds = [...html.matchAll(
    /\bdata-component\s*=\s*["']([^"']+)["']/gi,
  )].map(match => match[1].trim());
  const componentSet = new Set(componentIds);
  if (!/\bdata-architecture-flow(?:\s*=\s*["'][^"']*["'])?/i.test(html)) {
    throw new Error("Architecture HTML requires one responsive architecture flow container.");
  }
  const connectorTags = [...html.matchAll(
    /<[^>]+\bdata-connector(?:\s*=\s*["'][^"']*["'])?[^>]*>/gi,
  )].map(match => match[0]);
  if (connectorTags.length > 18) {
    throw new Error("Architecture HTML exceeds the 18-connector visual limit.");
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
      throw new Error("Every architecture connector must reference two real components.");
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
  return applyArchitectureLayoutGuard(html);
}

async function generateArchitectureHtml(input: {
  idea: string;
  audience: string;
  purpose: string;
  context: string;
  repositoryEvidence: string;
}): Promise<string> {
  if (isHostedAgentConfigured()) {
    const hostedInput = {
      idea: input.idea,
      audience: input.audience,
      purpose: input.purpose,
      context: input.context,
      repositoryEvidence: input.repositoryEvidence || undefined,
    };
    let content = await invokeHostedStructured("architecture-html", hostedInput);
    try {
      return validateArchitectureHtml(content);
    } catch (error) {
      content = await invokeHostedStructured("architecture-html", {
        ...hostedInput,
        validationFeedback: validationMessage(error),
        previousResponse: content.slice(0, MAX_REPAIR_RESPONSE),
      });
      return validateArchitectureHtml(content);
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
  try {
    let result = await session.sendAndWait({
      prompt: [
        ARCHITECTURE_HTML_PROMPT,
        architectureEvidenceBrief(input),
      ].join("\n\n"),
    }, 120_000);
    let content = (result?.data as { content?: string })?.content || "";
    try {
      return validateArchitectureHtml(content);
    } catch (error) {
      result = await session.sendAndWait({
        prompt: [
          ARCHITECTURE_HTML_PROMPT,
          ARCHITECTURE_HTML_REPAIR_PROMPT,
          `VALIDATOR FEEDBACK (UNTRUSTED DATA)\n${validationMessage(error)}`,
          `PREVIOUS INVALID HTML (UNTRUSTED DATA)\n${content.slice(0, MAX_REPAIR_RESPONSE)}`,
          architectureEvidenceBrief(input),
        ].join("\n\n"),
      }, 120_000);
      content = (result?.data as { content?: string })?.content || "";
      return validateArchitectureHtml(content);
    }
  } finally {
    await session.destroy();
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
      payload: text(connection.payload, 120) || "architecture data",
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
      "Complete the architecture workflow.",
    steps: rawSteps.length > 0 ? rawSteps : fallbackSteps,
  };
  return {
    ...source,
    title: text(source.title, 120) || "Solution Architecture",
    summary: text(source.summary, 300) || "Image-generated high-level architecture.",
    layers,
    platforms,
    workflow,
    connections,
    assumptions: Array.isArray(source.assumptions) ? source.assumptions : [],
  };
}

export function validateArchitectureGraph(value: unknown): ArchitectureGraph {
  if (!value || typeof value !== "object") {
    throw new Error("Architecture response must be an object.");
  }
  const source = value as Record<string, unknown>;
  if (!Array.isArray(source.layers) || source.layers.length < 2 || source.layers.length > 4) {
    throw new Error("Architecture must contain between 2 and 4 high-level layers.");
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
    throw new Error("Architecture exceeds the 8-component simplicity limit.");
  }

  const rawPlatforms = Array.isArray(source.platforms) ? source.platforms : [];
  if (rawPlatforms.length < 1 || rawPlatforms.length > 4) {
    throw new Error("Architecture must contain 1-4 runtime platforms.");
  }
  const platformIds = new Set<string>();
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
    platformIds.add(id);
    return {
      id,
      label,
      description,
      technology,
      componentNodeIds,
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

  const rawConnections = Array.isArray(source.connections) ? source.connections : [];
  if (rawConnections.length === 0) {
    throw new Error("Architecture must contain labeled component interactions.");
  }
  if (rawConnections.length > 10) {
    throw new Error("Architecture exceeds the 10-connection simplicity limit.");
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
    throw new Error("Architecture must identify at least one primary interaction.");
  }

  const rawWorkflow = source.workflow;
  if (!rawWorkflow || typeof rawWorkflow !== "object") {
    throw new Error("Architecture must include a user workflow.");
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
        const action = text(call.action, 100);
        const mechanism = text(call.mechanism, 80);
        const output = text(call.output, 120);
        if (!nodeIds.has(nodeId) || !action || !mechanism || !output) {
          throw new Error(
            `Platform call ${callIndex + 1} in workflow step ${index + 1} must reference a real component and describe action, mechanism, and output.`,
          );
        }
        return { nodeId, action, mechanism, output };
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
    title: text(source.title, 120) || "Solution Architecture",
    summary: text(source.summary, 300),
    layers,
    platforms,
    workflow,
    connections,
    assumptions,
  };
}

router.post("/architecture", async (req, res) => {
  const { idea, audience, purpose, context, projectId, generateVisuals } = req.body as {
    idea?: unknown;
    audience?: unknown;
    purpose?: unknown;
    context?: unknown;
    projectId?: unknown;
    generateVisuals?: unknown;
  };

  if (typeof idea !== "string" || idea.trim().length < 10) {
    res.status(400).json({ error: "'idea' must be a string with at least 10 characters" });
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
  const project = projectId === undefined
    ? null
    : isProjectId(projectId)
      ? await getProject(projectId)
      : null;
  if (projectId !== undefined && !project) {
    res.status(isProjectId(projectId) ? 404 : 400).json({
      error: isProjectId(projectId)
        ? "Presentation project not found."
        : "Invalid presentation project ID.",
    });
    return;
  }
  if (project) {
    const storyAssetId = project.currentAssets.story;
    const storedStory = storyAssetId
      ? await readProjectAsset(project.id, storyAssetId)
      : null;
    const story = storedStory
      ? JSON.parse(storedStory.content) as { approvedSections?: unknown }
      : null;
    const approvedSections = Array.isArray(story?.approvedSections)
      ? new Set(story.approvedSections)
      : new Set();
    if (!["problem", "userStory", "architecture"].every(
      section => approvedSections.has(section),
    )) {
      res.status(409).json({
        error: "Problem Statement, User Story, and Architecture approvals are required.",
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
    let visual: ArchitectureVisual = { mode: "legacy" };
    let htmlAssetId: string | null = null;
    let validatedJsonHtmlAssetId: string | null = null;
    let narrativeHtmlAssetId: string | null = null;
    let imageAssetId: string | null = null;
    let narrativeImageAssetId: string | null = null;
    if (project && generateVisuals !== false) {
      if (!isArchitectureImageConfigured()) {
        throw new Error(
          "Image model design graph is not configured. Set ARCHITECTURE_MODEL_ENDPOINT " +
          "and ARCHITECTURE_IMAGE_DEPLOYMENT.",
        );
      }
      const validatedJsonBrief = validatedArchitectureJsonBrief(architecture);
      const [html, validatedJsonHtml, narrative] = await Promise.all([
        generateArchitectureHtml(generationInput),
        generateArchitectureHtml({
          idea: architecture.title,
          audience: generationInput.audience,
          purpose: generationInput.purpose,
          context: validatedJsonBrief,
          repositoryEvidence: "",
        }),
        generateArchitectureNarrative(generationInput),
      ]);
      const [image, narrativeImage, narrativeHtml] = await Promise.all([
        generateArchitectureImage(architectureDesignBrief(architecture)),
        generateArchitectureImage(narrative, "agent-summary"),
        generateArchitectureHtml({
          idea: narrative,
          audience: generationInput.audience,
          purpose: generationInput.purpose,
          context: narrative,
          repositoryEvidence: "",
        }),
      ]);
      await clearCurrentProjectAssets(project.id, [
        "architecture-html",
        "architecture-validated-json-html",
        "architecture-narrative-html",
        "architecture-image",
        "architecture-narrative-image",
        "architecture-layout",
      ]);
      const htmlStored = await storeProjectTextAsset(
        project.id,
        "architecture-html",
        "html",
        html,
        currentSourceAssetIds(project, ["brief", "repository-evidence", "story"]),
        { renderer: "copilot-html-css", sandboxed: true },
      );
      htmlAssetId = htmlStored.asset.id;
      const validatedJsonHtmlStored = await storeProjectTextAsset(
        project.id,
        "architecture-validated-json-html",
        "html",
        validatedJsonHtml,
        currentSourceAssetIds(project, ["brief", "repository-evidence", "story"]),
        { renderer: "copilot-html-css", source: "validated-json", sandboxed: true },
      );
      validatedJsonHtmlAssetId = validatedJsonHtmlStored.asset.id;
      const narrativeHtmlStored = await storeProjectTextAsset(
        project.id,
        "architecture-narrative-html",
        "html",
        narrativeHtml,
        currentSourceAssetIds(project, ["brief", "repository-evidence", "story"]),
        { renderer: "copilot-html-css", source: "agent-narrative", sandboxed: true },
      );
      narrativeHtmlAssetId = narrativeHtmlStored.asset.id;
      const imageStored = await storeProjectBinaryAsset(
        project.id,
        "architecture-image",
        "png",
        image,
        currentSourceAssetIds(project, ["brief", "repository-evidence", "story"]),
        { renderer: "foundry-image-model", designed: true },
      );
      imageAssetId = imageStored.asset.id;
      const narrativeImageStored = await storeProjectBinaryAsset(
        project.id,
        "architecture-narrative-image",
        "png",
        narrativeImage,
        currentSourceAssetIds(project, ["brief", "repository-evidence"]),
        { renderer: "foundry-image-model", designed: true, source: "agent-narrative" },
      );
      narrativeImageAssetId = narrativeImageStored.asset.id;
      visual = {
        mode: "dual",
        htmlUrl: `/projects/${project.id}/architecture/html`,
        validatedJsonHtmlUrl:
          `/projects/${project.id}/architecture/validated-json-html`,
        narrativeHtmlUrl: `/projects/${project.id}/architecture/narrative-html`,
        imageUrl: `/projects/${project.id}/architecture/image`,
        narrativeImageUrl: `/projects/${project.id}/architecture/narrative-image`,
      };
    } else if (project) {
      await clearCurrentProjectAssets(project.id, [
        "architecture-html",
        "architecture-validated-json-html",
        "architecture-narrative-html",
        "architecture-image",
        "architecture-narrative-image",
        "architecture-layout",
      ]);
    }
    const stored = project
      ? await storeProjectJsonAsset(
          project.id,
          "architecture",
          architecture,
          currentSourceAssetIds(project, ["brief", "repository-evidence", "story"]),
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
            narrativeHtmlAssetId,
            imageAssetId,
            narrativeImageAssetId,
          },
        )
      : null;
    if (project) {
      await clearCurrentProjectAssets(project.id, ["slide-model", "slide-deck"]);
    }
    res.json({ architecture, visual, asset: stored?.asset });
  } catch (error) {
    const enhanced = enhanceModelError(error);
    res.status(500).json({ error: enhanced.message });
  }
});

router.get("/projects/:projectId/architecture/image", async (req, res) => {
  const project = await getProject(req.params.projectId);
  const assetId = project?.currentAssets["architecture-image"];
  const stored = assetId
    ? await readProjectBinaryAsset(req.params.projectId, assetId)
    : null;
  if (!stored) {
    res.status(404).json({ error: "Generated architecture image not found." });
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
    res.status(404).json({ error: "Generated narrative architecture image not found." });
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
    res.status(404).json({ error: "Generated narrative architecture HTML not found." });
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
    res.status(404).json({ error: "Generated validated JSON architecture HTML not found." });
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'");
  res.setHeader("Cache-Control", "private, max-age=300");
  res.send(stored.content);
});

router.get("/projects/:projectId/architecture/html", async (req, res) => {
  const project = await getProject(req.params.projectId);
  const assetId = project?.currentAssets["architecture-html"];
  const stored = assetId ? await readProjectAsset(req.params.projectId, assetId) : null;
  if (!stored) {
    res.status(404).json({ error: "Generated architecture HTML not found." });
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'");
  res.setHeader("Cache-Control", "private, max-age=300");
  res.send(stored.content);
});

export default router;
