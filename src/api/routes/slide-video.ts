import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Router } from "express";
import { getClient } from "../client.js";
import {
  supportedSpeechVoice,
  synthesizeSpeech,
} from "../azure-speech.js";
import { enhanceModelError, getSessionOptions } from "../model-config.js";
import {
  PRESENTATION_AGENT_INSTRUCTIONS,
  SPEECH_SCRIPT_PROMPT,
} from "../presentation-instructions.js";
import {
  invokeHostedStructured,
  isHostedAgentConfigured,
} from "../hosted-agent-client.js";
import { launchBrowser } from "./pptx-export.js";
import {
  validateSpeechScript,
  type SpeechScript,
} from "./speech.js";
import type { Slide, SlideDeck, SlideKind } from "./slides.js";

const router = Router();
const execFileAsync = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const MAX_HTML_BYTES = (Number(process.env.MAX_SLIDE_HTML_MB) || 15) * 1024 * 1024;
const JOB_ROOT = resolve(
  process.env.SLIDE_VIDEO_WORK_DIR || join(tmpdir(), "idea2impact-agent-slide-video"),
);
const JOB_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_TTL_MS = 24 * 60 * 60 * 1000;

type SpeechSession = {
  sendAndWait(
    message: { prompt: string },
    timeout: number,
  ): Promise<{ data?: unknown } | undefined>;
  destroy(): Promise<void>;
};

export type SlideVideoPlan = {
  jobId: string;
  title: string;
  targetDurationSeconds: number;
  slides: Array<{
    slideId: string;
    slideTitle: string;
    script: string;
    durationSeconds: number;
  }>;
};

function boundedDuration(value: unknown, slideCount = 1): number {
  const parsed = Number(value);
  const minimum = Math.max(6, slideCount * 3);
  return Number.isFinite(parsed)
    ? Math.min(1_800, Math.max(minimum, Math.round(parsed)))
    : Math.max(60, slideCount * 15);
}

function extractJson(content: string): unknown {
  const cleaned = content.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("Copilot returned no slide narration JSON.");
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function trimToWordBudget(value: string, budget: number): string {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length <= budget) return value.trim();
  const trimmed = words.slice(0, budget).join(" ")
    .replace(/[,:;–—-]+$/, "")
    .replace(/[.!?]+$/, "");
  return `${trimmed}.`;
}

export function fitNarrationToDuration(
  script: SpeechScript,
  targetDurationSeconds: number,
): SpeechScript {
  const totalBudget = Math.max(
    script.notes.length * 5,
    Math.round(targetDurationSeconds * 2.25),
  );
  const weights = script.notes.map(note => Math.max(1, wordCount(note.script)));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const budgets = weights.map(weight =>
    Math.max(5, Math.floor(totalBudget * weight / totalWeight)));
  let remaining = totalBudget - budgets.reduce((sum, budget) => sum + budget, 0);
  for (let index = 0; remaining > 0; index = (index + 1) % budgets.length) {
    budgets[index] += 1;
    remaining -= 1;
  }
  return {
    ...script,
    notes: script.notes.map((note, index) => ({
      ...note,
      script: trimToWordBudget(note.script, budgets[index]),
    })),
  };
}

export function allocateSlideDurations(
  scripts: string[],
  targetDurationSeconds: number,
): number[] {
  if (scripts.length === 0) return [];
  const target = boundedDuration(targetDurationSeconds, scripts.length);
  const minimum = 3;
  const distributable = target - minimum * scripts.length;
  const weights = scripts.map(script => Math.max(1, wordCount(script)));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const raw = weights.map(weight => minimum + distributable * weight / totalWeight);
  const rounded = raw.map(value => Math.floor(value * 100) / 100);
  const used = rounded.reduce((sum, value) => sum + value, 0);
  rounded[rounded.length - 1] = Number(
    (rounded[rounded.length - 1] + target - used).toFixed(2),
  );
  return rounded;
}

async function cleanupExpiredJobs(): Promise<void> {
  await mkdir(JOB_ROOT, { recursive: true });
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(JOB_ROOT, { withFileTypes: true });
  await Promise.all(entries
    .filter(entry => entry.isDirectory() && JOB_PATTERN.test(entry.name))
    .map(async entry => {
      const path = join(JOB_ROOT, entry.name);
      if ((await stat(path)).mtimeMs < Date.now() - JOB_TTL_MS) {
        await rm(path, { recursive: true, force: true });
      }
    }));
}

