#!/usr/bin/env node
// The evaluation behind "Link in the text" (test/fixtures/source-links-eval.json):
// real questions against documentation corpora, each answered in three
// schemes from the same sources: with the engine's frame (link words by the
// source's number, `[words](2)`), with the frame it replaced (the same by a
// reference, `[words][2]`, which models sometimes finished with definitions
// of their own, `[1]: https://…`), and asked to copy the sources' addresses
// (`[words](https://…)`). Every answer goes through the engine's own link
// rules (`sourceLinks.ts`, then the marker filter), and each is counted as
// linked correctly, linked nothing, or had a link removed, and whether its
// links go to the page the question is about. Each answer written in
// reference style (a `[words][n]` link or a definition) is counted too:
// that is what the frame change is measured by. `samples` holds further
// answers to the same requests, counted for reference style only.
// `test/chat/sourceLinksEval.test.ts` replays the recorded answers and checks
// the counts; this script records new ones against the real model. Opt-in
// and never run in CI: it spends a little on the provider.
//
//   npm run build -w @solvchat/engine
//   node packages/engine/scripts/source-links-eval.mjs            # score the recorded answers
//   node packages/engine/scripts/source-links-eval.mjs --prompts  # print the exact requests
//   node packages/engine/scripts/source-links-eval.mjs --summarize  # write the counts into the fixture
//   SOLV_ANTHROPIC_KEY=... node packages/engine/scripts/source-links-eval.mjs --record
//   SOLV_OPENAI_KEY=...    node packages/engine/scripts/source-links-eval.mjs --record --provider openai
//
// --record answers every case with the balanced tier and writes the answers
// and the model into the fixture (and drops the samples, which were answers
// to the same requests by other means). Prints no key.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
const fixturePath = join(here, "..", "test", "fixtures", "source-links-eval.json");
const load = (path) => import(new URL(`file://${join(dist, path)}`).href);

let prompt;
let links;
let markers;
try {
  prompt = await load("chat/prompt.js");
  links = await load("chat/sourceLinks.js");
  markers = await load("chat/citationMarkers.js");
} catch (err) {
  console.error("Build the engine first: npm run build -w @solvchat/engine");
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
}

const set = JSON.parse(readFileSync(fixturePath, "utf8"));
const TOP_K = 6;

/** The chunks a case was given, in retrieval order. */
function chunksFor(item) {
  return item.sources.map((id) => ({ ...set.pages[id] }));
}

/** The exact request the engine makes for a case, with the scheme's frame. */
function requestFor(item, scheme) {
  const request = prompt.buildPrompt({
    behaviour: { persona: "", sources: "links" },
    chunks: chunksFor(item),
    history: [],
    question: item.question,
  });
  for (const [from, to] of set.schemes[scheme].replace ?? []) {
    if (!request.system.includes(from)) throw new Error(`frame no longer contains: ${from}`);
    request.system = request.system.replace(from, to);
  }
  return request;
}

/** What the engine makes of an answer: the text sent, and how its links fared. */
function score(item, answer) {
  const result = links.rewriteSourceLinks(answer, links.linkTargets(chunksFor(item)));
  const text = markers.stripCitationMarkers(result.text, TOP_K);
  const outcome =
    result.removed > 0
      ? "linkRemoved"
      : result.linked.length > 0
        ? "linkedCorrectly"
        : "linkedNothing";
  return { outcome, linked: result.linked, removed: result.removed, text };
}

