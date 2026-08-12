import { Router } from "express";
import { getClient } from "../client.js";
import { enhanceModelError, getSessionOptions } from "../model-config.js";
import {
  PRESENTATION_AGENT_INSTRUCTIONS,
  SLIDE_DECK_PROMPT,
} from "../presentation-instructions.js";
import type { ArchitectureGraph } from "./architecture.js";
import type { ArchitectureVisualLayout } from "../architecture-visual.js";
import {
  currentSourceAssetIds,
  getProject,
  isProjectId,
  readProjectBinaryAsset,
  readProjectAsset,
  storeProjectJsonAsset,
  storeProjectTextAsset,
} from "./project-store.js";
import {
  invokeHostedStructured,
  isHostedAgentConfigured,
} from "../hosted-agent-client.js";
import { repositoryPromptContext } from "./repository-context.js";

const router = Router();

export type SlideKind =
  | "title"
  | "problem"
  | "user-story"
  | "architecture"
  | "summary";

export type Slide = {
  id: string;
  kind: SlideKind;
  eyebrow: string;
  title: string;
  subtitle: string;
  bullets: string[];
};

export type SlideDeck = {
  title: string;
  subtitle: string;
  theme: "midnight" | "azure" | "paper";
  slides: Slide[];
};

interface SlideSession {
  sendAndWait(
    msg: { prompt: string },
    timeout: number,
  ): Promise<{ data?: unknown } | undefined>;
  destroy(): Promise<void>;
}

const SLIDE_KINDS = new Set([
  "title",
  "problem",
  "user-story",
  "architecture",
  "summary",
]);
const THEMES = new Set(["midnight", "azure", "paper"]);

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
    throw new Error("Copilot returned no slide-deck JSON.");
  }
  return JSON.parse(trimmed.slice(start, end + 1));
}

