import { type BehaviourConfig, type ChatEvent, newId } from "@solvchat/core";
import type { Tenant } from "../db/tenant.js";
import { type ResolvedChunk, resolveChunks } from "../ingest/resolve.js";
import { costMicros, type ModelInfo } from "../models.js";
import { ProviderError } from "../providers/error.js";
import { type Embedder, embeddingCostMicros, type Retriever } from "../providers/retrieval.js";
import type { LlmMessage, LlmProvider } from "../providers/types.js";
import type { UsageSink } from "../seams/types.js";
import { buildPrompt, MAX_TURNS } from "./prompt.js";

// A chunk below the floor is noise; including it would make the model answer
// from unrelated pages, which is worse than admitting the gap. The numbers are
// ours: the spec says "above a score floor" and stops.
export const SCORE_FLOOR = 0.3;
export const TOP_K = 6;

export interface AnswerDeps {
  tenant: Tenant;
  embedder: Embedder;
  retriever: Retriever;
  provider: LlmProvider;
  model: ModelInfo;
  usage: UsageSink;
  now?: (() => number) | undefined;
}

export interface AnswerInput {
  orgId: string;
  assistantId: string;
  visitorId: string;
  message: string;
  behaviour: BehaviourConfig;
  conversationId?: string | undefined;
  pageUrl?: string | undefined;
  preview?: boolean | undefined;
  history?: readonly LlmMessage[] | undefined;
}

/**
 * The chunks a visitor can follow. Hand-written entries are excluded: their
 * URL points into the admin, where a visitor meets a sign-in screen.
 */
function citableByUrl(chunks: readonly ResolvedChunk[]): ResolvedChunk[] {
  const seen = new Set<string>();
  const out: ResolvedChunk[] = [];
  for (const chunk of chunks) {
    if (chunk.sourceKind === "entry") continue;
    if (seen.has(chunk.url)) continue;
    seen.add(chunk.url);
    out.push(chunk);
  }
  return out;
}

async function ensureConversation(
  deps: AnswerDeps,
  input: AnswerInput,
  now: number,
): Promise<{ conversationId: string; history: LlmMessage[] }> {
  if (input.preview) {
    // Owner previews stay out of D1 so they never appear in Conversations or
    // Gaps; the pane resends its own recent turns in the request body.
    return {
      conversationId: newId("cnv"),
      history: input.history ? [...input.history] : [],
    };
  }

  if (input.conversationId !== undefined) {
    const existing = await deps.tenant.conversations.get(input.conversationId);
    if (
      existing !== null &&
      existing.assistantId === input.assistantId &&
      existing.visitorId === input.visitorId
    ) {
      // Only what the prompt can use: a long conversation should not cost a
      // full read on every turn.
      const prior = await deps.tenant.messages.recent(existing.id, MAX_TURNS);
      return {
        conversationId: existing.id,
        history: prior.map((m) => ({ role: m.role, content: m.content })),
      };
    }
  }

  const conversationId = newId("cnv");
  await deps.tenant.conversations.create({
    id: conversationId,
    assistantId: input.assistantId,
    visitorId: input.visitorId,
    startedAt: now,
    pageUrl: input.pageUrl ?? "",
  });
  return { conversationId, history: [] };
}

async function recordMessageUsage(
  deps: AnswerDeps,
  input: AnswerInput,
  at: number,
  tokensIn: number,
  tokensOut: number,
  cost: number,
): Promise<void> {
  // Usage goes through the seam, never straight into usage_daily: the hosted
  // service meters and bills from these events.
  await deps.usage.record({
    orgId: input.orgId,
    assistantId: input.assistantId,
    at,
    messages: 1,
    tokensIn,
    tokensOut,
    costMicros: cost,
  });
}

/**
 * Records spend that is not a message — the question was embedded but no
 * answer was produced — so `usage_daily.messages` keeps counting answers only.
 */
async function recordEmbeddingOnly(
  deps: AnswerDeps,
  input: AnswerInput,
  at: number,
  cost: number,
): Promise<void> {
  if (cost === 0) return;
  await deps.usage.record({
    orgId: input.orgId,
    assistantId: input.assistantId,
    at,
    messages: 0,
    tokensIn: 0,
    tokensOut: 0,
    costMicros: cost,
  });
}

/**
 * Runs the retrieval, prompt, streaming, citation, persistence, and usage
 * pipeline for one visitor message.
 */
