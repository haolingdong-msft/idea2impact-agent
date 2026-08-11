import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type TimeRange = {
  start: number;
  end: number;
};

export type AcceleratedRange = TimeRange & {
  speed: number;
  originalDuration: number;
  outputDuration: number;
};

export type MediaMetadata = {
  container: string;
  duration: number;
  sizeBytes: number;
  video: {
    codec: string;
    width: number;
    height: number;
    frameRate: number;
    pixelFormat: string;
  };
  audio: {
    codec: string;
    sampleRate: number;
    channels: number;
  } | null;
  keyframes: {
    count: number;
    firstTimestamps: number[];
  };
};

export type RefinementOptions = {
  targetSpeed: number;
  minimumInactiveDuration: number;
  minimumRetainedPause: number;
  clarity: "none" | "standard" | "strong";
  resolution: "source" | "1080p" | "4k";
};

export type ProcessingSummary = {
  source: MediaMetadata;
  output: MediaMetadata;
  acceleratedRanges: AcceleratedRange[];
  filters: string[];
  originalDuration: number;
  outputDuration: number;
  durationChange: number;
  warnings: string[];
};

type ProbeOutput = {
  format?: {
    format_name?: string;
    duration?: string;
    size?: string;
  };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    r_frame_rate?: string;
    pix_fmt?: string;
    sample_rate?: string;
    channels?: number;
  }>;
};

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const TOOL_TIMEOUT_MS = 30 * 60 * 1000;
const MEANINGFUL_SCENE_CHANGE = 0.01;

async function runTool(
  executable: string,
  args: string[],
  timeout = TOOL_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(executable, args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout,
    windowsHide: true,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function parseFrameRate(value: string | undefined): number {
  if (!value) return 0;
  const [numerator, denominator = 1] = value.split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return 0;
  }
  return numerator / denominator;
}

export function findInactiveRanges(
  _silences: TimeRange[],
  lowMotionRanges: TimeRange[],
  duration: number,
  options: Pick<
    RefinementOptions,
    "targetSpeed" | "minimumInactiveDuration" | "minimumRetainedPause"
  >,
  _hasAudio: boolean,
): AcceleratedRange[] {
  return [...lowMotionRanges]
    .sort((left, right) => left.start - right.start)
    .map(range => ({
      start: Math.max(0, range.start),
      end: Math.min(duration, range.end),
    }))
    .filter(range => range.end - range.start >= options.minimumInactiveDuration)
    .map(range => {
      const originalDuration = range.end - range.start;
      const speed = Math.min(
        options.targetSpeed,
        originalDuration / options.minimumRetainedPause,
      );
      return {
        ...range,
        speed,
        originalDuration,
        outputDuration: originalDuration / speed,
      };
    })
    .filter(range => range.speed > 1.05);
}

function atempoChain(speed: number): string {
  const factors: number[] = [];
  let remaining = speed;
  while (remaining > 2) {
    factors.push(2);
    remaining /= 2;
  }
  factors.push(remaining);
  return factors.map(factor => `atempo=${factor.toFixed(5)}`).join(",");
}

function clarityFilter(options: RefinementOptions): { expression: string; labels: string[] } {
  const filters: string[] = [];
  const labels: string[] = [];
  if (options.clarity === "standard") {
    filters.push("hqdn3d=0.6:0.6:3:3", "unsharp=3:3:0.35:3:3:0");
    labels.push("light denoise", "text-safe sharpening");
  } else if (options.clarity === "strong") {
    filters.push(
      "hqdn3d=1.2:1.2:4:4",
      "unsharp=5:5:0.55:3:3:0",
      "eq=contrast=1.03:saturation=1.02",
    );
    labels.push("strong denoise", "strong sharpening", "contrast and color correction");
  }

  if (options.resolution === "1080p") {
    filters.push(
      "scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos",
    );
    labels.push("fit within 1920x1080");
  } else if (options.resolution === "4k") {
    filters.push(
      "scale=3840:2160:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos",
    );
    labels.push("fit within 3840x2160");
  } else {
    filters.push("scale=trunc(iw/2)*2:trunc(ih/2)*2");
    labels.push("preserve source dimensions");
  }

  return { expression: filters.join(","), labels };
}

export function buildFilterGraph(
  duration: number,
  ranges: AcceleratedRange[],
  hasAudio: boolean,
  videoFilters: string,
): { graph: string; videoMap: string; audioMap: string | null } {
  const segments: Array<TimeRange & { speed: number }> = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor + 0.001) {
      segments.push({ start: cursor, end: range.start, speed: 1 });
    }
    segments.push({ start: range.start, end: range.end, speed: range.speed });
    cursor = range.end;
  }
  if (cursor < duration - 0.001) {
    segments.push({ start: cursor, end: duration, speed: 1 });
  }
  if (segments.length === 0) {
    segments.push({ start: 0, end: duration, speed: 1 });
  }

  const graphParts: string[] = [];
  const concatInputs: string[] = [];
  segments.forEach((segment, index) => {
    const start = segment.start.toFixed(5);
    const end = segment.end.toFixed(5);
    graphParts.push(
      `[0:v:0]trim=start=${start}:end=${end},setpts=(PTS-STARTPTS)/${segment.speed.toFixed(5)}[v${index}]`,
    );
    concatInputs.push(`[v${index}]`);
    if (hasAudio) {
      graphParts.push(
        `[0:a:0]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,${atempoChain(segment.speed)}[a${index}]`,
      );
      concatInputs.push(`[a${index}]`);
    }
  });

  if (hasAudio) {
    graphParts.push(
      `${concatInputs.join("")}concat=n=${segments.length}:v=1:a=1[vcat][aout]`,
    );
  } else {
    graphParts.push(
      `${concatInputs.join("")}concat=n=${segments.length}:v=1:a=0[vcat]`,
    );
  }
  graphParts.push(`[vcat]${videoFilters}[vout]`);
  return {
    graph: graphParts.join(";"),
    videoMap: "[vout]",
    audioMap: hasAudio ? "[aout]" : null,
  };
}

