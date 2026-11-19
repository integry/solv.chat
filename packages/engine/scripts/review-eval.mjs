#!/usr/bin/env node
// Runs the answer review's evaluation set (test/fixtures/review-eval.json)
// against the real fast-tier model, through the same rules the engine uses
// (`runAnswerReview`: fixed frame, tagged data, strict parsing, what a miss
// may be). The unit tests use scripted reviewers and cannot say how well a
// real model classifies or whether it resists injected instructions; this
// does. Opt-in and never run in CI: it spends a little on the provider.
//
//   npm run build -w @solvchat/engine
//   SOLV_ANTHROPIC_KEY=... node packages/engine/scripts/review-eval.mjs
//   SOLV_OPENAI_KEY=...    node packages/engine/scripts/review-eval.mjs --provider openai
//
// Prints one line per case and exits 1 when an injected case is not handled
// as expected (a security property), 0 otherwise. Prints no key.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
const load = (path) => import(new URL(`file://${join(dist, path)}`).href);

const providerName = process.argv.includes("--provider")
  ? process.argv[process.argv.indexOf("--provider") + 1]
  : "anthropic";
const key =
  providerName === "openai" ? process.env.SOLV_OPENAI_KEY : process.env.SOLV_ANTHROPIC_KEY;
if (!key) {
  console.error(
    `Set ${providerName === "openai" ? "SOLV_OPENAI_KEY" : "SOLV_ANTHROPIC_KEY"} to run the evaluation.`,
  );
  process.exit(2);
}

let review;
let models;
let provider;
try {
  review = await load("chat/review.js");
  models = await load("models.js");
  provider =
    providerName === "openai"
      ? (await load("providers/openai.js")).openaiProvider({
          apiKey: key,
          model: models.OPENAI_MODELS.fast.id,
        })
      : (await load("providers/anthropic.js")).anthropicProvider({
          apiKey: key,
          model: models.ANTHROPIC_MODELS.fast.id,
        });
} catch (err) {
  console.error("Build the engine first: npm run build -w @solvchat/engine");
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
}

const set = JSON.parse(
  readFileSync(join(here, "..", "test", "fixtures", "review-eval.json"), "utf8"),
);
const reviewer = review.modelReviewer({ provider, onUsage: async () => {} });

let passed = 0;
let injectionFailures = 0;
for (const item of set.cases) {
  let outcome = null;
  await review.runAnswerReview(
    {
      messages: {
        async setOutcome(_id, value) {
          outcome = value;
          return true;
        },
      },
      reviewer: async () => reviewer,
      subject: async () => set.subjects[item.subject] ?? null,
      limits: { check: async () => ({ ok: true }) },
      usage: { record: async () => {} },
    },
    {
      orgId: "org_eval",
      assistantId: "ast_eval",
      messageId: `msg_${item.id}`,
      question: item.question,
      reply: item.reply,
      retrievalMiss: item.retrievalMiss,
    },
  );
  const ok = outcome !== null && item.accept.includes(outcome);
  if (ok) passed += 1;
  else if (item.injection) injectionFailures += 1;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${item.id}: ${outcome ?? "no decision"} (accepts ${item.accept.join(", ")})`,
  );
}
console.log(`\n${passed} of ${set.cases.length} cases as expected.`);
process.exit(injectionFailures > 0 ? 1 : 0);
