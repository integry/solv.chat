import { describe, expect, it } from "vitest";
import { stripCitationMarkers } from "../../src/chat/citationMarkers.js";
import { buildPrompt, SAFETY_FRAME_LINKS } from "../../src/chat/prompt.js";
import { linkTargets, rewriteSourceLinks } from "../../src/chat/sourceLinks.js";
import type { ResolvedChunk } from "../../src/ingest/resolve.js";
import evalSet from "../fixtures/source-links-eval.json";

/**
 * The recorded evaluation of how the model refers to sources
 * (`test/fixtures/source-links-eval.json`), replayed through the engine's own
 * link rules: every recorded answer is rewritten as a visitor would get it,
 * counted, and the counts must be the ones the fixture reports. Recording new
 * answers is `scripts/source-links-eval.mjs --record` (needs a provider key).
 */

interface Page {
  title: string;
  url: string;
  headingPath: string;
  text: string;
  sourceKind?: ResolvedChunk["sourceKind"];
}

interface Case {
  id: string;
  question: string;
  sources: string[];
  expect: string[];
  answers: Record<string, string>;
  /** Further answers to the same requests, counted for reference style only. */
  samples?: Record<string, string[]>;
}

type Outcome = "linkedCorrectly" | "linkedNothing" | "linkRemoved";
type Counts = Record<Outcome | "linkedExpectedPage" | "links" | "targetChars", number>;
type Style = Record<"answers" | "referenceLinks" | "definitions", number>;

/** The link targets the model wrote (`](…)` or `][n]`): what each scheme spends on them. */
const TARGET = /\]\([^)]*\)|\]\[\d+\]/gu;
/** A definition (`[1]: https://…`, on its own line or run into the text). */
const DEFINITION = /\[[^\]\n]+\]:[ \t]*<?https?:\/\//u;
/** A reference link, `[words][n]`. */
const REFERENCE = /\[[^\]\n]+\]\[[^\]\n]*\]/u;

const pages = evalSet.pages as unknown as Record<string, Page>;
const cases = evalSet.cases as Case[];
const schemes = evalSet.schemes as unknown as Record<string, { replace?: [string, string][] }>;
const summary = (evalSet as unknown as { summary: Record<string, Counts> }).summary;
const referenceStyle = (evalSet as unknown as { referenceStyle: Record<string, Style> })
  .referenceStyle;

function chunksFor(item: Case) {
  return item.sources.map((id) => {
    const page = pages[id];
    if (!page) throw new Error(`unknown page ${id}`);
    return page;
  });
}

function score(item: Case, answer: string) {
  const result = rewriteSourceLinks(answer, linkTargets(chunksFor(item)));
  return {
    ...result,
    text: stripCitationMarkers(result.text, 6),
    outcome: (result.removed > 0
      ? "linkRemoved"
      : result.linked.length > 0
        ? "linkedCorrectly"
        : "linkedNothing") as Outcome,
  };
}

describe("chat: links in the text, recorded evaluation", () => {
  it("has at least ten real questions, each answered in every scheme", () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
    expect(Object.keys(schemes)).toEqual([
      "source-numbers",
      "reference-numbers",
      "copied-addresses",
    ]);
    // The deployed check's question is one of them.
    expect(cases.map((item) => item.question)).toContain("Is SQLite free to use commercially?");
    for (const item of cases) {
      for (const scheme of Object.keys(schemes)) {
        expect(typeof item.answers[scheme], `${item.id} ${scheme}`).toBe("string");
      }
    }
  });

  it("asks with the engine's own frame, and the other schemes are that frame changed", () => {
    const first = cases[0];
    if (!first) throw new Error("no cases");
    const request = buildPrompt({
      behaviour: { persona: "", sources: "links" },
      chunks: chunksFor(first),
      history: [],
      question: first.question,
    });
    expect(request.system).toBe(SAFETY_FRAME_LINKS);
    expect(schemes["source-numbers"]?.replace).toBeUndefined();
    for (const scheme of ["reference-numbers", "copied-addresses"]) {
      const replace = schemes[scheme]?.replace ?? [];
      expect(replace.length).toBeGreaterThan(0);
      for (const [from] of replace) expect(SAFETY_FRAME_LINKS).toContain(from);
    }
  });

  it("reports the counts the fixture states, from the engine's own rules", () => {
    const counts: Record<string, Counts> = {};
    for (const scheme of Object.keys(schemes)) {
      counts[scheme] = {
        linkedCorrectly: 0,
        linkedNothing: 0,
        linkRemoved: 0,
        linkedExpectedPage: 0,
        links: 0,
        targetChars: 0,
      };
    }
    for (const item of cases) {
      for (const [scheme, total] of Object.entries(counts)) {
        const answer = item.answers[scheme] ?? "";
        const result = score(item, answer);
        total[result.outcome] += 1;
        for (const match of answer.matchAll(TARGET)) {
          total.links += 1;
          total.targetChars += match[0].length;
        }
        // Its link goes to the expected page: at least one link goes to a
        // page the question is about (a written answer's case: no link).
        const expected =
          item.expect.length === 0
            ? result.linked.length === 0
            : result.linked.some((url) => item.expect.includes(url));
        if (expected) total.linkedExpectedPage += 1;
      }
    }
    expect(counts).toEqual(summary);
  });

  it("reports how often each scheme's answers were written in reference style", () => {
    const counts: Record<string, Style> = {};
    for (const scheme of Object.keys(schemes)) {
      const style: Style = { answers: 0, referenceLinks: 0, definitions: 0 };
      for (const item of cases) {
        for (const written of [item.answers[scheme] ?? "", ...(item.samples?.[scheme] ?? [])]) {
          style.answers += 1;
          if (REFERENCE.test(written)) style.referenceLinks += 1;
          if (DEFINITION.test(written)) style.definitions += 1;
        }
      }
      counts[scheme] = style;
    }
    expect(counts).toEqual(referenceStyle);
    // Asked for the inline form, no answer wrote a reference or a definition.
    expect(counts["source-numbers"]).toMatchObject({ referenceLinks: 0, definitions: 0 });
  });

  it("every sample, too, reaches the visitor with no definition and no link but to the case's pages", () => {
    for (const item of cases) {
      const allowed = chunksFor(item)
        .filter((page) => page.sourceKind !== "entry")
        .map((page) => page.url);
      for (const [scheme, written] of Object.entries(item.samples ?? {})) {
        for (const answer of written) {
          const result = score(item, answer);
          for (const url of result.linked) expect(allowed, `${item.id} ${scheme}`).toContain(url);
          expect(result.text).not.toMatch(/\]\[\d+\]|\[\d\]|\]:/u);
        }
      }
    }
  });

  it("sends no link but to the case's own pages, and none for a written answer", () => {
    for (const item of cases) {
      const allowed = chunksFor(item)
        .filter((page) => page.sourceKind !== "entry")
        .map((page) => page.url);
      for (const scheme of Object.keys(schemes)) {
        const result = score(item, item.answers[scheme] ?? "");
        for (const url of result.linked) expect(allowed).toContain(url);
        for (const match of result.text.matchAll(/\]\(([^)\s]+)\)/gu)) {
          expect(allowed.some((url) => (match[1] ?? "").startsWith(url))).toBe(true);
        }
        // No marker and no reference is left for the visitor to see.
        expect(result.text).not.toMatch(/\]\[\d+\]|\[\d\]|\]:/u);
      }
    }
  });
});
