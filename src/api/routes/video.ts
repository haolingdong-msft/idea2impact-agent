import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import {
  checkVideoCapabilities,
  refineVideo,
  type RefinementOptions,
} from "./video-processor.js";
import {
  currentSourceAssetIds,
  getProject,
  isProjectId,
  readProjectBinaryAsset,
  storeProjectBinaryAsset,
  storeProjectJsonAsset,
} from "./project-store.js";

const router = Router();
const MAX_UPLOAD_BYTES = (Number(process.env.MAX_VIDEO_UPLOAD_MB) || 500) * 1024 * 1024;
const MAX_CONCURRENT_JOBS = Math.max(
  1,
  Number(process.env.MAX_CONCURRENT_VIDEO_JOBS) || 1,
);
const JOB_TTL_MS = (Number(process.env.VIDEO_JOB_TTL_HOURS) || 24) * 60 * 60 * 1000;
const VIDEO_ROOT = resolve(
  process.env.VIDEO_WORK_DIR || join(tmpdir(), "idea2impact-agent-video"),
);
const ALLOWED_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v"]);
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let activeVideoJobs = 0;

class UploadLimitError extends Error {}

function numberOption(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function parseOptions(query: Record<string, unknown>): RefinementOptions {
  const clarity = query.clarity;
  const resolution = query.resolution;
  return {
    targetSpeed: numberOption(query.targetSpeed, 4, 1.25, 8),
    minimumInactiveDuration: numberOption(query.minimumInactiveDuration, 2.5, 1, 15),
    minimumRetainedPause: numberOption(query.minimumRetainedPause, 0.5, 0.2, 3),
    clarity: clarity === "none" || clarity === "strong" ? clarity : "standard",
    resolution: resolution === "1080p" || resolution === "4k" ? resolution : "source",
  };
}

export function uploadExtension(headerValue: string | undefined): string {
  let filename = headerValue || "upload.mp4";
  try {
    filename = decodeURIComponent(filename);
  } catch {
    throw new Error("The upload filename is not valid URI encoding.");
  }
  const extension = extname(filename).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error("Supported video formats are MP4, MOV, MKV, WebM, and M4V.");
  }
  return extension;
}

async function cleanupExpiredJobs(): Promise<void> {
  await mkdir(VIDEO_ROOT, { recursive: true });
  const entries = await readdir(VIDEO_ROOT, { withFileTypes: true });
  const expiration = Date.now() - JOB_TTL_MS;
  await Promise.all(entries
    .filter(entry => entry.isDirectory() && JOB_ID_PATTERN.test(entry.name))
    .map(async entry => {
      const jobPath = join(VIDEO_ROOT, entry.name);
      const details = await stat(jobPath);
      if (details.mtimeMs < expiration) {
        await rm(jobPath, { recursive: true, force: true });
      }
    }));
}

async function saveUpload(
  request: NodeJS.ReadableStream,
  destination: string,
): Promise<number> {
  let received = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > MAX_UPLOAD_BYTES) {
        callback(new UploadLimitError(`Video exceeds the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit.`));
        return;
      }
      callback(null, chunk);
    },
  });
  await pipeline(request, limiter, createWriteStream(destination, { flags: "wx" }));
  if (received === 0) {
    throw new Error("The uploaded video is empty.");
  }
  return received;
}

router.get("/video/capabilities", async (_req, res) => {
  const capabilities = await checkVideoCapabilities();
  res.status(capabilities.available ? 200 : 503).json(capabilities);
});

router.post("/video/upload", async (req, res) => {
  const projectId = typeof req.query.projectId === "string"
    ? req.query.projectId.trim()
    : "";
  const project = isProjectId(projectId) ? await getProject(projectId) : null;
  if (!project) {
    res.status(isProjectId(projectId) ? 404 : 400).json({
      error: "A valid presentation project ID is required.",
    });
    return;
  }
  const contentType = req.get("content-type")?.split(";")[0].trim().toLowerCase() || "";
  if (!contentType.startsWith("video/") && contentType !== "application/octet-stream") {
    res.status(415).json({ error: "Upload a video file as the raw request body." });
    return;
  }
  let extension: string;
  try {
    extension = uploadExtension(req.get("x-file-name"));
  } catch (error) {
    res.status(415).json({ error: error instanceof Error ? error.message : "Invalid filename." });
    return;
  }
  const jobId = randomUUID();
  const jobDirectory = join(VIDEO_ROOT, jobId);
  const sourcePath = join(jobDirectory, `source${extension}`);
  try {
    await cleanupExpiredJobs();
    await mkdir(jobDirectory, { recursive: false });
    const sizeBytes = await saveUpload(req, sourcePath);
    const sourceAsset = await storeProjectBinaryAsset(
      project.id,
      "source-video",
      extension.slice(1),
      await readFile(sourcePath),
      currentSourceAssetIds(project, [
        "brief",
        "outline",
        "slide-model",
        "slide-deck",
        "speech-script",
      ]),
      {
        uploadFilename: req.get("x-file-name") || null,
        contentType,
        sizeBytes,
      },
    );
    res.status(201).json({
      asset: sourceAsset.asset,
      filename: req.get("x-file-name") || `recording${extension}`,
      sizeBytes,
    });
  } catch (error) {
    await rm(jobDirectory, { recursive: true, force: true });
    if (error instanceof UploadLimitError) {
      res.status(413).json({ error: error.message });
      return;
    }
    res.status(422).json({
      error: error instanceof Error ? error.message : "Recording upload failed.",
    });
  }
});

