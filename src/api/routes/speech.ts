import { Router } from "express";
import { getClient } from "../client.js";
import { enhanceModelError, getSessionOptions } from "../model-config.js";
import {
  PRESENTATION_AGENT_INSTRUCTIONS,
  SPEECH_SCRIPT_PROMPT,
} from "../presentation-instructions.js";
import {
  invokeHostedStructured,
  isHostedAgentConfigured,
} from "../hosted-agent-client.js";
import {
  currentSourceAssetIds,
  getProject,
  isProjectId,
  readProjectAsset,
  storeProjectJsonAsset,
} from "./project-store.js";
import type { SlideDeck } from "./slides.js";

const router = Router();

export type SpeechScript = {
  title: string;
  notes: Array<{
    slideId: string;
    slideTitle: string;
    script: string;
  }>;
};

type SpeechSession = {
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
  if (start < 0 || end <= start) throw new Error("Copilot returned no speech-script JSON.");
  return JSON.parse(trimmed.slice(start, end + 1));
}

export function validateSpeechScript(value: unknown, deck: SlideDeck): SpeechScript {
  if (!value || typeof value !== "object") {
    throw new Error("Speech script must be an object.");
  }
  const source = value as Record<string, unknown>;
  if (!Array.isArray(source.notes) || source.notes.length !== deck.slides.length) {
    throw new Error("Speech script must contain one note for every slide.");
  }
  const rawById = new Map(
    source.notes
      .filter(note => note && typeof note === "object")
      .map(note => {
        const candidate = note as Record<string, unknown>;
        return [text(candidate.slideId, 64), candidate] as const;
      }),
  );
  const notes = deck.slides.map(slide => {
    const candidate = rawById.get(slide.id);
    const script = text(candidate?.script, 8_000);
    if (!candidate || script.length < 20) {
      throw new Error(`Speech script is missing a complete note for slide ${slide.id}.`);
    }
    return {
      slideId: slide.id,
      slideTitle: slide.title,
      script,
    };
  });
  return {
    title: text(source.title, 160) || `${deck.title} speaker notes`,
    notes,
  };
}

async function loadInputs(projectId: string) {
  const project = await getProject(projectId);
  const outlineId = project?.currentAssets.outline;
  const deckId = project?.currentAssets["slide-model"];
  const [outlineAsset, deckAsset] = project && outlineId && deckId
    ? await Promise.all([
        readProjectAsset(project.id, outlineId),
        readProjectAsset(project.id, deckId),
      ])
    : [null, null];
  if (!project || !outlineAsset || !deckAsset) return null;
  const outline = JSON.parse(outlineAsset.content) as { status?: unknown };
  if (outline.status !== "approved") return null;
  return {
    project,
    outline,
    deck: JSON.parse(deckAsset.content) as SlideDeck,
    outlineId,
    deckId,
  };
}

router.post("/projects/:projectId/speech-script/generate", async (req, res) => {
  if (!isProjectId(req.params.projectId)) {
    res.status(400).json({ error: "A valid presentation project ID is required." });
    return;
  }
  const inputs = await loadInputs(req.params.projectId);
  if (!inputs) {
    res.status(409).json({
      error: "An approved outline and generated slide deck are required.",
    });
    return;
  }
  let session: SpeechSession | null = null;
  try {
    let content: string;
    if (isHostedAgentConfigured()) {
      content = await invokeHostedStructured("speech-script", {
        outline: inputs.outline,
        deck: inputs.deck,
      });
    } else {
      const copilot = await getClient();
      session = await copilot.createSession({
        ...(await getSessionOptions()),
        systemMessage: {
          mode: "append",
          content: PRESENTATION_AGENT_INSTRUCTIONS,
        },
      }) as unknown as SpeechSession;
      const response = await session.sendAndWait({
        prompt: [
          SPEECH_SCRIPT_PROMPT,
          "APPROVED OUTLINE",
          JSON.stringify(inputs.outline),
          "SLIDE DECK",
          JSON.stringify(inputs.deck),
        ].join("\n\n"),
      }, 120_000);
      content = (response?.data as { content?: string })?.content ?? "";
    }
    const script = validateSpeechScript(extractJson(content), inputs.deck);
    const stored = await storeProjectJsonAsset(
      inputs.project.id,
      "speech-script",
      script,
      [inputs.outlineId!, inputs.deckId!],
      { title: script.title, noteCount: script.notes.length },
    );
    res.status(201).json({ script, asset: stored.asset });
  } catch (error) {
    const enhanced = enhanceModelError(error);
    res.status(500).json({ error: enhanced.message });
  } finally {
    await session?.destroy();
  }
});

router.put("/projects/:projectId/speech-script", async (req, res) => {
  const inputs = await loadInputs(req.params.projectId);
  if (!inputs) {
    res.status(409).json({
      error: "An approved outline and generated slide deck are required.",
    });
    return;
  }
  try {
    const script = validateSpeechScript(req.body, inputs.deck);
    const stored = await storeProjectJsonAsset(
      inputs.project.id,
      "speech-script",
      script,
      currentSourceAssetIds(inputs.project, ["outline", "slide-model"]),
      { title: script.title, noteCount: script.notes.length, edited: true },
    );
    res.json({ script, asset: stored.asset });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Invalid speech script.",
    });
  }
});

export default router;