if (process.argv.includes("--prompts")) {
  const out = [];
  for (const item of set.cases) {
    for (const scheme of Object.keys(set.schemes)) {
      out.push({ id: item.id, scheme, ...requestFor(item, scheme) });
    }
  }
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

if (process.argv.includes("--record")) {
  const providerName = process.argv.includes("--provider")
    ? process.argv[process.argv.indexOf("--provider") + 1]
    : "anthropic";
  const key =
    providerName === "openai" ? process.env.SOLV_OPENAI_KEY : process.env.SOLV_ANTHROPIC_KEY;
  if (!key) {
    console.error(
      `Set ${providerName === "openai" ? "SOLV_OPENAI_KEY" : "SOLV_ANTHROPIC_KEY"} to record.`,
    );
    process.exit(2);
  }
  const models = await load("models.js");
  const model =
    providerName === "openai" ? models.OPENAI_MODELS.balanced : models.ANTHROPIC_MODELS.balanced;
  const provider =
    providerName === "openai"
      ? (await load("providers/openai.js")).openaiProvider({ apiKey: key, model: model.id })
      : (await load("providers/anthropic.js")).anthropicProvider({ apiKey: key, model: model.id });
  for (const item of set.cases) {
    item.answers = {};
    for (const scheme of Object.keys(set.schemes)) {
      let text = "";
      for await (const chunk of provider.stream(requestFor(item, scheme))) {
        if (chunk.kind === "text") text += chunk.text;
      }
      item.answers[scheme] = text;
    }
    delete item.samples;
  }
  set.recorded = {
    model: model.id,
    how: `The engine's own requests (scripts/source-links-eval.mjs --record) to ${providerName}.`,
    on: new Date().toISOString().slice(0, 10),
  };
}

/** A definition (`[1]: https://…`, on its own line or run into the text). */
const DEFINITION = /\[[^\]\n]+\]:[ \t]*<?https?:\/\//u;
/** A reference link, `[words][n]`. */
const REFERENCE = /\[[^\]\n]+\]\[[^\]\n]*\]/u;

const totals = {};
const style = {};
for (const scheme of Object.keys(set.schemes)) {
  totals[scheme] = {
    linkedCorrectly: 0,
    linkedNothing: 0,
    linkRemoved: 0,
    linkedExpectedPage: 0,
    links: 0,
    targetChars: 0,
  };
  style[scheme] = { answers: 0, referenceLinks: 0, definitions: 0 };
}
/** The link targets the model wrote (`](…)` or `][n]`): what each scheme spends on them. */
const TARGET = /\]\([^)]*\)|\]\[\d+\]/gu;
for (const item of set.cases) {
  for (const scheme of Object.keys(set.schemes)) {
    const answer = item.answers?.[scheme];
    if (typeof answer !== "string") continue;
    const result = score(item, answer);
    totals[scheme][result.outcome] += 1;
    // Its link goes where it should: at least one link to a page the
    // question is about (a written answer's case: no link at all).
    const expected =
      item.expect.length === 0
        ? result.linked.length === 0
        : result.linked.some((url) => item.expect.includes(url));
    if (expected) totals[scheme].linkedExpectedPage += 1;
    for (const match of answer.matchAll(TARGET)) {
      totals[scheme].links += 1;
      totals[scheme].targetChars += match[0].length;
    }
    for (const written of [answer, ...(item.samples?.[scheme] ?? [])]) {
      style[scheme].answers += 1;
      if (REFERENCE.test(written)) style[scheme].referenceLinks += 1;
      if (DEFINITION.test(written)) style[scheme].definitions += 1;
    }
    console.log(
      `${scheme.padEnd(20)} ${item.id.padEnd(22)} ${result.outcome.padEnd(16)} linked ${result.linked.join(", ") || "nothing"}${result.removed ? `, ${result.removed} removed` : ""}`,
    );
  }
}
console.log("");
for (const [scheme, counts] of Object.entries(totals)) {
  console.log(
    `${scheme}: ${counts.linkedCorrectly} linked correctly, ${counts.linkedNothing} linked nothing, ${counts.linkRemoved} had a link removed; in ${counts.linkedExpectedPage} of ${set.cases.length} a link goes to the page the question is about (for a written answer: no link); ${counts.links} links written with ${counts.targetChars} characters of targets.`,
  );
  const s = style[scheme];
  console.log(
    `  reference style: ${s.referenceLinks} of ${s.answers} answers wrote [words][n], ${s.definitions} wrote definitions.`,
  );
}
if (process.argv.includes("--record") || process.argv.includes("--summarize")) {
  set.summary = totals;
  set.referenceStyle = style;
  writeFileSync(fixturePath, `${JSON.stringify(set, null, 2)}\n`);
  console.log(`\nRecorded in ${fixturePath}.`);
}
