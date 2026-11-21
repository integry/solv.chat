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
}

type Outcome = "linkedCorrectly" | "linkedNothing" | "linkRemoved";
type Counts = Record<Outcome | "linkedExpected" | "links" | "targetChars", number>;

/** The link targets the model wrote (`](…)` or `][n]`): what each scheme spends on them. */
const TARGET = /\]\([^)]*\)|\]\[\d+\]/gu;

const pages = evalSet.pages as unknown as Record<string, Page>;
const cases = evalSet.cases as Case[];
const schemes = evalSet.schemes as unknown as Record<string, { replace?: [string, string][] }>;
const summary = (evalSet as unknown as { summary: Record<string, Counts> }).summary;

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
  it("has at least ten real questions, each answered in both schemes", () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
    expect(Object.keys(schemes)).toEqual(["numbered-references", "copied-addresses"]);
    for (const item of cases) {
      for (const scheme of Object.keys(schemes)) {
        expect(typeof item.answers[scheme], `${item.id} ${scheme}`).toBe("string");
      }
    }
  });

  it("asks with the engine's own frame, and the other scheme is that frame changed", () => {
    const first = cases[0];
    if (!first) throw new Error("no cases");
    const request = buildPrompt({
      behaviour: { persona: "", sources: "links" },
      chunks: chunksFor(first),
      history: [],
      question: first.question,
    });
    expect(request.system).toBe(SAFETY_FRAME_LINKS);
    for (const [from] of schemes["copied-addresses"]?.replace ?? []) {
      expect(SAFETY_FRAME_LINKS).toContain(from);
    }
  });

  it("reports the counts the fixture states, from the engine's own rules", () => {
    const counts: Record<string, Counts> = {};
    for (const scheme of Object.keys(schemes)) {
      counts[scheme] = {
        linkedCorrectly: 0,
        linkedNothing: 0,
        linkRemoved: 0,
        linkedExpected: 0,
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
        const expected =
          item.expect.length === 0
            ? result.linked.length === 0
            : item.expect.every((url) => result.linked.includes(url));
        if (expected) total.linkedExpected += 1;
      }
    }
    expect(counts).toEqual(summary);
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
        expect(result.text).not.toMatch(/\]\[\d+\]|\[\d\]/u);
      }
    }
  });
});