async function readHtmlBody(request: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += bytes.length;
    if (received > MAX_HTML_BYTES) {
      throw new Error(`HTML slide deck exceeds the ${MAX_HTML_BYTES / 1024 / 1024} MB limit.`);
    }
    chunks.push(bytes);
  }
  const html = Buffer.concat(chunks).toString("utf8");
  if (!/^<!doctype html>/i.test(html.trim())) {
    throw new Error("Upload a complete HTML slide deck.");
  }
  return html;
}

async function inspectHtmlDeck(html: string): Promise<SlideDeck> {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", request => {
      const url = request.url();
      if (url.startsWith("data:") || url.startsWith("about:")) {
        void request.continue();
      } else {
        void request.abort();
      }
    });
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    const extracted = await page.evaluate(() => ({
      title: document.title.trim(),
      slides: Array.from(document.querySelectorAll(".slide")).map((element, index) => ({
        id: element.getAttribute("data-slide-id") || `slide-${index + 1}`,
        title: element.querySelector("h1,h2,h3")?.textContent?.trim() ||
          `Slide ${index + 1}`,
        eyebrow: element.querySelector(".eyebrow")?.textContent?.trim() || "",
        subtitle: element.querySelector(".subtitle")?.textContent?.trim() || "",
        bullets: Array.from(element.querySelectorAll("li"))
          .map(item => item.textContent?.trim() || "")
          .filter(Boolean)
          .slice(0, 8),
      })),
    }));
    if (extracted.slides.length === 0 || extracted.slides.length > 30) {
      throw new Error("The HTML deck must contain between 1 and 30 .slide elements.");
    }
    return {
      title: extracted.title || "Imported slide deck",
      subtitle: "Imported HTML slide deck",
      theme: "midnight",
      slides: extracted.slides.map((slide, index): Slide => ({
        ...slide,
        id: /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slide.id)
          ? slide.id
          : `slide-${index + 1}`,
        kind: (
          index === 0 ? "problem" :
          index === extracted.slides.length - 1 ? "solution" :
          "user-scenarios"
        ) as SlideKind,
      })),
    };
  } finally {
    await browser.close();
  }
}

async function generateNarration(
  deck: SlideDeck,
  targetDurationSeconds: number,
): Promise<SpeechScript> {
  const targetWords = Math.max(30, Math.round(targetDurationSeconds * 2.25));
  const outline = {
    problemStatement: deck.slides[0]?.title || deck.title,
    userScenarios: deck.slides.slice(1, -1).map(slide => slide.title).join("; "),
    solution: deck.slides.at(-1)?.title || deck.title,
    status: "approved",
  };
  let session: SpeechSession | null = null;
  try {
    let content: string;
    if (isHostedAgentConfigured()) {
      content = await invokeHostedStructured("speech-script", {
        outline,
        deck,
        targetDurationSeconds,
        targetWords,
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
          `TARGET VIDEO DURATION: ${targetDurationSeconds} seconds.`,
          `TARGET TOTAL NARRATION LENGTH: about ${targetWords} words across all slides.`,
          "Keep each note proportional to the information visible on its slide.",
          "IMPORTED SLIDE DECK",
          JSON.stringify(deck),
        ].join("\n\n"),
      }, 120_000);
      content = (response?.data as { content?: string })?.content ?? "";
    }
    return fitNarrationToDuration(
      validateSpeechScript(extractJson(content), deck),
      targetDurationSeconds,
    );
  } finally {
    await session?.destroy();
  }
}

function srtTimestamp(seconds: number): string {
  const milliseconds = Math.round(seconds * 1_000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds % 3_600_000 / 60_000);
  const secs = Math.floor(milliseconds % 60_000 / 1_000);
  const millis = milliseconds % 1_000;
  return [hours, minutes, secs]
    .map(value => String(value).padStart(2, "0"))
    .join(":") + `,${String(millis).padStart(3, "0")}`;
}

function createSrt(plan: SlideVideoPlan): string {
  let cursor = 0;
  return plan.slides.map((slide, index) => {
    const start = cursor;
    cursor += slide.durationSeconds;
    return [
      index + 1,
      `${srtTimestamp(start)} --> ${srtTimestamp(cursor)}`,
      slide.script.replace(/\r?\n/g, " ").trim(),
      "",
    ].join("\n");
  }).join("\n");
}

function atempoChain(speed: number): string {
  const factors: number[] = [];
  let remaining = speed;
  while (remaining > 2) {
    factors.push(2);
    remaining /= 2;
  }
  while (remaining < 0.5) {
    factors.push(0.5);
    remaining /= 0.5;
  }
  factors.push(remaining);
  return factors.map(factor => `atempo=${factor.toFixed(5)}`).join(",");
}

async function mediaDuration(path: string): Promise<number> {
  const { stdout } = await execFileAsync(FFPROBE, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    path,
  ], { timeout: 30_000, windowsHide: true });
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Generated narration has no readable duration.");
  }
  return duration;
}

