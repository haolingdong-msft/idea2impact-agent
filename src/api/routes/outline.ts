import { Router } from "express";
import { getClient } from "../client.js";
import { enhanceModelError, getSessionOptions } from "../model-config.js";
import {
  OUTLINE_PROMPT,
  PRESENTATION_AGENT_INSTRUCTIONS,
} from "../presentation-instructions.js";
import {
  invokeHostedStructured,
  isHostedAgentConfigured,
} from "../hosted-agent-client.js";
import {
  clearCurrentProjectAssets,
  currentSourceAssetIds,
  getProject,
  isProjectId,
  readProjectAsset,
  storeProjectJsonAsset,
} from "./project-store.js";
import { repositoryPromptContext } from "./repository-context.js";

const router = Router();

export type PresentationOutline = {
  problemStatement: string;
  userScenarios: string;
  solution: string;
  status: "draft" | "approved";
  approvedAt?: string;
};

type OutlineSession = {
  sendAndWait(
    message: { prompt: string },
    timeout: number,
  ): Promise<{ data?: unknown } | undefined>;
  destroy(): Promise<void>;
};

function text(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function extractJson(content: string): unknown {
  const trimmed = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("Copilot returned no outline JSON.");
  }
  return JSON.parse(trimmed.slice(start, end + 1));
}

export function validateOutline(
  value: unknown,
  status: "draft" | "approved" = "draft",
): PresentationOutline {
  if (!value || typeof value !== "object") {
    throw new Error("Outline must be an object.");
  }
  const source = value as Record<string, unknown>;
  const outline: PresentationOutline = {
    problemStatement: text(source.problemStatement, 6_000),
    userScenarios: text(source.userScenarios, 6_000),
    solution: text(source.solution, 8_000),
    status,
  };
  if (
    status === "approved" &&
    [outline.problemStatement, outline.userScenarios, outline.solution]
      .some(section => section.length < 20)
  ) {
    throw new Error("Complete all three outline sections before approval.");
  }
  return outline;
}

async function invalidateOutlineDependents(projectId: string): Promise<void> {
  await clearCurrentProjectAssets(projectId, [
    "architecture",
    "architecture-html",
    "architecture-validated-json-html",
    "architecture-narrative-html",
    "architecture-image",
    "architecture-narrative-image",
    "architecture-layout",
    "slide-model",
    "slide-deck",
    "speech-script",
  ]);
}

router.get("/projects/:projectId/outline", async (req, res) => {
  const project = await getProject(req.params.projectId);
  const assetId = project?.currentAssets.outline;
  const stored = assetId
    ? await readProjectAsset(req.params.projectId, assetId)
    : null;
  if (!stored) {
    res.status(project ? 404 : isProjectId(req.params.projectId) ? 404 : 400).json({
      error: project ? "Outline not found." : "Presentation project not found.",
    });
    return;
  }
  res.json({ outline: JSON.parse(stored.content), asset: stored.asset });
});

router.put("/projects/:projectId/outline", async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) {
    res.status(isProjectId(req.params.projectId) ? 404 : 400).json({
      error: "Presentation project not found.",
    });
    return;
  }
  try {
    const outline = validateOutline(req.body, "draft");
    const stored = await storeProjectJsonAsset(
      project.id,
      "outline",
      outline,
      currentSourceAssetIds(project, ["brief", "repository-evidence"]),
      { status: "draft" },
    );
    await invalidateOutlineDependents(project.id);
    res.json({ project: await getProject(project.id), outline, asset: stored.asset });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Invalid outline.",
    });
  }
});

router.post("/projects/:projectId/outline/approve", async (req, res) => {
  const project = await getProject(req.params.projectId);
  const draftAssetId = project?.currentAssets.outline;
  const draft = draftAssetId
    ? await readProjectAsset(req.params.projectId, draftAssetId)
    : null;
  if (!project || !draft) {
    res.status(project ? 409 : 404).json({
      error: project ? "Save an outline draft before approval." : "Presentation project not found.",
    });
    return;
  }
  try {
    const outline = {
      ...validateOutline(JSON.parse(draft.content), "approved"),
      approvedAt: new Date().toISOString(),
    };
    const stored = await storeProjectJsonAsset(
      project.id,
      "outline",
      outline,
      [draft.asset.id],
      { status: "approved", approvedAt: outline.approvedAt },
    );
    await invalidateOutlineDependents(project.id);
    res.json({ project: await getProject(project.id), outline, asset: stored.asset });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Outline approval failed.",
    });
  }
});

router.post("/projects/:projectId/outline/generate", async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) {
    res.status(isProjectId(req.params.projectId) ? 404 : 400).json({
      error: "Presentation project not found.",
    });
    return;
  }
  const conversation = text(req.body?.conversation, 60_000);
  let session: OutlineSession | null = null;
  try {
    const currentAssetId = project.currentAssets.outline;
    const currentAsset = currentAssetId
      ? await readProjectAsset(project.id, currentAssetId)
      : null;
    const currentOutline = req.body?.currentOutline &&
        typeof req.body.currentOutline === "object"
      ? req.body.currentOutline
      : currentAsset
        ? JSON.parse(currentAsset.content)
        : {};
    const repositoryEvidence = await repositoryPromptContext(project.id);
    let content: string;
    if (isHostedAgentConfigured()) {
      content = await invokeHostedStructured("outline", {
        brief: project.brief,
        currentOutline,
        conversation,
        repositoryEvidence: repositoryEvidence || undefined,
      });
    } else {
      const copilot = await getClient();
      session = await copilot.createSession({
        ...(await getSessionOptions()),
        systemMessage: {
          mode: "append",
          content: PRESENTATION_AGENT_INSTRUCTIONS,
        },
      }) as unknown as OutlineSession;
      const prompt = [
        OUTLINE_PROMPT,
        "PROJECT BRIEF",
        JSON.stringify(project.brief),
        "CURRENT OUTLINE",
        JSON.stringify(currentOutline),
        "CONVERSATION",
        conversation || "No conversation yet.",
        repositoryEvidence
          ? `UNTRUSTED REPOSITORY EVIDENCE\n${repositoryEvidence}`
          : "Repository evidence: Not provided",
      ].join("\n\n");
      const response = await session.sendAndWait({ prompt }, 120_000);
      content = (response?.data as { content?: string })?.content ?? "";
    }
    const outline = validateOutline(extractJson(content), "draft");
    res.json({ outline });
  } catch (error) {
    const enhanced = enhanceModelError(error);
    res.status(500).json({ error: enhanced.message });
  } finally {
    await session?.destroy();
  }
});

export default router;