async function probeKeyframes(inputPath: string): Promise<number[]> {
  const { stdout } = await runTool(FFPROBE, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-skip_frame",
    "nokey",
    "-show_entries",
    "frame=best_effort_timestamp_time",
    "-of",
    "csv=p=0",
    inputPath,
  ]);
  return stdout
    .split(/\r?\n/)
    .map(value => Number(value.trim()))
    .filter(Number.isFinite);
}

export async function probeMedia(inputPath: string): Promise<MediaMetadata> {
  const [{ stdout }, keyframes] = await Promise.all([
    runTool(FFPROBE, [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      inputPath,
    ]),
    probeKeyframes(inputPath),
  ]);
  const data = JSON.parse(stdout) as ProbeOutput;
  const video = data.streams?.find(stream => stream.codec_type === "video");
  const audio = data.streams?.find(stream => stream.codec_type === "audio");
  const duration = Number(data.format?.duration);
  if (!video || !Number.isFinite(duration) || duration <= 0) {
    throw new Error("The uploaded file does not contain a readable video stream.");
  }

  return {
    container: data.format?.format_name || "unknown",
    duration,
    sizeBytes: Number(data.format?.size) || 0,
    video: {
      codec: video.codec_name || "unknown",
      width: video.width || 0,
      height: video.height || 0,
      frameRate: parseFrameRate(video.avg_frame_rate || video.r_frame_rate),
      pixelFormat: video.pix_fmt || "unknown",
    },
    audio: audio
      ? {
          codec: audio.codec_name || "unknown",
          sampleRate: Number(audio.sample_rate) || 0,
          channels: audio.channels || 0,
        }
      : null,
    keyframes: {
      count: keyframes.length,
      firstTimestamps: keyframes.slice(0, 8),
    },
  };
}