router.post("/video/refine-stored", async (req, res) => {
  if (activeVideoJobs >= MAX_CONCURRENT_JOBS) {
    res.status(429).json({
      error: "The video processor is busy. Try again after the current render finishes.",
    });
    return;
  }
  const projectId = typeof req.body?.projectId === "string" ? req.body.projectId : "";
  const project = isProjectId(projectId) ? await getProject(projectId) : null;
  if (!project) {
    res.status(isProjectId(projectId) ? 404 : 400).json({
      error: "A valid presentation project ID is required.",
    });
    return;
  }
  const sourceAssetId = typeof req.body?.sourceAssetId === "string"
    ? req.body.sourceAssetId
    : project.currentAssets["source-video"];
  const source = sourceAssetId
    ? await readProjectBinaryAsset(project.id, sourceAssetId)
    : null;
  if (!source || source.asset.type !== "source-video") {
    res.status(409).json({ error: "Upload a source recording before refinement." });
    return;
  }
  const capabilities = await checkVideoCapabilities();
  if (!capabilities.available) {
    res.status(503).json({ error: "FFmpeg and FFprobe are required for video refinement." });
    return;
  }
  const options = parseOptions((req.body?.options || {}) as Record<string, unknown>);
  const jobId = randomUUID();
  const jobDirectory = join(VIDEO_ROOT, jobId);
  const sourcePath = join(jobDirectory, `source.${source.asset.format}`);
  const outputPath = join(jobDirectory, "refined.mp4");
  activeVideoJobs += 1;
  try {
    await cleanupExpiredJobs();
    await mkdir(jobDirectory, { recursive: false });
    await writeFile(sourcePath, source.content);
    const processing = await refineVideo(sourcePath, outputPath, options);
    const refinedAsset = await storeProjectBinaryAsset(
      project.id,
      "refined-video",
      "mp4",
      await readFile(outputPath),
      [source.asset.id],
      {
        jobId,
        outputDuration: processing.outputDuration,
        inactiveEditCount: processing.acceleratedRanges.length,
      },
    );
    const processingAsset = await storeProjectJsonAsset(
      project.id,
      "export",
      {
        kind: "video-refinement",
        jobId,
        options,
        source: processing.source,
        output: processing.output,
        processing: {
          acceleratedRanges: processing.acceleratedRanges,
          filters: processing.filters,
          originalDuration: processing.originalDuration,
          outputDuration: processing.outputDuration,
          durationChange: processing.durationChange,
          warnings: processing.warnings,
        },
      },
      [source.asset.id, refinedAsset.asset.id],
      {
        kind: "video-refinement",
        jobId,
        warningCount: processing.warnings.length,
      },
    );
    res.status(201).json({
      jobId,
      source: processing.source,
      output: {
        metadata: processing.output,
        downloadUrl: `/video/jobs/${jobId}/output`,
      },
      processing: {
        acceleratedRanges: processing.acceleratedRanges,
        filters: processing.filters,
        originalDuration: processing.originalDuration,
        outputDuration: processing.outputDuration,
        durationChange: processing.durationChange,
        warnings: processing.warnings,
      },
      assets: {
        source: source.asset,
        refined: refinedAsset.asset,
        processing: processingAsset.asset,
      },
    });
  } catch (error) {
    await rm(jobDirectory, { recursive: true, force: true });
    res.status(422).json({
      error: error instanceof Error
        ? `Video refinement failed: ${error.message.slice(0, 500)}`
        : "Video refinement failed.",
    });
  } finally {
    activeVideoJobs -= 1;
  }
});

