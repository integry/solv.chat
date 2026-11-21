import { describe, expect, it } from "vitest";
import { markerStripper } from "../../src/chat/citationMarkers.js";
import { linkTargets, rewriteSourceLinks, sourceLinker } from "../../src/chat/sourceLinks.js";
import deployed from "../fixtures/reference-style-answer.json";

/**
 * "Link in the text" when the model writes reference-style Markdown with its
 * own definitions (`[the FAQ][2]` … `[2]: https://…/faq.html`), numbered
 * differently from the sources it was given. Each link must go where the
 * model's own definition of its label says, and only to a page retrieved for
 * the answer; no definition and no marker reaches the visitor, however the
 * stream is cut. The fixture is the answer a deployed check showed.
 */

const TOP_K = 6;
const targets = linkTargets(deployed.sources);
const retrieved = new Set(deployed.sources.map((source) => source.url));

/** The filter an answer in "links" mode goes through: links, then markers (as `answer.ts`). */
function filter() {
  const linker = sourceLinker(targets);
  const stripper = markerStripper(TOP_K);
  return {
    push: (chunk: string) => stripper.push(linker.push(chunk)),
    flush: () => stripper.push(linker.flush()) + stripper.flush(),
    get text() {
      return stripper.text;
    },
  };
}

/** Streams `text` cut at `cuts` through the filter; returns every delta, the flush last. */
function stream(text: string, cuts: readonly number[]): { deltas: string[]; stored: string } {
  const f = filter();
  const deltas: string[] = [];
  let at = 0;
  for (const cut of [...cuts, text.length]) {
    deltas.push(f.push(text.slice(at, cut)));
    at = cut;
  }
  deltas.push(f.flush());
  return { deltas, stored: f.text };
}

/** The links in a text, as `[words, address]`. */
function links(text: string): [string, string][] {
  return [...text.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/gu)].map((m) => [m[1] ?? "", m[2] ?? ""]);
}

/** What the visitor may see: no definition, no marker, every link to its own definition's page. */
function expectClean(text: string): void {
  expect(text).not.toMatch(/\[[^\]]*\]:/u);
  expect(text).not.toMatch(/\[\d+\]/u);
  expect(text).not.toContain("][");
  expect(Object.fromEntries(links(text))).toEqual(deployed.expected);
  for (const [, url] of links(text)) expect(retrieved).toContain(url);
  // No address is left as text: the three there are are the links'.
  expect(text.match(/https:\/\//gu)?.length).toBe(3);
}

/** A small seeded generator, so the random cuts are the same on every run. */
function cutsFor(seed: number, length: number, count: number): number[] {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state / 2 ** 31;
  };
  return [
    ...new Set(Array.from({ length: count }, () => 1 + Math.floor(next() * (length - 1)))),
  ].sort((a, b) => a - b);
}

