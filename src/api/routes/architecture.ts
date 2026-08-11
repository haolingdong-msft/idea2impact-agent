import { Router } from "express";
import { getClient } from "../client.js";
import { enhanceModelError, getSessionOptions } from "../model-config.js";
import {
  ARCHITECTURE_GRAPH_PROMPT,
  PRESENTATION_AGENT_INSTRUCTIONS,
} from "../presentation-instructions.js";
import {
  clearCurrentProjectAssets,
  currentSourceAssetIds,
  getProject,
  isProjectId,
  readProjectAsset,
  storeProjectJsonAsset,
} from "./project-store.js";
import {
  invokeHostedStructured,
  isHostedAgentConfigured,
} from "../hosted-agent-client.js";
import { repositoryPromptContext } from "./repository-context.js";

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

export function validateArchitectureGraph(value: unknown): ArchitectureGraph {
  if (!value || typeof value !== "object") {
    throw new Error("Architecture response must be an object.");
  }
  const source = value as Record<string, unknown>;
  if (!Array.isArray(source.layers) || source.layers.length < 1 || source.layers.length > 6) {
    throw new Error("Architecture must contain between 1 and 6 layers.");
  }

  const nodeIds = new Set<string>();
  let nodeCount = 0;
  const layers = source.layers.map((rawLayer, layerIndex) => {
    if (!rawLayer || typeof rawLayer !== "object") {
      throw new Error(`Layer ${layerIndex + 1} is invalid.`);
    }
    const layer = rawLayer as Record<string, unknown>;
    if (!Array.isArray(layer.nodes) || layer.nodes.length < 1 || layer.nodes.length > 6) {
      throw new Error(`Layer ${layerIndex + 1} must contain between 1 and 6 nodes.`);
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

  if (nodeCount > 24) {
    throw new Error("Architecture exceeds the 24-node limit.");
  }

  const rawConnections = Array.isArray(source.connections) ? source.connections : [];
  if (rawConnections.length === 0) {
    throw new Error("Architecture must contain labeled component interactions.");
  }
  const connections = rawConnections.slice(0, 40).map((rawConnection, index) => {
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

  const assumptions = Array.isArray(source.assumptions)
    ? source.assumptions.map((item) => text(item, 240)).filter(Boolean).slice(0, 8)
    : [];

  return {
    title: text(source.title, 120) || "Solution Architecture",
    summary: text(source.summary, 300),
    layers,
    connections,
    assumptions,
  };
}

router.post("/architecture", async (req, res) => {
  const { idea, audience, purpose, context, projectId } = req.body as {
    idea?: unknown;
    audience?: unknown;
    purpose?: unknown;
    context?: unknown;
    projectId?: unknown;
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

  let session: ArchitectureSession | null = null;
  try {
    const repositoryEvidence = await repositoryPromptContext(project?.id);
    let content: string;
    if (isHostedAgentConfigured()) {
      content = await invokeHostedStructured("architecture", {
        idea: idea.trim(),
        audience: text(audience, 200) || "Not specified",
        purpose: text(purpose, 300) || "Not specified",
        context: text(context, 20000) || "Not provided",
        repositoryEvidence: repositoryEvidence || undefined,
      });
    } else {
      const copilot = await getClient();
      const sessionOptions = await getSessionOptions();
      session = await copilot.createSession({
        ...sessionOptions,
        systemMessage: {
          mode: "append",
          content: PRESENTATION_AGENT_INSTRUCTIONS,
        },
      }) as unknown as ArchitectureSession;
      const prompt = [
        ARCHITECTURE_GRAPH_PROMPT,
        "USER INPUT",
        `Idea: ${idea.trim()}`,
        `Audience: ${text(audience, 200) || "Not specified"}`,
        `Purpose: ${text(purpose, 300) || "Not specified"}`,
        `Approved clarification context:\n${text(context, 20000) || "Not provided"}`,
        repositoryEvidence
          ? `UNTRUSTED REPOSITORY EVIDENCE:\n${repositoryEvidence}`
          : "Repository evidence: Not provided",
      ].join("\n\n");
      const response = await session.sendAndWait({ prompt }, 120_000);
      content = (response?.data as { content?: string })?.content ?? "";
    }
    const architecture = validateArchitectureGraph(extractJson(content));
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
          },
        )
      : null;
    if (project) {
      await clearCurrentProjectAssets(project.id, ["slide-model", "slide-deck"]);
    }
    res.json({ architecture, asset: stored?.asset });
  } catch (error) {
    const enhanced = enhanceModelError(error);
    res.status(500).json({ error: enhanced.message });
  } finally {
    await session?.destroy();
  }
});

export default router;