router.post("/video/refine", async (req, res) => {
  if (activeVideoJobs >= MAX_CONCURRENT_JOBS) {
    res.status(429).json({
      error: "The video processor is busy. Try again after the current render finishes.",
    });
    return;
  }
  const contentType = req.get("content-type")?.split(";")[0].trim().toLowerCase() || "";
  if (!contentType.startsWith("video/") && contentType !== "application/octet-stream") {
    res.status(415).json({ error: "Upload a video file as the raw request body." });
    return;
  }
  const declaredLength = Number(req.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES) {
    res.status(413).json({ error: `Video exceeds the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit.` });
    return;
  }

  let extension: string;
  try {
    extension = uploadExtension(req.get("x-file-name"));
  } catch (error) {
    res.status(415).json({ error: error instanceof Error ? error.message : "Invalid filename." });
    return;
  }
  const projectIdCandidate = typeof req.query.projectId === "string"
    ? req.query.projectId.trim()
    : req.get("x-project-id")?.trim() || "";
  if (projectIdCandidate && !isProjectId(projectIdCandidate)) {
    res.status(400).json({ error: "Invalid presentation project ID." });
    return;
  }
  const project = projectIdCandidate
    ? await getProject(projectIdCandidate)
    : null;
  if (projectIdCandidate && !project) {
    res.status(404).json({ error: "Presentation project not found." });
    return;
  }

  const capabilities = await checkVideoCapabilities();
  if (!capabilities.available) {
    res.status(503).json({
      error: "FFmpeg and FFprobe are required for video refinement.",
    });
    return;
  }

  const jobId = randomUUID();
  const jobDirectory = join(VIDEO_ROOT, jobId);
  const sourcePath = join(jobDirectory, `source${extension}`);
  const outputPath = join(jobDirectory, "refined.mp4");
  const options = parseOptions(req.query);
  activeVideoJobs += 1;
  try {
    await cleanupExpiredJobs();
    await mkdir(jobDirectory, { recursive: false });
    await saveUpload(req, sourcePath);
    const processing = await refineVideo(sourcePath, outputPath, options);
    const storedAssets = project
      ? await (async () => {
          const sourceAsset = await storeProjectBinaryAsset(
            project.id,
            "source-video",
            extension.slice(1),
            await readFile(sourcePath),
            currentSourceAssetIds(project, ["slide-deck", "slide-model", "architecture", "story", "brief"]),
            {
              jobId,
              uploadFilename: req.get("x-file-name") || null,
              contentType,
              duration: processing.source.duration,
            },
          );
          const refinedAsset = await storeProjectBinaryAsset(
            project.id,
            "refined-video",
            "mp4",
            await readFile(outputPath),
            [sourceAsset.asset.id],
            {
              jobId,
              outputDuration: processing.outputDuration,
              inactiveEditCount: processing.acceleratedRanges.length,
            },
          );
          const processingAsset = await storeProjectJsonAsset(
            project.id,
            "export",
            {
              kind: "video-refinement",
              jobId,
              options,
              source: processing.source,
              output: processing.output,
              processing: {
                acceleratedRanges: processing.acceleratedRanges,
                filters: processing.filters,
                originalDuration: processing.originalDuration,
                outputDuration: processing.outputDuration,
                durationChange: processing.durationChange,
                warnings: processing.warnings,
              },
            },
            [sourceAsset.asset.id, refinedAsset.asset.id],
            {
              kind: "video-refinement",
              jobId,
              warningCount: processing.warnings.length,
            },
          );
          return {
            source: sourceAsset.asset,
            refined: refinedAsset.asset,
            processing: processingAsset.asset,
          };
        })()
      : undefined;
    res.status(201).json({
      jobId,
      source: processing.source,
      output: {
        metadata: processing.output,
        downloadUrl: `/video/jobs/${jobId}/output`,
      },
      processing: {
        acceleratedRanges: processing.acceleratedRanges,
        filters: processing.filters,
        originalDuration: processing.originalDuration,
        outputDuration: processing.outputDuration,
        durationChange: processing.durationChange,
        warnings: processing.warnings,
      },
      assets: storedAssets,
    });
  } catch (error) {
    await rm(jobDirectory, { recursive: true, force: true });
    if (error instanceof UploadLimitError) {
      res.status(413).json({ error: error.message });
      return;
    }
    console.error("Video refinement failed", error);
    res.status(422).json({
      error: error instanceof Error
        ? `Video refinement failed: ${error.message.slice(0, 500)}`
        : "Video refinement failed.",
    });
  } finally {
    activeVideoJobs -= 1;
  }
});

router.get("/video/jobs/:jobId/output", async (req, res) => {
  const { jobId } = req.params;
  if (!JOB_ID_PATTERN.test(jobId)) {
    res.status(400).json({ error: "Invalid video job ID." });
    return;
  }
  const outputPath = join(VIDEO_ROOT, jobId, "refined.mp4");
  try {
    const details = await stat(outputPath);
    const range = req.get("range");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="presentation-refined-${jobId}.mp4"`,
    );
    if (range) {
      const match = range.match(/^bytes=(\d*)-(\d*)$/);
      if (!match) {
        res.status(416).setHeader("Content-Range", `bytes */${details.size}`);
        res.end();
        return;
      }
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : details.size - 1;
      if (start < 0 || end < start || end >= details.size) {
        res.status(416).setHeader("Content-Range", `bytes */${details.size}`);
        res.end();
        return;
      }
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${details.size}`);
      res.setHeader("Content-Length", end - start + 1);
      createReadStream(outputPath, { start, end }).pipe(res);
      return;
    }
    res.setHeader("Content-Length", details.size);
    createReadStream(outputPath).pipe(res);
  } catch {
    res.status(404).json({ error: "Refined video not found or expired." });
  }
});

export default router;
