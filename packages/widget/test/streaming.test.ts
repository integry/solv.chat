import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/markdown.js";
import { streamingView } from "../src/streaming.js";

/** Answers with every construct the renderer has, as a model writes them. */
const ANSWERS = [
  [
    "To reset your password:",
    "",
    "1. Open **Settings** and choose *Account*.",
    "2. Select [Forgot password](https://docs.example.com/reset?from=chat).",
    "3. Enter the code from the email, for example `123456`.",
    "4. Pick a new password.",
    "5. Sign in again.",
    "",
    "```js",
    "const client = createClient({ key: process.env.KEY });",
    "await client.reset(\"user-\" + id);",
    "```",
    "",
    "See the [guide](https://docs.example.com/guide) for more.",
  ].join("\n"),
  [
    "- First *point* with a [link](https://example.com/a_(b)).",
    "- Second **bold point**.",
    "  - Nested `code` item",
    "",
    "| Plan | Price |",
    "| --- | --- |",
    "| Free | $0 |",
    "| Pro | $10 |",
    "",
    "Done, as in step 2 * 3 = 6. A stray * and an open [bracket stay as text.",
  ].join("\n"),
  "````md\n```inner```\n````\nAfter the fence with **strong** text.",
  "Line with a trailing backslash \\\nnext line and a citation [1].",
];

/** Text a visitor sees, with whitespace runs folded. */
function visible(el: HTMLElement): string {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

function renderWhole(markdown: string): HTMLDivElement {
  const el = document.createElement("div");
  renderMarkdown(el, markdown);
  return el;
}

/** Splits `text` at the given points. */
function chunksAt(text: string, points: number[]): string[] {
  const out: string[] = [];
  let from = 0;
  for (const point of [...points].sort((a, b) => a - b)) {
    if (point <= from || point >= text.length) continue;
    out.push(text.slice(from, point));
    from = point;
  }
  out.push(text.slice(from));
  return out;
}

/** Split points inside every construct: links, fences, emphasis and list markers. */
function awkwardPoints(text: string): number[] {
  const points: number[] = [];
  for (const re of [/\[/g, /\]\(/g, /\)/g, /\*\*?/g, /`+/g, /^\d+\./gm, /^ *- /gm, /\|/g]) {
    for (const match of text.matchAll(re)) {
      const at = match.index ?? 0;
      points.push(at, at + 1, at + Math.max(1, Math.floor(match[0].length / 2)));
    }
  }
  return points;
}

/** Feeds `chunks` into one container the way the widget paints them, then ends the stream. */
function stream(chunks: string[]): { frames: string[]; el: HTMLDivElement } {
  const el = document.createElement("div");
  const frames: string[] = [];
  let text = "";
  for (const chunk of chunks) {
    text += chunk;
    renderMarkdown(el, streamingView(text).markdown);
    frames.push(visible(el));
  }
  renderMarkdown(el, text);
  return { frames, el };
}

describe("streamingView", () => {
  it("holds back an unfinished link, emphasis, code span, list marker, table row and fence line", () => {
    const cases: Array<[string, string]> = [
      ["See [the guide](https://docs.exa", "See "],
      ["See [the guide]", "See "],
      ["See [the gu", "See "],
      ["Open **Sett", "Open "],
      ["Open *Acc", "Open "],
      ["Open **Settings*", "Open "],
      ["Run `npm i", "Run "],
      ["Steps:\n1.", "Steps:\n"],
      ["Steps:\n- ", "Steps:\n"],
      ["Prices:\n| Plan | Pr", "Prices:\n"],
      ["Code:\n``", "Code:\n"],
      ["Code:\n```js", "Code:\n"],
      ["Ends with an escape \\", "Ends with an escape "],
    ];
    for (const [text, shown] of cases) {
      expect(streamingView(text), text).toEqual({ markdown: shown, heldFrom: shown.length });
    }
  });

  it("shows finished text whole", () => {
    for (const text of [
      "Plain words and a [link](https://example.com).",
      "A list:\n1. One\n2. Two",
      "**Bold** and *em* and `code`.",
      "2 * 3 is six",
      "A citation [1].",
    ]) {
      expect(streamingView(text)).toEqual({ markdown: text, heldFrom: text.length });
    }
  });

  it("shows an open code block as a code block, holding only a possible closing fence", () => {
    const growing = streamingView("Try:\n```js\nconst a = 1;\ncons");
    expect(growing.markdown).toBe("Try:\n```js\nconst a = 1;\ncons\n```");
    const el = renderWhole(growing.markdown);
    expect(el.querySelector(".solv-code-pre")?.textContent).toBe("const a = 1;\ncons");

    const closing = streamingView("```js\nconst a = 1;\n``");
    expect(closing).toEqual({ markdown: "```js\nconst a = 1;\n```", heldFrom: 19 });
  });

  it("holds a table header until its delimiter row arrives", () => {
    expect(streamingView("Prices:\n| Plan | Price |\n| --").markdown).toBe("Prices:\n");
    expect(streamingView("| Plan | Price |\n| --- | --- |\n| Free").markdown).toBe(
      "| Plan | Price |\n| --- | --- |\n",
    );
  });
});

describe("a stream fed in awkward chunks", () => {
  it("never shows a partial construct and ends identical to rendering the whole text", () => {
    for (const answer of ANSWERS) {
      const whole = renderWhole(answer);
      const target = visible(whole);
      const chunkings = [
        [...answer].map((_, i) => i), // one character at a time
        awkwardPoints(answer),
        awkwardPoints(answer).map((p) => p + 2),
        [7, 19, 23, 41, 42, 43, 77, 90, 91, 120, 160],
      ];
      for (const points of chunkings) {
        const { frames, el } = stream(chunksAt(answer, points));
        for (const frame of frames) {
          // What is on screen is always the start of the finished answer: a
          // half-written construct would show characters (brackets, a URL,
          // asterisks, backticks) that are gone once it completes.
          expect(target.startsWith(frame), `${JSON.stringify(frame)} in ${answer}`).toBe(true);
        }
        expect(el.innerHTML).toBe(whole.innerHTML);
      }
    }
  });
});
