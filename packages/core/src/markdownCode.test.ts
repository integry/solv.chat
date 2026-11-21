import { describe, expect, it } from "vitest";
import { proseRanges } from "./markdownCode.js";

/** Whether the character at `at` is prose in `ranges`. */
function isProse(ranges: ReadonlyArray<[number, number]>, at: number): boolean {
  return ranges.some(([start, end]) => start <= at && at < end);
}

/** The prose of `text` read with links kept, with code cut out. */
function prose(text: string): string {
  return proseRanges(text, true)
    .map(([start, end]) => text.slice(start, end))
    .join("|");
}

describe("proseRanges with links kept", () => {
  it("opens no code span in a link's title, destination, reference or autolink", () => {
    expect(prose('[a](https://x.example "`t") then [b](https://y.example)')).toBe(
      '[a](https://x.example "`t") then [b](https://y.example)',
    );
    expect(prose("[a](https://x.example/`) [b](https://y.example)")).toBe(
      "[a](https://x.example/`) [b](https://y.example)",
    );
    expect(prose("[a][1`] [b](https://y.example)")).toBe("[a][1`] [b](https://y.example)");
    expect(prose("<https://x.example/`> [b](https://y.example)")).toBe(
      "<https://x.example/`> [b](https://y.example)",
    );
  });

  it("still finds code in a label, after a link, and where no label opened", () => {
    expect(prose('[the `npm test` run](https://x.example "t") and `[b](c)`')).toBe(
      '[the | run](https://x.example "t") and ',
    );
    // A "](" with no "[" before it on the line is no link's tail.
    expect(prose('a](b "`[c](d)`")')).toBe('a](b "|")');
    // Nor is a bracket of numbers followed by "[": that is a marker.
    expect(prose("[1][`x`]")).toBe("[1][|]");
    // A tail that turns out not to be one reads on as usual from where it stops.
    expect(prose('[a](b "t" `c` d')).toBe('[a](b "t" | d');
    expect(prose("[a](b\n`c` d")).toBe("[a](b\n| d");
  });

  it("never turns what it already read into code or back as text is appended", () => {
    const texts = [
      '[guide](https://x.example/docs "`tag") then [other](https://y.example/phish)',
      "[x](https://x.example/a\\\n`) [other](https://y.example) `code`",
      "[x][1`] then <https://x.example/`b> and `y`",
    ];
    for (const text of texts) {
      const full = proseRanges(text, true);
      for (let cut = 1; cut < text.length; cut++) {
        const part = proseRanges(text.slice(0, cut), true);
        for (let at = 0; at < cut; at++) {
          expect(isProse(part, at), `${JSON.stringify(text.slice(0, cut))} at ${at}`).toBe(
            isProse(full, at),
          );
        }
      }
    }
  });

  it("leaves reading without kept links as it was", () => {
    const text = '[a](https://x.example "`t") [b](c)';
    expect(proseRanges(text)).toEqual([
      [0, 4],
      [21, 23],
    ]);
  });
});
