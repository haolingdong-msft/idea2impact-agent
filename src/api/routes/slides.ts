import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
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
  generateArchitectureImage,
  isArchitectureImageConfigured,
} from "../architecture-visual.js";
import { applyArchitectureImageLayoutGuard } from "../architecture-html-layout.js";
import {
  currentSourceAssetIds,
  clearCurrentProjectAssets,
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

const router = Router();
const require = createRequire(import.meta.url);
type ImageDeckPresentation = {
  layout: string;
  author: string;
  subject: string;
  title: string;
  company: string;
  addSlide(): {
    background: { color: string };
    addImage(options: {
      data: string;
      x: number;
      y: number;
      w: number;
      h: number;
    }): void;
  };
  write(options: {
    outputType: "uint8array";
  }): Promise<string | ArrayBuffer | Blob | Uint8Array>;
};
type ImageDeckPresentationConstructor = new () => ImageDeckPresentation;
const pptxExports = new Map<string, Promise<Uint8Array>>();
type SlideGenerationProgress = {
  status: "idle" | "running" | "completed" | "failed";
  percent: number;
  stage: string;
  log: string;
  completedSlides: number;
  totalSlides: number;
  startedAt?: string;
  error?: string;
};
const slideGenerationProgress = new Map<string, SlideGenerationProgress>();
const EDITABLE_DECK_SKILL_TIMEOUT_MS = 45 * 60_000;
const EDITABLE_DECK_POLL_MS = process.env.NODE_ENV === "test" ? 0 : 5_000;

type EditableDeckSkillPayload = {
  jobId?: unknown;
  status?: unknown;
  invocationId?: unknown;
  runId?: unknown;
  workflow?: unknown;
  validationPassed?: unknown;
  sourceImageSha256s?: unknown;
  pptxBase64?: unknown;
};

export type SlideKind =
  | "title"
  | "problem"
  | "user-scenarios"
  | "solution"
  | "architecture"
  | "summary";

export type Slide = {
  id: string;
  kind: SlideKind;
  eyebrow: string;
  title: string;
  subtitle: string;
  bullets: string[];
  imageUrl?: string;
  visualPoints?: string[];
};

const SLIDE_SECTION_VISUAL_RULES: Record<
  "problem" | "user-scenarios" | "solution",
  string
> = {
  problem:
    "Focus only on user pain, context, impact, scope, and desired outcome. " +
    "Do not depict or name platforms, architecture, components, deployment, " +
    "APIs, protocols, integrations, or implementation.",
  "user-scenarios":
    "Focus only on actors, goals, journeys, decisions, edge cases, and user value. " +
    "Do not depict or name platforms, architecture, components, deployment, " +
    "APIs, protocols, integrations, or implementation.",
  solution:
    "Focus on the supported solution. You may depict capabilities, architecture, " +
    "platforms, components, integrations, constraints, and implementation only " +
    "when grounded in the approved solution or overview.",
};

export function buildSlideImagePrompt(input: {
  slide: Slide;
  approvedSection: string;
  visualPoints: string[];
  overviewGrounding: string;
}): string {
  const { slide, approvedSection, visualPoints, overviewGrounding } = input;
  const sectionRule =
    SLIDE_SECTION_VISUAL_RULES[
      slide.kind as keyof typeof SLIDE_SECTION_VISUAL_RULES
    ];
  if (!sectionRule) {
    throw new Error(`Slide image prompting does not support ${slide.kind} slides.`);
  }
  return [
    "Create a premium editorial presentation infographic.",
    "Use a clean 16:9 composition, strong visual hierarchy, and generous negative space.",
    "Keep every visual element and every character fully inside a 10% safe margin; nothing may touch or cross the canvas edge.",
    "Design for object-fit contain inside the slide, with no cropping or edge overflow.",
    "The APPROVED SECTION below is the immutable source of truth.",
    sectionRule,
    "Depict only concrete facts allowed by that section rule and supported by the approved section.",
    "Do not add generic presentation imagery or unsupported actors, products, platforms, integrations, metrics, or workflows.",
    `Slide section: ${slide.kind}.`,
    `Headline: ${slide.title}.`,
    `Supporting idea: ${slide.subtitle}.`,
    `Grounded points: ${slide.bullets.join("; ")}.`,
    `APPROVED SECTION (verbatim):\n${approvedSection}`,
    "Render every line under TEXT TO RENDER VERBATIM clearly and exactly.",
    "Use those lines as large captions inside the visual flow; do not paraphrase, omit, or misspell them.",
    `TEXT TO RENDER VERBATIM:\n${visualPoints.map((point, index) =>
      `${index + 1}. ${point}`).join("\n")}`,
    ...(slide.kind === "solution"
      ? [`APPROVED OVERVIEW COMPONENTS:\n${overviewGrounding}`]
      : []),
    "Do not add any other text, logos, watermarks, or pseudo-text.",
  ].join("\n");
}

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
  "user-scenarios",
  "solution",
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
  if (
    !Array.isArray(source.slides) ||
    source.slides.length < 3 ||
    source.slides.length > 5
  ) {
    throw new Error("Slide deck must contain between 3 and 5 slides.");
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
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) ||
      ids.has(id) ||
      !SLIDE_KINDS.has(kind) ||
      !title
    ) {
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
  for (const required of ["problem", "user-scenarios", "solution"]) {
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

function renderArchitectureHtmlFragment(document: string): string {
  const styles = [...document.matchAll(
    /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi,
  )].map(match => match[1]).join("\n");
  const body = document.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i)?.[1] ??
    document
      .replace(/<!doctype[^>]*>/gi, "")
      .replace(/<\/?(?:html|head|body)\b[^>]*>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "");
  const scopedStyles = styles
    .replace(/:root/g, ":scope")
    .replace(/\bhtml\b(?=\s*[,>{.#:[\]])/g, ":scope")
    .replace(/\bbody\b(?=\s*[,>{.#:[\]])/g, ":scope");
  return `<div class="architecture-html-embed" data-architecture-html style="width:100%!important;height:100%!important;max-width:100%!important;max-height:100%!important;overflow:hidden!important;contain:layout paint">
    <style>@scope (.architecture-html-embed){${scopedStyles}}</style>
    ${body}
  </div>`;
}

export function renderSlideDeckHtml(
  deck: SlideDeck,
  architecture: ArchitectureGraph,
  visual?: {
    layout?: ArchitectureVisualLayout;
    imageDataUrl?: string;
    htmlDocument?: string;
    slideImages?: Record<string, string>;
    editableVisuals?: boolean;
  },
): string {
  const slides = deck.slides.map((slide, index) => {
    const usesFullCanvasArchitecture =
      slide.kind === "architecture" &&
      Boolean(visual?.htmlDocument || visual?.imageDataUrl);
    const storyImage = visual?.slideImages?.[slide.id];
    const editableStoryVisual = slide.visualPoints?.length
      ? `<div class="editable-story-visual">${slide.visualPoints.map((point, pointIndex) => `
          <div class="editable-story-step">
            <span>${String(pointIndex + 1).padStart(2, "0")}</span>
            <p>${escapeHtml(point)}</p>
          </div>`).join("")}</div>`
      : "";
    const content = visual?.editableVisuals && editableStoryVisual
      ? `<div class="slide-story-layout">${editableStoryVisual}
          <ul>${slide.bullets.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
        </div>`
      : storyImage
      ? `<div class="slide-story-layout">
          <div class="slide-story-image"><img src="${escapeHtml(storyImage)}" alt="${escapeHtml(slide.title)} illustration"></div>
        </div>`
      : slide.kind === "architecture"
      ? visual?.htmlDocument
        ? renderArchitectureHtmlFragment(visual.htmlDocument)
        : visual?.layout
        ? renderArchitectureSvg(architecture, visual.layout)
        : visual?.imageDataUrl
          ? `<div class="architecture-image"><img src="${escapeHtml(visual.imageDataUrl)}" alt="${escapeHtml(architecture.title)} project overview diagram"></div>`
          : renderArchitecture(architecture)
      : `<ul>${slide.bullets.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
    return `<section class="slide slide-${escapeHtml(slide.kind)}${
      usesFullCanvasArchitecture ? " slide-architecture-canvas" : ""
    }${storyImage ? " slide-has-story-image" : ""
    }">
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
    *{box-sizing:border-box}body{margin:0;overflow-x:hidden;background:#0c1422;color:var(--ink);font-family:Inter,Segoe UI,sans-serif;scroll-snap-type:y mandatory}
    .slide{position:relative;width:100vw;min-height:100vh;padding:8vh 8vw;display:flex;flex-direction:column;justify-content:center;overflow:hidden;scroll-snap-align:start;background:radial-gradient(circle at 85% 10%,#183a72 0,transparent 35%),#0c1422}
    .slide:nth-child(even){background:radial-gradient(circle at 12% 85%,#123f4c 0,transparent 38%),#10192a}
    .slide-number{position:absolute;right:7vw;top:6vh;color:#31415b;font:700 7rem/1 Georgia,serif}
    .eyebrow{color:var(--blue);font:700 .72rem/1.3 ui-monospace,monospace;letter-spacing:.16em;text-transform:uppercase}
    h2{max-width:1000px;margin:18px 0 12px;font:400 clamp(2.7rem,6vw,5.6rem)/.98 Georgia,serif;letter-spacing:-.035em}
    .subtitle{max-width:900px;color:var(--muted);font-size:clamp(1rem,1.7vw,1.45rem);line-height:1.5}
    ul{max-width:980px;margin:36px 0 0;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:16px;list-style:none}
    li{padding:18px 20px;background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.1);border-radius:14px;font-size:clamp(.95rem,1.35vw,1.2rem);line-height:1.4}
    .slide-story-layout{margin-top:24px;display:grid;grid-template-columns:minmax(0,1.55fr) minmax(260px,.65fr);gap:24px;align-items:center}
    .slide-story-layout ul{margin:0;display:grid;grid-template-columns:1fr;gap:12px}
    .slide-story-image{height:54vh;min-height:340px;display:grid;place-items:center;overflow:hidden;border-radius:18px;background:rgba(255,255,255,.035)}
    .slide-story-image img{display:block;width:100%;height:100%;object-fit:contain;object-position:center}
    .slide-has-story-image{display:block;width:100vw;height:100vh;min-height:100vh;padding:0;background:#000}
    .slide-has-story-image>.slide-number,.slide-has-story-image>.eyebrow,.slide-has-story-image>h2,.slide-has-story-image>.subtitle{display:none}
    .slide-has-story-image .slide-story-layout{display:block;width:100vw;height:100vh;min-height:0;margin:0}
    .slide-has-story-image .slide-story-image{width:100%;height:100%;min-height:0;overflow:hidden;border-radius:0;background:#000}
    .slide-has-story-image .slide-story-image img{width:100%;height:100%;object-fit:contain;object-position:center}
    .editable-story-visual{height:46vh;min-height:300px;display:grid;grid-template-columns:repeat(3,1fr);gap:14px;align-items:center}
    .editable-story-step{position:relative;min-height:210px;padding:24px 18px;border:2px solid rgba(121,167,255,.45);border-radius:18px;background:linear-gradient(145deg,rgba(34,66,118,.9),rgba(20,36,62,.95))}
    .editable-story-step:not(:last-child):after{content:"→";position:absolute;right:-23px;top:44%;z-index:2;color:#79a7ff;font-size:30px;font-weight:800}
    .editable-story-step span{display:block;color:#79a7ff;font:800 16px ui-monospace,monospace}.editable-story-step p{margin:24px 0 0;color:#fff;font-size:18px;line-height:1.35}
    .architecture{margin-top:32px;display:grid;grid-template-columns:repeat(${Math.min(architecture.layers.length, 5)},minmax(0,1fr));gap:14px}
    .architecture article{padding:16px;background:rgba(255,255,255,.06);border:1px solid rgba(121,167,255,.24);border-top:3px solid var(--blue);border-radius:14px}
    .architecture header{font-weight:800;font-size:1rem}.architecture article>p{min-height:42px;color:var(--muted);font-size:.72rem;line-height:1.4}
    .architecture article>div{display:grid;gap:8px}.architecture span{padding:10px;background:rgba(12,20,34,.7);border-radius:9px}.architecture span.assumed,.architecture-flows span.assumed{border:1px dashed #dca85f}.architecture b,.architecture em,.architecture small{display:block}.architecture em{margin-top:4px;color:var(--blue);font:600 .55rem/1.2 ui-monospace,monospace;font-style:normal}.architecture small{margin-top:4px;color:var(--muted);font-size:.62rem;line-height:1.35}
    .architecture-flows{margin-top:10px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.architecture-flows span{padding:9px 11px;background:rgba(62,110,193,.17);border:1px solid rgba(121,167,255,.22);border-radius:9px}    .architecture-flows b,.architecture-flows em,.architecture-flows small{display:block}.architecture-flows b{font-size:.62rem}.architecture-flows em{margin-top:3px;color:var(--blue);font-size:.55rem;font-style:normal}.architecture-flows small{margin-top:3px;color:var(--muted);font-size:.54rem}
    .architecture-image{margin-top:24px;display:grid;place-items:center}.architecture-image img{display:block;max-width:100%;max-height:58vh;object-fit:contain;border-radius:14px;box-shadow:0 18px 42px rgba(0,0,0,.28)}
    .architecture-html-embed{display:block;width:100%;height:58vh;margin-top:20px;overflow:auto;border:0;border-radius:14px;background:#fff;color:#0f274d}
    .slide-architecture-canvas{display:block;padding:0;background:#fff}
    .slide-architecture-canvas>.slide-number,.slide-architecture-canvas>.eyebrow,.slide-architecture-canvas>h2,.slide-architecture-canvas>.subtitle{display:none}
    .slide-architecture-canvas .architecture-html-embed{width:100vw!important;height:100vh!important;max-width:100vw!important;max-height:100vh!important;margin:0;border-radius:0;overflow:hidden!important;contain:layout paint}
    .slide-architecture-canvas .architecture-image{width:100vw;height:100vh;margin:0}
    .slide-architecture-canvas .architecture-image img{width:100%;height:100%;max-width:none;max-height:none;object-fit:contain;border-radius:0;box-shadow:none}
    .architecture-generated-svg{display:block;width:100%;max-height:58vh;margin-top:22px;background:#f7f9fc;border-radius:14px}.visual-node rect{fill:#fff;stroke:#b9c8dc;stroke-width:2}.visual-node.assumed rect{stroke-dasharray:8 6}.visual-kind{fill:#3976e8;font:700 17px ui-monospace,monospace;text-transform:uppercase}.visual-label{fill:#253149;font:700 27px Inter,Segoe UI,sans-serif}.visual-tech{fill:#687991;font:600 16px ui-monospace,monospace}.visual-connection{color:#3976e8}.visual-connection polyline{fill:none;stroke:currentColor;stroke-width:5;stroke-linecap:round;stroke-linejoin:round}.visual-connection text{fill:#425671;paint-order:stroke;stroke:#fff;stroke-width:9px;font:700 17px ui-monospace,monospace;text-anchor:middle}.visual-connection marker path{fill:context-stroke}
    @media(max-width:760px){.slide{padding:70px 24px}.slide-number{font-size:4rem}.slide-story-layout{grid-template-columns:1fr}.slide-story-image{height:34vh;min-height:220px}.architecture{grid-template-columns:1fr 1fr}.architecture-flows{grid-template-columns:1fr}ul{grid-template-columns:1fr}}
    @media print{body{background:#fff}.slide{width:13.333in;height:7.5in;min-height:7.5in;page-break-after:always}.slide-has-story-image .slide-story-layout{width:13.333in;height:7.5in}}
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
    architectureVisualMode !== "validated-json-html" &&
    architectureVisualMode !== "image-html"
  ) {
    res.status(400).json({
      error: "The overview visual mode must name one of the six supported visuals.",
    });
    return;
  }
  const project = await getProject(projectId);
  if (!project) {
    res.status(404).json({ error: "Presentation project not found." });
    return;
  }
  slideGenerationProgress.set(project.id, {
    status: "running",
    percent: 5,
    stage: "Preparing",
    log: "Loading the approved outline and project overview.",
    completedSlides: 0,
    totalSlides: 0,
    startedAt: new Date().toISOString(),
  });
  const outlineAssetId = project.currentAssets.outline;
  const architectureAssetId = project.currentAssets.architecture;
  if (!outlineAssetId || !architectureAssetId) {
    res.status(409).json({
      error: "Approved outline and overview assets are required before generating slides.",
    });
    return;
  }
  const [outlineAsset, architectureAsset] = await Promise.all([
    readProjectAsset(project.id, outlineAssetId),
    readProjectAsset(project.id, architectureAssetId),
  ]);
  if (!outlineAsset || !architectureAsset) {
    res.status(409).json({ error: "Required project assets could not be resolved." });
    return;
  }
  const outline = JSON.parse(outlineAsset.content) as {
    status?: unknown;
    problemStatement?: unknown;
    userScenarios?: unknown;
    solution?: unknown;
  };
  if (outline.status !== "approved") {
    res.status(409).json({
      error: "The current outline must be approved before generating slides.",
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
        outline,
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
        "APPROVED OUTLINE",
        outlineAsset.content,
        "APPROVED ARCHITECTURE",
        architectureAsset.content,
        repositoryEvidence
          ? `UNTRUSTED REPOSITORY EVIDENCE:\n${repositoryEvidence}`
          : "Repository evidence: Not provided",
      ].join("\n\n");
      const response = await session.sendAndWait({ prompt }, 120_000);
      content = (response?.data as { content?: string })?.content ?? "";
    }
    const generatedDeck = validateSlideDeck(extractJson(content));
    slideGenerationProgress.set(project.id, {
      ...slideGenerationProgress.get(project.id)!,
      percent: 20,
      stage: "Planning",
      log: `Planned ${generatedDeck.slides.length} slides; starting visuals.`,
      totalSlides: generatedDeck.slides.length,
    });
    if (!isArchitectureImageConfigured()) {
      throw new Error(
        "Project overview slide images require ARCHITECTURE_MODEL_ENDPOINT and " +
        "ARCHITECTURE_IMAGE_DEPLOYMENT.",
      );
    }
    await clearCurrentProjectAssets(project.id, [
      ...Object.keys(project.currentAssets)
        .filter(type => type.startsWith("slide-image-")) as `slide-image-${string}`[],
      "slide-model",
      "slide-deck",
      "slide-deck-pptx",
    ]);
    const approvedSections = {
      problem: text(outline.problemStatement, 6_000),
      "user-scenarios": text(outline.userScenarios, 6_000),
      solution: text(outline.solution, 6_000),
    } as const;
    const approvedVisualPoints = (value: string): string[] =>
      (value.match(/[^.!?。！？]+[.!?。！？]?/g) ?? [])
        .map(sentence => sentence.trim())
        .filter(Boolean)
        .slice(0, 3);
    const overviewGrounding = architecture.layers
      .flatMap(layer => layer.nodes.map(node =>
        `${node.label} (${node.technology}): ${node.description}`))
      .join("; ")
      .slice(0, 4_000);
    let completedImages = 0;
    const imageBytes = await Promise.all(generatedDeck.slides.map(async slide => {
      const approvedSection =
        approvedSections[slide.kind as keyof typeof approvedSections];
      if (!approvedSection) {
        throw new Error(`Approved ${slide.kind} content is required for its slide image.`);
      }
      const visualPoints = approvedVisualPoints(approvedSection);
      const bytes = await generateArchitectureImage(buildSlideImagePrompt({
        slide,
        approvedSection,
        visualPoints,
        overviewGrounding,
      }), "validated-architecture", ({ attempt, delaySeconds }) => {
        slideGenerationProgress.set(project.id, {
          ...slideGenerationProgress.get(project.id)!,
          stage: "Waiting for image capacity",
          log:
            `Image service is busy. Retrying visual ${completedImages + 1}/` +
            `${generatedDeck.slides.length} in ${delaySeconds}s ` +
            `(attempt ${attempt}/4).`,
        });
      });
      completedImages += 1;
      slideGenerationProgress.set(project.id, {
        ...slideGenerationProgress.get(project.id)!,
        percent: 20 + Math.round(
          (completedImages / generatedDeck.slides.length) * 65,
        ),
        stage: "Generating visuals",
        log:
          `Finished visual ${completedImages}/${generatedDeck.slides.length}: ` +
          slide.title,
        completedSlides: completedImages,
      });
      return bytes;
    }));
    slideGenerationProgress.set(project.id, {
      ...slideGenerationProgress.get(project.id)!,
      percent: 88,
      stage: "Storing assets",
      log: "Saving slide images and editable slide content.",
    });
    const imageAssets: Awaited<ReturnType<typeof storeProjectBinaryAsset>>[] = [];
    for (const [index, slide] of generatedDeck.slides.entries()) {
      imageAssets.push(await storeProjectBinaryAsset(
        project.id,
        `slide-image-${slide.id}`,
        "png",
        imageBytes[index],
        currentSourceAssetIds(project, ["outline", "architecture"]),
        {
          renderer: "gpt-image-2",
          slideId: slide.id,
          slideKind: slide.kind,
          approvedOutlineAssetId: outlineAssetId,
          groundedInApprovedSection: true,
          width: 1536,
          height: 864,
        },
      ));
    }
    const deck: SlideDeck = {
      ...generatedDeck,
      slides: generatedDeck.slides.map(slide => ({
        ...slide,
        imageUrl: `/projects/${project.id}/slides/${slide.id}/image`,
        visualPoints: approvedVisualPoints(
          approvedSections[slide.kind as keyof typeof approvedSections],
        ),
      })),
    };
    const modelStored = await storeProjectJsonAsset(
      project.id,
      "slide-model",
      deck,
      currentSourceAssetIds(project, [
        "repository-evidence",
        "outline",
        "architecture",
      ]),
      { title: deck.title, slideCount: deck.slides.length },
    );
    const layoutAssetId = project.currentAssets["architecture-layout"];
    const imageAssetId = project.currentAssets["architecture-image"];
    const htmlAssetId = project.currentAssets["architecture-html"];
    const validatedJsonHtmlAssetId =
      project.currentAssets["architecture-validated-json-html"];
    const imageDerivedHtmlAssetId =
      project.currentAssets["architecture-image-derived-html"];
    const narrativeImageAssetId = project.currentAssets["architecture-narrative-image"];
    const narrativeHtmlAssetId = project.currentAssets["architecture-narrative-html"];
    const [
      layoutAsset,
      imageAsset,
      htmlArchitectureAsset,
      validatedJsonHtmlAsset,
      imageDerivedHtmlAsset,
      narrativeImageAsset,
      narrativeHtmlAsset,
    ] = await Promise.all([
      layoutAssetId ? readProjectAsset(project.id, layoutAssetId) : null,
      imageAssetId ? readProjectBinaryAsset(project.id, imageAssetId) : null,
      htmlAssetId ? readProjectAsset(project.id, htmlAssetId) : null,
      validatedJsonHtmlAssetId
        ? readProjectAsset(project.id, validatedJsonHtmlAssetId)
        : null,
      imageDerivedHtmlAssetId
        ? readProjectAsset(project.id, imageDerivedHtmlAssetId)
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
    const storyImages = Object.fromEntries(
      deck.slides.map((slide, index) => [
        slide.id,
        `data:image/png;base64,${Buffer.from(imageBytes[index]).toString("base64")}`,
      ]),
    ) as Record<string, string>;
    const visual = selectedVisualMode === "narrative-image" && narrativeImageAsset
      ? { imageDataUrl: `data:image/png;base64,${Buffer.from(narrativeImageAsset.content).toString("base64")}` }
      : selectedVisualMode === "narrative-html" && narrativeHtmlAsset
        ? { htmlDocument: narrativeHtmlAsset.content }
      : selectedVisualMode === "validated-json-html" && validatedJsonHtmlAsset
        ? { htmlDocument: validatedJsonHtmlAsset.content }
      : selectedVisualMode === "image-html" && imageDerivedHtmlAsset
        ? {
            htmlDocument:
              applyArchitectureImageLayoutGuard(imageDerivedHtmlAsset.content),
          }
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
        : { slideImages: storyImages };
    visual.slideImages = storyImages;
    const html = renderSlideDeckHtml(deck, architecture, visual);
    slideGenerationProgress.set(project.id, {
      ...slideGenerationProgress.get(project.id)!,
      percent: 96,
      stage: "Assembling deck",
      log: "Rendering the HTML preview and recording asset lineage.",
    });
    const slideSources = [
      modelStored.asset.id,
      outlineAssetId,
      architectureAssetId,
      layoutAssetId,
      imageAssetId,
      htmlAssetId,
      validatedJsonHtmlAssetId,
      imageDerivedHtmlAssetId,
      narrativeImageAssetId,
      narrativeHtmlAssetId,
      ...imageAssets.map(storedImage => storedImage.asset.id),
    ].filter((id): id is string => Boolean(id));
    const htmlStored = await storeProjectTextAsset(
      project.id,
      "slide-deck",
      "html",
      html,
      slideSources,
      { title: deck.title, slideCount: deck.slides.length },
    );
    slideGenerationProgress.set(project.id, {
      ...slideGenerationProgress.get(project.id)!,
      status: "completed",
      percent: 100,
      stage: "Complete",
      log: `${deck.slides.length} slides are ready for review.`,
      completedSlides: deck.slides.length,
    });
    res.status(201).json({
      deck,
      assets: {
        model: modelStored.asset,
        html: htmlStored.asset,
      },
      previewUrl: `/projects/${project.id}/slides/preview`,
      downloadUrl: `/projects/${project.id}/slides/download`,
      pptxDownloadUrl: `/projects/${project.id}/slides/download.pptx`,
      pptxGenerateUrl:
        `/projects/${project.id}/slides/generate-editable-pptx`,
    });
  } catch (error) {
    const enhanced = enhanceModelError(error);
    slideGenerationProgress.set(project.id, {
      ...(slideGenerationProgress.get(project.id) || {
        percent: 0,
        stage: "Failed",
        log: "",
        completedSlides: 0,
        totalSlides: 0,
      }),
      status: "failed",
      stage: "Failed",
      log: enhanced.message,
      error: enhanced.message,
    });
    res.status(500).json({ error: enhanced.message });
  } finally {
    await session?.destroy();
  }
});

router.get("/projects/:projectId/slides/progress", async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Presentation project not found." });
    return;
  }
  res.json(slideGenerationProgress.get(project.id) || {
    status: "idle",
    percent: 0,
    stage: "Idle",
    log: "Slide generation has not started.",
    completedSlides: 0,
    totalSlides: 0,
  });
});

async function sendStoredDeck(
  projectId: string,
  disposition: "inline" | "attachment",
  res: Parameters<Parameters<typeof router.get>[1]>[1],
): Promise<void> {
  const project = await getProject(projectId);
  const modelAssetId = project?.currentAssets["slide-model"];
  const architectureAssetId = project?.currentAssets.architecture;
  const [modelAsset, architectureAsset] = await Promise.all([
    modelAssetId ? readProjectAsset(projectId, modelAssetId) : null,
    architectureAssetId ? readProjectAsset(projectId, architectureAssetId) : null,
  ]);
  if (!project || !modelAsset || !architectureAsset) {
    res.status(404).json({ error: "Generated slide deck not found." });
    return;
  }
  const deck = JSON.parse(modelAsset.content) as SlideDeck;
  const imageAssets = await Promise.all(deck.slides.map(slide => {
    const assetId = project.currentAssets[`slide-image-${slide.id}`];
    return assetId ? readProjectBinaryAsset(projectId, assetId) : null;
  }));
  if (imageAssets.some(image => !image)) {
    res.status(404).json({ error: "Generated slide images not found." });
    return;
  }
  const slideImages = Object.fromEntries(deck.slides.map((slide, index) => [
    slide.id,
    `data:image/png;base64,${
      Buffer.from(imageAssets[index]!.content).toString("base64")
    }`,
  ]));
  const html = renderSlideDeckHtml(
    deck,
    JSON.parse(architectureAsset.content) as ArchitectureGraph,
    { slideImages },
  );
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `${disposition}; filename="presentation-slides.html"`,
  );
  res.send(html);
}

router.get("/projects/:projectId/slides/preview", async (req, res) => {
  await sendStoredDeck(req.params.projectId, "inline", res);
});

router.get("/projects/:projectId/slides/download", async (req, res) => {
  await sendStoredDeck(req.params.projectId, "attachment", res);
});

async function getImageDeckPptx(projectId: string): Promise<Uint8Array> {
  const project = await getProject(projectId);
  if (!project) {
    throw new Error("Presentation project not found.");
  }
  const modelAssetId = project.currentAssets["slide-model"];
  if (!modelAssetId) {
    throw new Error("Generated slide model not found.");
  }
  const currentPptxId = project.currentAssets["slide-deck-pptx"];
  const currentPptx = currentPptxId
    ? await readProjectBinaryAsset(projectId, currentPptxId)
    : null;
  if (
    currentPptx?.asset.sourceAssetIds.includes(modelAssetId) &&
    currentPptx.asset.metadata.conversionWorkflow === "full-slide-images"
  ) {
    return currentPptx.content;
  }
  const modelAsset = await readProjectAsset(projectId, modelAssetId);
  if (!modelAsset) {
    throw new Error("Stored slide model could not be read.");
  }
  const deck = JSON.parse(modelAsset.content) as SlideDeck;
  const imageAssetIds = deck.slides.map(
    slide => project.currentAssets[`slide-image-${slide.id}`],
  );
  const resolvedImageAssetIds = imageAssetIds.filter(
    (id): id is string => Boolean(id),
  );
  if (resolvedImageAssetIds.length !== deck.slides.length) {
    throw new Error("One or more generated slide image assets are missing.");
  }
  const images = await Promise.all(
    resolvedImageAssetIds.map(id => readProjectBinaryAsset(projectId, id)),
  );
  if (images.some(image => !image)) {
    throw new Error("One or more generated slide image files could not be read.");
  }

  const PptxConstructor =
    require("pptxgenjs") as ImageDeckPresentationConstructor;
  const pptx = new PptxConstructor();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Idea2Impact Agent";
  pptx.subject = deck.subtitle;
  pptx.title = deck.title;
  pptx.company = "GitHub";
  for (const image of images) {
    const slide = pptx.addSlide();
    slide.background = { color: "000000" };
    slide.addImage({
      data: `data:image/png;base64,${
        Buffer.from(image!.content).toString("base64")
      }`,
      x: 0,
      y: 0,
      w: 13.333,
      h: 7.5,
    });
  }
  const output = await pptx.write({ outputType: "uint8array" });
  if (!(output instanceof Uint8Array)) {
    throw new Error("PPTX generator returned an unexpected output type.");
  }
  await storeProjectBinaryAsset(
    projectId,
    "slide-deck-pptx",
    "pptx",
    output,
    [modelAssetId, ...resolvedImageAssetIds],
    {
      title: deck.title,
      slideCount: deck.slides.length,
      editable: false,
      conversionWorkflow: "full-slide-images",
      fullSlideScreenshot: true,
    },
  );
  return output;
}

router.post(
  "/projects/:projectId/slides/generate-editable-pptx",
  async (req, res) => {
    const project = await getProject(req.params.projectId);
    const modelAssetId = project?.currentAssets["slide-model"];
    const modelAsset = modelAssetId
      ? await readProjectAsset(req.params.projectId, modelAssetId)
      : null;
    const deck = modelAsset
      ? JSON.parse(modelAsset.content) as SlideDeck
      : null;
    const imageAssetIds = project && deck
      ? deck.slides.map(slide => project.currentAssets[`slide-image-${slide.id}`])
      : [];
    if (!project || !modelAssetId || !deck || imageAssetIds.some(id => !id)) {
      res.status(404).json({ error: "Generated slide images not found." });
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
    const storedImages = await Promise.all(
      imageAssetIds.map(id => readProjectBinaryAsset(project.id, id!)),
    );
    if (storedImages.some(image => !image)) {
      res.status(404).json({ error: "Generated slide images not found." });
      return;
    }
    const sourceImages = storedImages.map(image => {
      const bytes = Buffer.from(image!.content);
      return {
        sourceAssetId: image!.asset.id,
        sourceImageBase64: bytes.toString("base64"),
        sourceImageSha256: createHash("sha256").update(bytes).digest("hex"),
      };
    });
    const invocationKey = `${project.id}:${sourceImages
      .map(image => image.sourceAssetId)
      .join(":")}`;
    let exportPromise = pptxExports.get(invocationKey);
    if (!exportPromise) {
      exportPromise = (async () => {
        const startResponse = await invokeHostedAgent(
          "start-images-to-editable-ppt",
          { projectId: project.id, sourceImages },
          randomUUID(),
          60_000,
        );
        const started = await startResponse.json() as EditableDeckSkillPayload;
        const jobId = typeof started.jobId === "string"
          ? started.jobId.trim()
          : "";
        const sessionId = startResponse.headers.get("x-agent-session-id") || "";
        if (!jobId || started.status !== "running" || !sessionId) {
          throw new Error("Skill runner did not start an editable deck job.");
        }
        const deadline = Date.now() + EDITABLE_DECK_SKILL_TIMEOUT_MS;
        let payload: EditableDeckSkillPayload = started;
        while (payload.status === "running" && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, EDITABLE_DECK_POLL_MS));
          const statusResponse = await invokeHostedAgent(
            "editable-ppt-status",
            { jobId },
            randomUUID(),
            60_000,
            sessionId,
          );
          payload = await statusResponse.json() as EditableDeckSkillPayload;
        }
        if (payload.status !== "completed") {
          throw new Error("Skill runner timed out while reconstructing the deck.");
        }
        const invocationId = typeof payload.invocationId === "string"
          ? payload.invocationId.trim()
          : "";
        const runId = typeof payload.runId === "string"
          ? payload.runId.trim()
          : "";
        const sourceImageSha256s = sourceImages.map(
          image => image.sourceImageSha256,
        );
        if (
          payload.workflow !== "image-to-editable-ppt" ||
          payload.validationPassed !== true ||
          JSON.stringify(payload.sourceImageSha256s) !==
            JSON.stringify(sourceImageSha256s) ||
          !invocationId ||
          !runId ||
          typeof payload.pptxBase64 !== "string"
        ) {
          throw new Error("Skill runner returned invalid editable deck lineage.");
        }
        const pptx = Buffer.from(payload.pptxBase64, "base64");
        if (!pptx.subarray(0, 2).equals(Buffer.from("PK"))) {
          throw new Error("Skill runner returned an invalid PPTX package.");
        }
        await storeProjectBinaryAsset(
          project.id,
          "slide-deck-pptx",
          "pptx",
          pptx,
          [modelAssetId, ...sourceImages.map(image => image.sourceAssetId)],
          {
            title: project.brief.title,
            slideCount: sourceImages.length,
            editable: true,
            conversionWorkflow: "image-to-editable-ppt",
            editpptValidationPassed: true,
            skillInvocationId: invocationId,
            editpptRunId: runId,
            sourceImageSha256s: JSON.stringify(sourceImageSha256s),
            fullSlideScreenshot: false,
          },
        );
        return new Uint8Array(pptx);
      })();
      pptxExports.set(invocationKey, exportPromise);
    }
    try {
      await exportPromise;
      const current = await getProject(project.id);
      const assetId = current?.currentAssets["slide-deck-pptx"];
      const asset = current?.assets.find(item => item.id === assetId);
      if (!assetId || !asset) {
        throw new Error("Editable slide deck was not stored.");
      }
      res.status(201).json({
        invocationId: asset.metadata.skillInvocationId,
        runId: asset.metadata.editpptRunId,
        assetId,
        downloadUrl: `/projects/${project.id}/slides/download.pptx`,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      pptxExports.delete(invocationKey);
    }
  },
);

router.get("/projects/:projectId/slides/download.pptx", async (req, res) => {
  try {
    const pptx = await getImageDeckPptx(req.params.projectId);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="presentation-slides.pptx"',
    );
    res.send(Buffer.from(pptx));
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

router.get("/projects/:projectId/slides/:slideId/image", async (req, res) => {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(req.params.slideId)) {
    res.status(404).json({ error: "Overview slide image not found." });
    return;
  }
  const assetType =
    `slide-image-${req.params.slideId}` as `slide-image-${string}`;
  const project = await getProject(req.params.projectId);
  const assetId = project?.currentAssets[assetType];
  const stored = assetId
    ? await readProjectBinaryAsset(req.params.projectId, assetId)
    : null;
  if (!stored) {
    res.status(404).json({ error: "Overview slide image not found." });
    return;
  }
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "private, max-age=300");
  res.send(Buffer.from(stored.content));
});

export default router;
