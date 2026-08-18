import { describe, expect, it } from "vitest";
import {
  allocateSlideDurations,
  fitNarrationToDuration,
} from "./slide-video.js";

describe("slide video timing", () => {
  it("allocates the exact requested duration across slides", () => {
    const durations = allocateSlideDurations(
      ["short narration", "a much longer narration with more detail"],
      30,
    );

    expect(durations).toHaveLength(2);
    expect(durations.reduce((sum, value) => sum + value, 0)).toBe(30);
    expect(durations[1]).toBeGreaterThan(durations[0]);
  });

  it("fits generated narration to about 135 words per minute", () => {
    const sentence = "A detailed generated narration contains more words than the requested video timing can support.";
    const fitted = fitNarrationToDuration({
      title: "Test",
      notes: [
        { slideId: "one", slideTitle: "One", script: sentence.repeat(8) },
        { slideId: "two", slideTitle: "Two", script: sentence.repeat(8) },
      ],
    }, 20);
    const words = fitted.notes
      .flatMap(note => note.script.split(/\s+/))
      .filter(Boolean);

    expect(words).toHaveLength(45);
    expect(fitted.notes.every(note => note.script.endsWith("."))).toBe(true);
  });
});