export function validateSlideDeck(value: unknown): SlideDeck {
  if (!value || typeof value !== "object") {
    throw new Error("Slide deck response must be an object.");
  }
  const source = value as Record<string, unknown>;
  if (!Array.isArray(source.slides) ||
      source.slides.length < 4 ||
      source.slides.length > 8) {
    throw new Error("Slide deck must contain between 4 and 8 slides.");
  }
  const ids = new Set<string>();
  const slides = source.slides.map((rawSlide, index) => {
    if (!rawSlide || typeof rawSlide !== "object") {
      throw new Error(`Slide ${index + 1} is invalid.`);
    }
    const candidate = rawSlide as Record<string, unknown>;
    const id = text(candidate.id, 64);
    const kind = text(candidate.kind, 32);
    const title = text(candidate.title, 120);
    if (!id || ids.has(id) || !SLIDE_KINDS.has(kind) || !title) {
      throw new Error(`Slide ${index + 1} has invalid fields.`);
    }
    ids.add(id);
    return {
      id,
      kind: kind as SlideKind,
      eyebrow: text(candidate.eyebrow, 60),
      title,
      subtitle: text(candidate.subtitle, 240),
      bullets: Array.isArray(candidate.bullets)
        ? candidate.bullets
            .map(item => text(item, 180))
            .filter(Boolean)
            .slice(0, 6)
        : [],
    };
  });
  const kinds = new Set(slides.map(slide => slide.kind));
  for (const required of ["title", "problem", "user-story", "architecture"]) {
    if (!kinds.has(required as SlideKind)) {
      throw new Error(`Slide deck is missing the required ${required} slide.`);
    }
  }
  return {
    title: text(source.title, 160) || slides[0].title,
    subtitle: text(source.subtitle, 300),
    theme: (THEMES.has(text(source.theme, 20))
      ? text(source.theme, 20)
      : "azure") as SlideDeck["theme"],
    slides,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderArchitecture(architecture: ArchitectureGraph): string {
  const nodeNames = new Map(
    architecture.layers.flatMap(layer => layer.nodes.map(node => [node.id, node.label])),
  );
  const layers = `<div class="architecture">${architecture.layers
    .map(layer => `<article>
      <header>${escapeHtml(layer.label)}</header>
      <p>${escapeHtml(layer.purpose)}</p>
      <div>${layer.nodes
        .map(node => `<span class="${node.provenance === "assumed" ? "assumed" : ""}">
          <b>${escapeHtml(node.label)}</b>
          <em>${escapeHtml(node.technology || "Technology unspecified")}</em>
          <small>${escapeHtml(node.description)}</small>
          ${node.evidencePaths?.length
            ? `<small>${escapeHtml(node.evidencePaths.slice(0, 3).join(" / "))}</small>`
            : ""}
        </span>`)
        .join("")}</div>
    </article>`)
    .join("")}</div>`;
  const flows = `<div class="architecture-flows">${architecture.connections
    .filter(connection => connection.primary)
    .slice(0, 6)
    .map(connection => `<span class="${connection.provenance === "assumed" ? "assumed" : ""}">
      <b>${escapeHtml(nodeNames.get(connection.from) || connection.from)} &rarr; ${escapeHtml(nodeNames.get(connection.to) || connection.to)}</b>
      <em>${escapeHtml(connection.label || "connects to")}</em>
      <small>${escapeHtml(connection.mechanism || "mechanism unspecified")} / ${escapeHtml(connection.payload || "payload unspecified")}</small>
      ${connection.evidencePaths?.length
        ? `<small>${escapeHtml(connection.evidencePaths.slice(0, 3).join(" / "))}</small>`
        : ""}
    </span>`)
    .join("")}</div>`;
  return `<div class="architecture-composition">${layers}${flows}</div>`;
}

function renderArchitectureSvg(
  architecture: ArchitectureGraph,
  layout: ArchitectureVisualLayout,
): string {
  const nodes = new Map(
    architecture.layers.flatMap(layer => layer.nodes.map(node => [node.id, node])),
  );
  const connections = new Map(
    architecture.connections.map(connection => [
      `${connection.from}->${connection.to}`,
      connection,
    ]),
  );
  const connectionSvg = layout.connections.map((position) => {
    const connection = connections.get(`${position.from}->${position.to}`);
    if (!connection) return "";
    const points = position.points.map(point => `${point.x},${point.y}`).join(" ");
    return `<g class="visual-connection visual-${escapeHtml(connection.type)}">
      <polyline points="${points}" marker-end="url(#visual-arrow)"/>
      <text x="${position.labelX}" y="${position.labelY}">${escapeHtml(connection.label)}</text>
    </g>`;
  }).join("");
  const nodeSvg = layout.nodes.map((position) => {
    const node = nodes.get(position.id);
    if (!node) return "";
    return `<g class="visual-node ${node.provenance === "assumed" ? "assumed" : ""}">
      <rect x="${position.x}" y="${position.y}" width="${position.width}" height="${position.height}" rx="18"/>
      <text class="visual-kind" x="${position.x + 20}" y="${position.y + 34}">${escapeHtml(node.kind)}</text>
      <text class="visual-label" x="${position.x + 20}" y="${position.y + 69}">${escapeHtml(node.label)}</text>
      <text class="visual-tech" x="${position.x + 20}" y="${position.y + position.height - 20}">${escapeHtml(node.technology)}</text>
    </g>`;
  }).join("");
  return `<svg class="architecture-generated-svg" viewBox="0 0 1600 900" role="img" aria-label="${escapeHtml(architecture.title)}">
    <defs><marker id="visual-arrow" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto"><path d="M0,0 L12,6 L0,12 Z"/></marker></defs>
    ${connectionSvg}${nodeSvg}
  </svg>`;
}

export function renderSlideDeckHtml(
  deck: SlideDeck,
  architecture: ArchitectureGraph,
  visual?: {
    layout?: ArchitectureVisualLayout;
    imageDataUrl?: string;
    htmlDocument?: string;
  },
): string {
  const slides = deck.slides.map((slide, index) => {
    const content = slide.kind === "architecture"
      ? visual?.htmlDocument
        ? `<iframe class="architecture-html-frame" sandbox="" srcdoc="${escapeHtml(visual.htmlDocument)}" title="${escapeHtml(architecture.title)} architecture diagram"></iframe>`
        : visual?.layout
        ? renderArchitectureSvg(architecture, visual.layout)
        : visual?.imageDataUrl
          ? `<div class="architecture-image"><img src="${escapeHtml(visual.imageDataUrl)}" alt="${escapeHtml(architecture.title)} architecture diagram"></div>`
          : renderArchitecture(architecture)
      : `<ul>${slide.bullets.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
    return `<section class="slide slide-${escapeHtml(slide.kind)}">
      <div class="slide-number">${String(index + 1).padStart(2, "0")}</div>
      <div class="eyebrow">${escapeHtml(slide.eyebrow)}</div>
      <h2>${escapeHtml(slide.title)}</h2>
      ${slide.subtitle ? `<p class="subtitle">${escapeHtml(slide.subtitle)}</p>` : ""}
      ${content}
    </section>`;
  }).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(deck.title)}</title>
  <style>
    :root{color-scheme:dark;--ink:#f7f9fd;--muted:#aab8ce;--blue:#79a7ff;--panel:#17243a}
    *{box-sizing:border-box}body{margin:0;background:#0c1422;color:var(--ink);font-family:Inter,Segoe UI,sans-serif;scroll-snap-type:y mandatory}
    .slide{position:relative;width:100vw;min-height:100vh;padding:8vh 8vw;display:flex;flex-direction:column;justify-content:center;overflow:hidden;scroll-snap-align:start;background:radial-gradient(circle at 85% 10%,#183a72 0,transparent 35%),#0c1422}
    .slide:nth-child(even){background:radial-gradient(circle at 12% 85%,#123f4c 0,transparent 38%),#10192a}
    .slide-number{position:absolute;right:7vw;top:6vh;color:#31415b;font:700 7rem/1 Georgia,serif}
    .eyebrow{color:var(--blue);font:700 .72rem/1.3 ui-monospace,monospace;letter-spacing:.16em;text-transform:uppercase}
    h2{max-width:1000px;margin:18px 0 12px;font:400 clamp(2.7rem,6vw,5.6rem)/.98 Georgia,serif;letter-spacing:-.035em}
    .subtitle{max-width:900px;color:var(--muted);font-size:clamp(1rem,1.7vw,1.45rem);line-height:1.5}
    ul{max-width:980px;margin:36px 0 0;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:16px;list-style:none}
    li{padding:18px 20px;background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.1);border-radius:14px;font-size:clamp(.95rem,1.35vw,1.2rem);line-height:1.4}
    .architecture{margin-top:32px;display:grid;grid-template-columns:repeat(${Math.min(architecture.layers.length, 5)},minmax(0,1fr));gap:14px}
    .architecture article{padding:16px;background:rgba(255,255,255,.06);border:1px solid rgba(121,167,255,.24);border-top:3px solid var(--blue);border-radius:14px}
    .architecture header{font-weight:800;font-size:1rem}.architecture article>p{min-height:42px;color:var(--muted);font-size:.72rem;line-height:1.4}
    .architecture article>div{display:grid;gap:8px}.architecture span{padding:10px;background:rgba(12,20,34,.7);border-radius:9px}.architecture span.assumed,.architecture-flows span.assumed{border:1px dashed #dca85f}.architecture b,.architecture em,.architecture small{display:block}.architecture em{margin-top:4px;color:var(--blue);font:600 .55rem/1.2 ui-monospace,monospace;font-style:normal}.architecture small{margin-top:4px;color:var(--muted);font-size:.62rem;line-height:1.35}
    .architecture-flows{margin-top:10px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.architecture-flows span{padding:9px 11px;background:rgba(62,110,193,.17);border:1px solid rgba(121,167,255,.22);border-radius:9px}    .architecture-flows b,.architecture-flows em,.architecture-flows small{display:block}.architecture-flows b{font-size:.62rem}.architecture-flows em{margin-top:3px;color:var(--blue);font-size:.55rem;font-style:normal}.architecture-flows small{margin-top:3px;color:var(--muted);font-size:.54rem}
    .architecture-image{margin-top:24px;display:grid;place-items:center}.architecture-image img{display:block;max-width:100%;max-height:58vh;object-fit:contain;border-radius:14px;box-shadow:0 18px 42px rgba(0,0,0,.28)}
    .architecture-html-frame{display:block;width:100%;height:58vh;margin-top:20px;border:0;border-radius:14px;background:#fff}
    .architecture-generated-svg{display:block;width:100%;max-height:58vh;margin-top:22px;background:#f7f9fc;border-radius:14px}.visual-node rect{fill:#fff;stroke:#b9c8dc;stroke-width:2}.visual-node.assumed rect{stroke-dasharray:8 6}.visual-kind{fill:#3976e8;font:700 17px ui-monospace,monospace;text-transform:uppercase}.visual-label{fill:#253149;font:700 27px Inter,Segoe UI,sans-serif}.visual-tech{fill:#687991;font:600 16px ui-monospace,monospace}.visual-connection{color:#3976e8}.visual-connection polyline{fill:none;stroke:currentColor;stroke-width:5;stroke-linecap:round;stroke-linejoin:round}.visual-connection text{fill:#425671;paint-order:stroke;stroke:#fff;stroke-width:9px;font:700 17px ui-monospace,monospace;text-anchor:middle}.visual-connection marker path{fill:context-stroke}
    @media(max-width:760px){.slide{padding:70px 24px}.slide-number{font-size:4rem}.architecture{grid-template-columns:1fr 1fr}.architecture-flows{grid-template-columns:1fr}ul{grid-template-columns:1fr}}
    @media print{body{background:#fff}.slide{width:13.333in;min-height:7.5in;page-break-after:always}}
  </style>
</head>
<body class="theme-${escapeHtml(deck.theme)}">${slides}</body>
</html>`;
}

router.post("/slides", async (req, res) => {
  const { projectId, architectureVisualMode } = req.body as {
    projectId?: unknown;
    architectureVisualMode?: unknown;
  };
  if (!isProjectId(projectId)) {
    res.status(400).json({ error: "A valid presentation project ID is required." });
    return;
  }
  if (
    architectureVisualMode !== undefined &&
    architectureVisualMode !== "html" &&
    architectureVisualMode !== "image" &&
    architectureVisualMode !== "narrative-image" &&
    architectureVisualMode !== "narrative-html" &&
    architectureVisualMode !== "validated-json-html"
  ) {
    res.status(400).json({
      error: "architectureVisualMode must name one of the five architecture visuals.",
    });
    return;
  }
  const project = await getProject(projectId);
  if (!project) {
    res.status(404).json({ error: "Presentation project not found." });
    return;
  }
  const storyAssetId = project.currentAssets.story;
  const architectureAssetId = project.currentAssets.architecture;
  if (!storyAssetId || !architectureAssetId) {
    res.status(409).json({
      error: "Approved story and architecture assets are required before generating slides.",
    });
    return;
  }
  const [storyAsset, architectureAsset] = await Promise.all([
    readProjectAsset(project.id, storyAssetId),
    readProjectAsset(project.id, architectureAssetId),
  ]);
  if (!storyAsset || !architectureAsset) {
    res.status(409).json({ error: "Required project assets could not be resolved." });
    return;
  }
  const story = JSON.parse(storyAsset.content) as {
    approvedSections?: unknown;
  };
  const approvedSections = Array.isArray(story.approvedSections)
    ? new Set(story.approvedSections)
    : new Set();
  if (!["problem", "userStory", "architecture"].every(
    section => approvedSections.has(section),
  )) {
    res.status(409).json({
      error: "All three story sections must be approved before generating slides.",
    });
    return;
  }

  let session: SlideSession | null = null;
  try {
    const architecture = JSON.parse(architectureAsset.content) as ArchitectureGraph;
    const repositoryEvidence = await repositoryPromptContext(project.id);
    let content: string;
    if (isHostedAgentConfigured()) {
      content = await invokeHostedStructured("slides", {
        brief: project.brief,
        story,
        architecture,
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
      }) as unknown as SlideSession;
      const prompt = [
        SLIDE_DECK_PROMPT,
        "PROJECT BRIEF",
        JSON.stringify(project.brief),
        "APPROVED STORY",
        storyAsset.content,
        "APPROVED ARCHITECTURE",
        architectureAsset.content,
        repositoryEvidence
          ? `UNTRUSTED REPOSITORY EVIDENCE:\n${repositoryEvidence}`
          : "Repository evidence: Not provided",
      ].join("\n\n");
      const response = await session.sendAndWait({ prompt }, 120_000);
      content = (response?.data as { content?: string })?.content ?? "";
    }
    const deck = validateSlideDeck(extractJson(content));
    const modelStored = await storeProjectJsonAsset(
      project.id,
      "slide-model",
      deck,
      currentSourceAssetIds(project, [
        "repository-evidence",
        "story",
        "architecture",
      ]),
      { title: deck.title, slideCount: deck.slides.length },
    );
    const layoutAssetId = project.currentAssets["architecture-layout"];
    const imageAssetId = project.currentAssets["architecture-image"];
    const htmlAssetId = project.currentAssets["architecture-html"];
    const validatedJsonHtmlAssetId =
      project.currentAssets["architecture-validated-json-html"];
    const narrativeImageAssetId = project.currentAssets["architecture-narrative-image"];
    const narrativeHtmlAssetId = project.currentAssets["architecture-narrative-html"];
    const [
      layoutAsset,
      imageAsset,
      htmlArchitectureAsset,
      validatedJsonHtmlAsset,
      narrativeImageAsset,
      narrativeHtmlAsset,
    ] = await Promise.all([
      layoutAssetId ? readProjectAsset(project.id, layoutAssetId) : null,
      imageAssetId ? readProjectBinaryAsset(project.id, imageAssetId) : null,
      htmlAssetId ? readProjectAsset(project.id, htmlAssetId) : null,
      validatedJsonHtmlAssetId
        ? readProjectAsset(project.id, validatedJsonHtmlAssetId)
        : null,
      narrativeImageAssetId
        ? readProjectBinaryAsset(project.id, narrativeImageAssetId)
        : null,
      narrativeHtmlAssetId
        ? readProjectAsset(project.id, narrativeHtmlAssetId)
        : null,
    ]);
    const selectedVisualMode =
      typeof architectureVisualMode === "string"
        ? architectureVisualMode
        : "image";
    const visual = selectedVisualMode === "narrative-image" && narrativeImageAsset
      ? { imageDataUrl: `data:image/png;base64,${Buffer.from(narrativeImageAsset.content).toString("base64")}` }
      : selectedVisualMode === "narrative-html" && narrativeHtmlAsset
        ? { htmlDocument: narrativeHtmlAsset.content }
      : selectedVisualMode === "validated-json-html" && validatedJsonHtmlAsset
        ? { htmlDocument: validatedJsonHtmlAsset.content }
      : selectedVisualMode === "image" && imageAsset
      ? { imageDataUrl: `data:image/png;base64,${Buffer.from(imageAsset.content).toString("base64")}` }
      : selectedVisualMode === "html" && htmlArchitectureAsset
        ? { htmlDocument: htmlArchitectureAsset.content }
        : layoutAsset
      ? { layout: JSON.parse(layoutAsset.content) as ArchitectureVisualLayout }
      : imageAsset
        ? { imageDataUrl: `data:image/png;base64,${Buffer.from(imageAsset.content).toString("base64")}` }
        : htmlArchitectureAsset
          ? { htmlDocument: htmlArchitectureAsset.content }
        : undefined;
    const html = renderSlideDeckHtml(deck, architecture, visual);
    const slideSources = [
      modelStored.asset.id,
      storyAssetId,
      architectureAssetId,
      layoutAssetId,
      imageAssetId,
      htmlAssetId,
      validatedJsonHtmlAssetId,
      narrativeImageAssetId,
      narrativeHtmlAssetId,
    ].filter((id): id is string => Boolean(id));
    const htmlStored = await storeProjectTextAsset(
      project.id,
      "slide-deck",
      "html",
      html,
      slideSources,
      { title: deck.title, slideCount: deck.slides.length },
    );
    res.status(201).json({
      deck,
      assets: {
        model: modelStored.asset,
        html: htmlStored.asset,
      },
      previewUrl: `/projects/${project.id}/slides/preview`,
      downloadUrl: `/projects/${project.id}/slides/download`,
    });
  } catch (error) {
    const enhanced = enhanceModelError(error);
    res.status(500).json({ error: enhanced.message });
  } finally {
    await session?.destroy();
  }
});

async function sendStoredDeck(
  projectId: string,
  disposition: "inline" | "attachment",
  res: Parameters<Parameters<typeof router.get>[1]>[1],
): Promise<void> {
  const project = await getProject(projectId);
  const assetId = project?.currentAssets["slide-deck"];
  const stored = assetId ? await readProjectAsset(projectId, assetId) : null;
  if (!stored) {
    res.status(404).json({ error: "Generated slide deck not found." });
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `${disposition}; filename="presentation-slides.html"`,
  );
  res.send(stored.content);
}

router.get("/projects/:projectId/slides/preview", async (req, res) => {
  await sendStoredDeck(req.params.projectId, "inline", res);
});

router.get("/projects/:projectId/slides/download", async (req, res) => {
  await sendStoredDeck(req.params.projectId, "attachment", res);
});

export default router;
