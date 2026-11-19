import { describe, expect, it } from "vitest";
import {
  durationChange,
  formatDuration,
  formatResponseTime,
  noContentNote,
  pageActionNote,
  responseTimeNote,
} from "../src/screens/figures.js";

describe("response-time figures", () => {
  it("writes a wait in seconds, then minutes", () => {
    expect(formatDuration(0)).toBe("0.0 s");
    expect(formatDuration(840)).toBe("0.8 s");
    expect(formatDuration(9_949)).toBe("9.9 s");
    expect(formatDuration(9_950)).toBe("10 s");
    expect(formatDuration(59_400)).toBe("59 s");
    expect(formatDuration(60_000)).toBe("1 min");
    expect(formatDuration(65_000)).toBe("1 min 5 s");
  });

  it("stands a sentence in for a figure that has no honest number", () => {
    expect(formatResponseTime(1_200, "measured")).toBe("1.2 s");
    expect(formatResponseTime(null, "mostly_untimed")).toBe("Not measured");
    // A value with a status that says it is not to be trusted is never shown.
    expect(formatResponseTime(1_200, "mostly_untimed")).toBe("Not measured");
    expect(formatResponseTime(null, "no_answers")).toBe("No answers");
    expect(responseTimeNote("measured")).toBeNull();
    expect(responseTimeNote("mostly_untimed")).toContain("before answer times were recorded");
    expect(formatResponseTime(null, "page_actions_only")).toBe("Not measured");
    expect(formatResponseTime(1_200, "page_actions_only")).toBe("Not measured");
    // Not the old-answers sentence: these answers are new, only left out.
    expect(responseTimeNote("page_actions_only")).toBe(
      "Every answer in this period used a page action. Those are not counted, because their time stops at the page action.",
    );
  });

  it("says when answers that used a page action are left out", () => {
    expect(pageActionNote("measured", 0)).toBeNull();
    expect(pageActionNote("measured", 1)).toBe(
      "1 answer that used a page action is not counted, because its time stops at the page action.",
    );
    expect(pageActionNote("mostly_untimed", 3)).toBe(
      "3 answers that used a page action are not counted, because their time stops at the page action.",
    );
    // The status sentence already says it, or there is nothing to leave out.
    expect(pageActionNote("page_actions_only", 3)).toBeNull();
    expect(pageActionNote("no_answers", 0)).toBeNull();
  });

  it("says when replies that found nothing to answer from are left out", () => {
    expect(noContentNote(0)).toBeNull();
    expect(noContentNote(1)).toBe(
      "1 reply that found nothing in your content is not counted, because it is sent at once without writing an answer.",
    );
    expect(noContentNote(2)).toBe(
      "2 replies that found nothing in your content are not counted, because they are sent at once without writing an answer.",
    );
  });

  it("compares two waits as they are shown", () => {
    expect(durationChange(800, 1_200, 7)).toEqual({
      direction: "down",
      text: "0.4 s faster than the 7 days before",
    });
    expect(durationChange(15_000, 12_000, 30)).toEqual({
      direction: "up",
      text: "3.0 s slower than the 30 days before",
    });
    // 1.24 s and 1.21 s both read "1.2 s".
    expect(durationChange(1_240, 1_210, 7)).toEqual({
      direction: "same",
      text: "Same as the 7 days before",
    });
    // Read differently ("1.3 s" and "1.2 s"): never "0.0 s".
    expect(durationChange(1_260, 1_240, 7)?.text).toBe("0.1 s slower than the 7 days before");
    expect(durationChange(800, null, 7)).toEqual({
      direction: "same",
      text: "No figure for the 7 days before",
    });
    expect(durationChange(null, 800, 7)).toBeUndefined();
  });
});
