import { type BehaviourConfig, type ChatEvent, newId } from "@solvchat/core";
import type { Tenant } from "../db/tenant.js";
import { type ResolvedChunk, resolveChunks } from "../ingest/resolve.js";
import { costMicros, type ModelInfo } from "../models.js";
import { ProviderError } from "../providers/error.js";
import type { Embedder, Retriever } from "../providers/retrieval.js";
import type { LlmMessage, LlmProvider } from "../providers/types.js";
import type { UsageSink } from "../seams/types.js";
import { buildPrompt } from "./prompt.js";

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
}

function dedupeByUrl(chunks: readonly ResolvedChunk[]): ResolvedChunk[] {
  const seen = new Set<string>();
  const out: ResolvedChunk[] = [];
  for (const chunk of chunks) {
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
  if (input.conversationId !== undefined) {
    const existing = await deps.tenant.conversations.get(input.conversationId);
    if (existing !== null && existing.assistantId === input.assistantId) {
      const prior = await deps.tenant.messages.list(existing.id);
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
  await deps.tenant.messages.create({
    id: newId("msg"),
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

  const [vector] = await deps.embedder.embed([input.message]);
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
    });
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
      }
    }
  } catch (err) {
    if (err instanceof ProviderError) {
      yield { type: "error", message: "The assistant could not complete this response." };
      return;
    }
    throw err;
  }

  // Citations after the text: the widget renders them under the answer, and
  // emitting them first would show links before there is anything to link to.
  const cited = dedupeByUrl(chunks);
  for (const chunk of cited) {
    yield { type: "citation", url: chunk.url, title: chunk.title };
  }

  const messageId = newId("msg");
  const citations = cited.map((c) => ({ url: c.url, title: c.title }));
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
  });

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