describe("chat: an answer's own reference definitions", () => {
  it("the deployed answer's labels are numbered differently from its sources", () => {
    // The point of the fixture: read against the sources' numbering, every
    // link would go to a page its words do not name.
    for (const [label, n] of [
      ["copyright page", 1],
      ["FAQ", 2],
      ["support options page", 3],
    ] as const) {
      expect(deployed.sources[n - 1]?.url).not.toBe(deployed.expected[label]);
    }
  });

  for (const [name, answer] of [
    ["run together, as the visitor saw them", deployed.answer],
    ["on lines of their own", deployed.answerOnLines],
  ] as const) {
    describe(`definitions ${name}`, () => {
      it("links each phrase to the page its own definition names, whole", () => {
        const result = rewriteSourceLinks(answer, targets);
        expectClean(result.text);
        expect(result.removed).toBe(0);
        expect(result.text.trimEnd()).toMatch(
          /support options page\]\(https:\/\/sqlite\.org\/support\.html\)\.$/u,
        );
      });

      it("gives the same text cut at any one place", () => {
        const whole = stream(answer, []).stored;
        expectClean(whole);
        for (let cut = 1; cut < answer.length; cut++) {
          const { deltas, stored } = stream(answer, [cut]);
          expect(deltas.join(""), `cut at ${cut}`).toBe(stored);
          expect(stored, `cut at ${cut}`).toBe(whole);
        }
      });

      it("gives the same text one character at a time and in random pieces", () => {
        const whole = stream(answer, []).stored;
        const each = stream(
          answer,
          Array.from({ length: answer.length - 1 }, (_, i) => i + 1),
        );
        expect(each.deltas.join("")).toBe(whole);
        expect(each.stored).toBe(whole);
        for (let seed = 1; seed <= 60; seed++) {
          const cuts = cutsFor(seed, answer.length, 1 + (seed % 9));
          const { deltas, stored } = stream(answer, cuts);
          expect(deltas.join(""), `cuts ${cuts.join(",")}`).toBe(whole);
          expect(stored).toBe(whole);
        }
      });

      it("sends no link before the definition it needs has arrived", () => {
        // Cut just before the definitions start: nothing linked by number is
        // sent yet, so nothing can have gone to the sources' numbering.
        const defsAt = answer.indexOf("[1]:");
        const { deltas } = stream(answer, [defsAt]);
        // (The space before it waits too: a marker could still follow it.)
        expect(deltas[0]).toBe(answer.slice(0, answer.indexOf("[copyright page]")).trimEnd());
        for (const delta of deltas) {
          for (const [label, url] of links(delta)) {
            expect(url).toBe(deployed.expected[label as keyof typeof deployed.expected]);
          }
        }
      });
    });
  }

  it("reduces a link to its text when its definition goes to a page not retrieved", () => {
    const result = rewriteSourceLinks(
      "Read [the FAQ][1] and [the forum][2].\n\n[1]: https://sqlite.org/faq.html\n[2]: https://evil.example/forum\n",
      targets,
    );
    expect(result.text).toBe("Read [the FAQ](https://sqlite.org/faq.html) and the forum.\n\n");
    expect(result.removed).toBe(1);
  });

  it("with definitions in the answer, a label it does not define is no link", () => {
    // [2] would be copyright.html by the sources' numbering; the answer numbers its own way.
    const result = rewriteSourceLinks(
      "See [the FAQ][1] and [the licence][2].\n\n[1]: https://sqlite.org/faq.html",
      targets,
    );
    expect(result.text).toBe("See [the FAQ](https://sqlite.org/faq.html) and the licence.\n\n");
  });

  it("resolves named and collapsed labels, any case, and a definition with a title", () => {
    const result = rewriteSourceLinks(
      'Read [the FAQ][faq] and [Support][].\n\n[FAQ]: <https://sqlite.org/faq.html> "FAQ"\n[support]: https://sqlite.org/support.html',
      targets,
    );
    expect(result.text).toBe(
      "Read [the FAQ](https://sqlite.org/faq.html) and [Support](https://sqlite.org/support.html).\n\n",
    );
  });

  it("with no definition anywhere, a numbered reference means the sources' numbers", () => {
    expect(rewriteSourceLinks("Read [the FAQ][4].", targets).text).toBe(
      "Read [the FAQ](https://sqlite.org/faq.html).",
    );
  });

  it("takes out stray definitions and markers, split anywhere and at the very end", () => {
    for (const answer of [
      "Yes, it is free [1].\n\n[1]: https://sqlite.org/copyright.html",
      "Yes, it is free.[2]: https://sqlite.org/faq.html",
      "Yes, it is free.\n\n[1]: https://evil.example/x\n[2]:",
      "Yes, it is free.\n[1]:",
    ]) {
      const whole = stream(answer, []).stored;
      expect(whole.trimEnd(), answer).toBe("Yes, it is free.");
      for (let cut = 1; cut < answer.length; cut++) {
        const { deltas, stored } = stream(answer, [cut, Math.min(answer.length, cut + 3)]);
        expect(deltas.join(""), `${answer} cut at ${cut}`).toBe(whole);
        expect(stored).toBe(whole);
      }
    }
  });

  it("links an address written in the text when it was retrieved, and leaves any other as text", () => {
    const answer =
      "The licence is at https://sqlite.org/copyright.html. Ask on https://evil.example/forum, or see https://sqlite.org/faq.html";
    const expected =
      "The licence is at [https://sqlite.org/copyright.html](https://sqlite.org/copyright.html). " +
      "Ask on https://evil.example/forum, or see [https://sqlite.org/faq.html](https://sqlite.org/faq.html)";
    expect(stream(answer, []).stored).toBe(expected);
    for (let cut = 1; cut < answer.length; cut++) {
      const { deltas } = stream(answer, [cut]);
      expect(deltas.join(""), `cut at ${cut}`).toBe(expected);
    }
    // Linked even when the paragraph already links that page by its words.
    expect(
      rewriteSourceLinks("The [FAQ](4) is at https://sqlite.org/faq.html.", targets).text,
    ).toBe(
      "The [FAQ](https://sqlite.org/faq.html) is at [https://sqlite.org/faq.html](https://sqlite.org/faq.html).",
    );
    // An address in code stays as written.
    expect(rewriteSourceLinks("Run `curl https://sqlite.org/faq.html`.", targets).text).toBe(
      "Run `curl https://sqlite.org/faq.html`.",
    );
  });
});
