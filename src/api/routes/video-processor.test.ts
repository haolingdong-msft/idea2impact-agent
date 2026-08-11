import { describe, expect, it } from "vitest";
import {
  buildFilterGraph,
  findInactiveRanges,
  rangesBetweenMeaningfulChanges,
  type AcceleratedRange,
} from "./video-processor.js";
import { uploadExtension } from "./video.js";

describe("video refinement planning", () => {
  it("accelerates sustained frozen-video ranges while preserving synchronized audio", () => {
    const ranges = findInactiveRanges(
      [{ start: 3, end: 10 }, { start: 15, end: 18 }],
      [{ start: 5, end: 11 }, { start: 15.5, end: 16 }],
      20,
      {
        targetSpeed: 4,
        minimumInactiveDuration: 2,
        minimumRetainedPause: 0.5,
      },
      true,
    );

    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({ start: 5, end: 11, speed: 4 });
  });

  it("shortens measured visual hangs even when continuous audio has no silence", () => {
    const sourceDuration = 18.514;
    const lowMotionRanges = rangesBetweenMeaningfulChanges(
      [2.162, 4.734, 8.333, 11.848, 16.612],
      sourceDuration,
    );
    const ranges = findInactiveRanges(
      [],
      lowMotionRanges,
      sourceDuration,
      {
        targetSpeed: 4,
        minimumInactiveDuration: 2.5,
        minimumRetainedPause: 0.5,
      },
      true,
    );

    const shortenedDuration = sourceDuration - ranges.reduce(
      (saved, range) => saved + range.originalDuration - range.outputDuration,
      0,
    );
    expect(ranges).toHaveLength(4);
    expect(shortenedDuration).toBeLessThan(8);
  });

  it("treats small loading animation changes as one low-motion interval", () => {
    const ranges = rangesBetweenMeaningfulChanges([2, 8, 14], 18);

    expect(ranges).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 8 },
      { start: 8, end: 14 },
      { start: 14, end: 18 },
    ]);
  });

  it("builds synchronized video and audio filter segments", () => {
    const ranges: AcceleratedRange[] = [{
      start: 4,
      end: 8,
      speed: 4,
      originalDuration: 4,
      outputDuration: 1,
    }];
    const result = buildFilterGraph(
      12,
      ranges,
      true,
      "unsharp=3:3:0.35:3:3:0",
    );

    expect(result.graph).toContain("trim=start=4.00000:end=8.00000");
    expect(result.graph).toContain("atempo=2.00000,atempo=2.00000");
    expect(result.graph).toContain("concat=n=3:v=1:a=1");
    expect(result.videoMap).toBe("[vout]");
    expect(result.audioMap).toBe("[aout]");
  });

  it("accepts only supported video extensions", () => {
    expect(uploadExtension(encodeURIComponent("demo recording.MOV"))).toBe(".mov");
    expect(() => uploadExtension("payload.exe")).toThrow("Supported video formats");
  });
});