async function renderSlideImages(html: string, directory: string): Promise<string[]> {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    await page.setRequestInterception(true);
    page.on("request", request => {
      const url = request.url();
      if (url.startsWith("data:") || url.startsWith("about:")) {
        void request.continue();
      } else {
        void request.abort();
      }
    });
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    await page.addStyleTag({ content: `
      html,body{width:1920px!important;height:1080px!important;margin:0!important;overflow:hidden!important}
      .slide{display:none!important;width:1920px!important;height:1080px!important;min-height:1080px!important}
      .slide[data-video-active="true"]{display:flex!important}
    ` });
    const count = await page.$$eval(".slide", slides => slides.length);
    const paths: string[] = [];
    for (let index = 0; index < count; index += 1) {
      await page.$$eval(".slide", (slides, active) => {
        slides.forEach((slide, slideIndex) => {
          if (slideIndex === active) {
            slide.setAttribute("data-video-active", "true");
          } else {
            slide.removeAttribute("data-video-active");
          }
        });
      }, index);
      await page.evaluate(async () => {
        await Promise.all(Array.from(document.images).map(image =>
          image.complete ? Promise.resolve() : new Promise<void>(resolve => {
            image.addEventListener("load", () => resolve(), { once: true });
            image.addEventListener("error", () => resolve(), { once: true });
          })));
      });
      const path = join(directory, `slide-${String(index + 1).padStart(2, "0")}.png`);
      await page.screenshot({ path, type: "png", fullPage: false });
      paths.push(path);
    }
    return paths;
  } finally {
    await browser.close();
  }
}

async function renderVideo(
  plan: SlideVideoPlan,
  html: string,
  directory: string,
  voice: string,
): Promise<void> {
  const images = await renderSlideImages(html, directory);
  if (images.length !== plan.slides.length) {
    throw new Error("The saved video plan no longer matches the HTML slide count.");
  }
  const silentPath = join(directory, "silent.mp4");
  const outputPath = join(directory, "output.mp4");
  const inputArgs = images.flatMap((path, index) => [
    "-loop", "1",
    "-t", String(plan.slides[index].durationSeconds),
    "-i", path,
  ]);
  const filters = images.map((_, index) =>
    `[${index}:v]scale=1920:1080:force_original_aspect_ratio=decrease,` +
    `pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p[v${index}]`
  );
  filters.push(
    `${images.map((_, index) => `[v${index}]`).join("")}` +
    `concat=n=${images.length}:v=1:a=0[vout]`,
  );
  await execFileAsync(FFMPEG, [
    "-y",
    ...inputArgs,
    "-filter_complex", filters.join(";"),
    "-map", "[vout]",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    silentPath,
  ], { timeout: 30 * 60_000, maxBuffer: 20 * 1024 * 1024, windowsHide: true });
  const srtPath = join(directory, "script.srt");
  await writeFile(srtPath, createSrt(plan), "utf8");
  const narrationPaths: string[] = [];
  const narrationDurations: number[] = [];
  for (const [index, slide] of plan.slides.entries()) {
    const narrationPath = join(
      directory,
      `narration-${String(index + 1).padStart(2, "0")}.wav`,
    );
    await writeFile(
      narrationPath,
      await synthesizeSpeech(slide.script, voice),
    );
    narrationPaths.push(narrationPath);
    narrationDurations.push(await mediaDuration(narrationPath));
  }
  const audioFilters = narrationPaths.map((_, index) => {
    const target = plan.slides[index].durationSeconds;
    const source = narrationDurations[index];
    const timing = source > target
      ? `${atempoChain(source / target)},`
      : "";
    return `[${index + 1}:a]${timing}apad,atrim=duration=${target},` +
      `asetpts=PTS-STARTPTS[a${index}]`;
  });
  audioFilters.push(
    `${narrationPaths.map((_, index) => `[a${index}]`).join("")}` +
    `concat=n=${narrationPaths.length}:v=0:a=1[aout]`,
  );
  await execFileAsync(FFMPEG, [
    "-y",
    "-i", silentPath,
    ...narrationPaths.flatMap(path => ["-i", path]),
    "-i", srtPath,
    "-filter_complex", audioFilters.join(";"),
    "-map", "0:v:0",
    "-map", "[aout]",
    "-map", `${narrationPaths.length + 1}:0`,
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "160k",
    "-c:s", "mov_text",
    "-metadata:s:a:0", `title=${voice}`,
    "-metadata:s:s:0", "language=eng",
    "-shortest",
    "-movflags", "+faststart",
    outputPath,
  ], { timeout: 5 * 60_000, maxBuffer: 20 * 1024 * 1024, windowsHide: true });
}