export function rangesBetweenMeaningfulChanges(
  timestamps: number[],
  duration: number,
): TimeRange[] {
  const changes = [...new Set(timestamps)]
    .filter(timestamp =>
      Number.isFinite(timestamp) && timestamp > 0 && timestamp < duration)
    .sort((left, right) => left - right);
  const boundaries = [0, ...changes, duration];
  return boundaries.slice(0, -1).map((start, index) => ({
    start,
    end: boundaries[index + 1],
  }));
}

async function detectLowMotion(
  inputPath: string,
  duration: number,
): Promise<TimeRange[]> {
  const { stderr } = await runTool(FFMPEG, [
    "-hide_banner",
    "-nostats",
    "-i",
    inputPath,
    "-map",
    "0:v:0",
    "-vf",
    `select='gt(scene,${MEANINGFUL_SCENE_CHANGE})',showinfo`,
    "-an",
    "-f",
    "null",
    "-",
  ]);
  const timestamps = [...stderr.matchAll(/pts_time:([\d.]+)/g)]
    .map(match => Number(match[1]))
    .filter(Number.isFinite);
  return rangesBetweenMeaningfulChanges(timestamps, duration);
}

export async function checkVideoCapabilities(): Promise<{
  available: boolean;
  ffmpeg?: string;
  ffprobe?: string;
  error?: string;
}> {
  try {
    const [ffmpegResult, ffprobeResult] = await Promise.all([
      runTool(FFMPEG, ["-version"], 10_000),
      runTool(FFPROBE, ["-version"], 10_000),
    ]);
    return {
      available: true,
      ffmpeg: ffmpegResult.stdout.split(/\r?\n/)[0],
      ffprobe: ffprobeResult.stdout.split(/\r?\n/)[0],
    };
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : "FFmpeg is unavailable.",
    };
  }
}

export async function refineVideo(
  inputPath: string,
  outputPath: string,
  options: RefinementOptions,
): Promise<ProcessingSummary> {
  const source = await probeMedia(inputPath);
  const lowMotionRanges = await detectLowMotion(
    inputPath,
    source.duration,
  );
  const acceleratedRanges = findInactiveRanges(
    [],
    lowMotionRanges,
    source.duration,
    options,
    source.audio !== null,
  );
  const clarity = clarityFilter(options);
  const filterGraph = buildFilterGraph(
    source.duration,
    acceleratedRanges,
    source.audio !== null,
    clarity.expression,
  );

  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "warning",
    "-i",
    inputPath,
    "-filter_complex",
    filterGraph.graph,
    "-map",
    filterGraph.videoMap,
  ];
  if (filterGraph.audioMap) {
    args.push("-map", filterGraph.audioMap);
  }
  args.push(
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
  );
  if (filterGraph.audioMap) {
    args.push("-c:a", "aac", "-b:a", "192k");
  } else {
    args.push("-an");
  }
  args.push(
    "-movflags",
    "+faststart",
    "-max_muxing_queue_size",
    "4096",
    outputPath,
  );
  await runTool(FFMPEG, args);

  const output = await probeMedia(outputPath);
  const warnings: string[] = [];
  if (acceleratedRanges.length === 0) {
    warnings.push(
      "No ranges met the sustained visual-inactivity threshold; pacing was unchanged.",
    );
  }
  if (options.resolution !== "source" &&
      (output.video.width > source.video.width || output.video.height > source.video.height)) {
    warnings.push(
      "Upscaling improves perceived clarity but cannot recover detail absent from the source.",
    );
  }

  return {
    source,
    output,
    acceleratedRanges,
    filters: [
      ...clarity.labels,
      ...(acceleratedRanges.length > 0
        ? [`accelerated ${acceleratedRanges.length} inactive range(s)`]
        : []),
    ],
    originalDuration: source.duration,
    outputDuration: output.duration,
    durationChange: output.duration - source.duration,
    warnings,
  };
}