export async function* answerMessage(
  deps: AnswerDeps,
  input: AnswerInput,
): AsyncIterable<ChatEvent> {
  const clock = deps.now ?? Date.now;
  const { conversationId, history } = await ensureConversation(deps, input, clock());

  // Persist the visitor's message before calling anything: if the provider
  // fails, the owner still sees the question in Conversations, which is the
  // only way they can find out what went wrong.
  // Every reply below records this id, so Gaps and "Write the right answer"
  // follow the question this request asked, even if another request appended
  // a question to the same conversation while this one was retrieving.
  const questionId = newId("msg");
  if (!input.preview) {
    await deps.tenant.messages.create({
      id: questionId,
      conversationId,
      role: "user",
      content: input.message,
      citations: [],
      toolCalls: null,
      tokensIn: 0,
      tokensOut: 0,
      answered: true,
      createdAt: clock(),
    });
  }

  // The question's embedding is billed whatever happens next — a failing
  // retriever, D1 read or model call must not make it vanish — so it is
  // recorded the moment the provider reports it, as spend that is not a
  // message. The answer's own usage event below carries model tokens only.
  const embedded = await deps.embedder.embed([input.message], (tokens) =>
    recordEmbeddingOnly(deps, input, clock(), embeddingCostMicros(tokens)),
  );
  const [vector] = embedded.vectors;
  if (!vector) {
    yield { type: "error", message: "The assistant could not complete this response." };
    return;
  }

  const hits = await deps.retriever.query({
    vector,
    orgId: input.orgId,
    assistantId: input.assistantId,
    topK: TOP_K,
  });
  const aboveFloor = hits.filter((hit) => hit.score >= SCORE_FLOOR);
  const chunks = await resolveChunks(deps.tenant, input.assistantId, aboveFloor);

  if (chunks.length === 0) {
    // No model call at all: there is nothing to answer from, so spending a
    // request to have the model say so is waste — and it might answer anyway
    // from its own training.
    yield { type: "token", text: input.behaviour.fallbackText };
    const messageId = newId("msg");
    if (!input.preview) {
      await deps.tenant.messages.create({
        id: messageId,
        conversationId,
        role: "assistant",
        content: input.behaviour.fallbackText,
        citations: [],
        toolCalls: null,
        tokensIn: 0,
        tokensOut: 0,
        answered: false,
        createdAt: clock(),
        replyTo: questionId,
      });
    }
    await recordMessageUsage(deps, input, clock(), 0, 0, 0);
    yield { type: "done", messageId, conversationId };
    return;
  }

  const request = buildPrompt({
    behaviour: input.behaviour,
    chunks,
    history,
    question: input.message,
  });

  let text = "";
  let tokensIn = 0;
  let tokensOut = 0;
  let usageReported = false;

  try {
    for await (const chunk of deps.provider.stream(request)) {
      if (chunk.kind === "text") {
        text += chunk.text;
        // Forward immediately rather than buffering: the visible difference
        // between this product and a form is that the answer starts at once.
        yield { type: "token", text: chunk.text };
      } else {
        tokensIn = chunk.tokensIn;
        tokensOut = chunk.tokensOut;
        usageReported = true;
      }
    }
  } catch (err) {
    if (err instanceof ProviderError) {
      if (usageReported) {
        await recordMessageUsage(
          deps,
          input,
          clock(),
          tokensIn,
          tokensOut,
          costMicros(deps.model, tokensIn, tokensOut),
        );
      }
      yield { type: "error", message: "The assistant could not complete this response." };
      return;
    }
    throw err;
  }

  // Citations after the text: the widget renders them under the answer, and
  // emitting them first would show links before there is anything to link to.
  const cited = citableByUrl(chunks);
  for (const chunk of cited) {
    yield { type: "citation", url: chunk.url, title: chunk.title };
  }

  const messageId = newId("msg");
  const citations = cited.map((c) => ({ url: c.url, title: c.title }));
  if (!input.preview) {
    await deps.tenant.messages.create({
      id: messageId,
      conversationId,
      role: "assistant",
      content: text,
      citations,
      toolCalls: null,
      tokensIn,
      tokensOut,
      answered: true,
      createdAt: clock(),
      replyTo: questionId,
    });
  }

  await recordMessageUsage(
    deps,
    input,
    clock(),
    tokensIn,
    tokensOut,
    costMicros(deps.model, tokensIn, tokensOut),
  );

  yield { type: "done", messageId, conversationId };
}