router.post("/slide-video/plan", async (req, res) => {
  const contentType = req.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "text/html" && contentType !== "application/octet-stream") {
    res.status(415).json({ error: "Upload the HTML slide deck as the raw request body." });
    return;
  }
  const jobId = randomUUID();
  const directory = join(JOB_ROOT, jobId);
  try {
    await cleanupExpiredJobs();
    const html = await readHtmlBody(req);
    const deck = await inspectHtmlDeck(html);
    const targetDurationSeconds = boundedDuration(
      req.query.targetDurationSeconds,
      deck.slides.length,
    );
    const script = await generateNarration(deck, targetDurationSeconds);
    const durations = allocateSlideDurations(
      script.notes.map(note => note.script),
      targetDurationSeconds,
    );
    const plan: SlideVideoPlan = {
      jobId,
      title: deck.title,
      targetDurationSeconds,
      slides: script.notes.map((note, index) => ({
        ...note,
        durationSeconds: durations[index],
      })),
    };
    await mkdir(directory, { recursive: false });
    await Promise.all([
      writeFile(join(directory, "deck.html"), html, "utf8"),
      writeFile(join(directory, "plan.json"), JSON.stringify(plan, null, 2), "utf8"),
    ]);
    res.status(201).json(plan);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    const enhanced = enhanceModelError(error);
    res.status(422).json({ error: enhanced.message });
  }
});

router.post("/slide-video/:jobId/render", async (req, res) => {
  if (!JOB_PATTERN.test(req.params.jobId)) {
    res.status(400).json({ error: "Invalid slide-video job ID." });
    return;
  }
  const directory = join(JOB_ROOT, req.params.jobId);
  try {
    const stored = JSON.parse(
      await readFile(join(directory, "plan.json"), "utf8"),
    ) as SlideVideoPlan;
    if (!Array.isArray(req.body?.slides) || req.body.slides.length !== stored.slides.length) {
      res.status(400).json({ error: "Provide one script for every imported slide." });
      return;
    }
    const targetDurationSeconds = boundedDuration(
      req.body.targetDurationSeconds,
      stored.slides.length,
    );
    const scripts = req.body.slides.map((slide: unknown, index: number) => {
      const candidate = slide as { script?: unknown };
      const script = typeof candidate?.script === "string"
        ? candidate.script.trim().slice(0, 8_000)
        : "";
      if (script.length < 20) {
        throw new Error(`Slide ${index + 1} needs a complete narration script.`);
      }
      return script;
    });
    const durations = allocateSlideDurations(scripts, targetDurationSeconds);
    const plan: SlideVideoPlan = {
      ...stored,
      targetDurationSeconds,
      slides: stored.slides.map((slide, index) => ({
        ...slide,
        script: scripts[index],
        durationSeconds: durations[index],
      })),
    };
    const voice = supportedSpeechVoice(req.body.voice);
    await writeFile(join(directory, "plan.json"), JSON.stringify(plan, null, 2), "utf8");
    await renderVideo(
      plan,
      await readFile(join(directory, "deck.html"), "utf8"),
      directory,
      voice,
    );
    res.status(201).json({
      jobId: plan.jobId,
      durationSeconds: plan.targetDurationSeconds,
      slideCount: plan.slides.length,
      audio: "azure-neural-voice",
      voice,
      subtitles: "embedded",
      downloadUrl: `/slide-video/${plan.jobId}/output`,
      subtitleDownloadUrl: `/slide-video/${plan.jobId}/script`,
    });
  } catch (error) {
    res.status(422).json({
      error: error instanceof Error ? error.message.slice(0, 800) : "Slide video rendering failed.",
    });
  }
});

router.get("/slide-video/:jobId/output", async (req, res) => {
  if (!JOB_PATTERN.test(req.params.jobId)) {
    res.status(400).json({ error: "Invalid slide-video job ID." });
    return;
  }
  const path = join(JOB_ROOT, req.params.jobId, "output.mp4");
  try {
    await stat(path);
    res.download(path, "presentation-video.mp4");
  } catch {
    res.status(404).json({ error: "Rendered slide video not found." });
  }
});

router.get("/slide-video/:jobId/script", async (req, res) => {
  if (!JOB_PATTERN.test(req.params.jobId)) {
    res.status(400).json({ error: "Invalid slide-video job ID." });
    return;
  }
  const path = join(JOB_ROOT, req.params.jobId, "script.srt");
  try {
    await stat(path);
    res.download(path, "presentation-script.srt");
  } catch {
    res.status(404).json({ error: "Slide narration subtitle file not found." });
  }
});

export default router;
