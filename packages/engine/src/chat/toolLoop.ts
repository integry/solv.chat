import { MAX_ACTION_RESULT_BYTES } from "@solvchat/core";
import { costMicros, type ModelInfo } from "../models.js";
import { ProviderError } from "../providers/error.js";
import type {
  LlmChunk,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmToolResult,
  ToolCall,
  ToolDefinition,
} from "../providers/types.js";

// Chosen here because the specification names caps but no numbers.
// Four iterations: enough for "look it up, then look up what that referenced",
// short of a model that asks for the same tool forever.
export const MAX_TOOL_ITERATIONS = 4;
// Twenty calls per conversation: an upper bound on what one visitor can spend
// of the owner's tool budget, counted from the calls already stored.
export const MAX_TOOL_CALLS_PER_CONVERSATION = 20;
// Fifteen seconds for the whole tool part of one answer: a visitor is watching
// a cursor blink, and a Worker is not free to wait.
export const TOOL_WALL_TIME_MS = 15_000;
// Shared with page actions so one kind of tool cannot smuggle more text into a
// prompt than the other.
export const MAX_TOOL_RESULT_BYTES = MAX_ACTION_RESULT_BYTES;

const RESULT_PREVIEW_CHARS = 200;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface ToolRunResult {
  content: string;
  isError: boolean;
}

/** What a tool source provides: the definitions and a way to run one. */
export interface ToolRunner {
  readonly kind: "mcp" | "action";
  readonly definitions: readonly ToolDefinition[];
  run(call: ToolCall, signal: AbortSignal): Promise<ToolRunResult>;
}

/** What is stored on the message; never the result body. */
export interface StoredToolCall {
  callId: string;
  name: string;
  kind: "mcp" | "action";
  ok: boolean;
  ms: number;
  input: Record<string, unknown>;
  resultBytes: number;
  /** First characters only, so Conversations can show what came back. */
  resultPreview: string;
}

export type ToolLoopEvent =
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      call: ToolCall;
      state: "running" | "done";
      ok?: boolean;
      source: "mcp" | "action";
    };

export interface ToolLoopDeps {
  provider: LlmProvider;
  model: ModelInfo;
  runners: readonly ToolRunner[];
  /** Calls already stored in this conversation, for the per-conversation cap. */
  priorCalls: number;
  /** Recorded per model call so the spend cap sees real spend, not one event. */
  onModelUsage: (tokensIn: number, tokensOut: number, costMicros: number) => Promise<void>;
  now?: (() => number) | undefined;
}

export interface ToolLoopOutcome {
  text: string;
  calls: StoredToolCall[];
}

/** Truncates on a UTF-8 boundary and says so, so the model is not misled. */
function capResult(content: string): { content: string; bytes: number } {
  const bytes = encoder.encode(content);
  if (bytes.byteLength <= MAX_TOOL_RESULT_BYTES) {
    return { content, bytes: bytes.byteLength };
  }
  // `decoder` is non-fatal, so a split multi-byte character becomes U+FFFD
  // rather than throwing; the marker tells the model the data is incomplete,
  // which is the difference between a short answer and a wrong one.
  const head = decoder.decode(bytes.slice(0, MAX_TOOL_RESULT_BYTES));
  return {
    content: `${head}\n\n[truncated: result was ${bytes.byteLength} bytes]`,
    bytes: bytes.byteLength,
  };
}

/**
 * Streams an answer, running tools the model asks for until it stops asking or
 * a cap is reached. Provider-independent and tool-source-independent: the only
 * things it knows are the LlmProvider interface and the ToolRunner list.
 */
export async function* runToolLoop(
  deps: ToolLoopDeps,
  request: LlmRequest,
): AsyncGenerator<ToolLoopEvent, ToolLoopOutcome, undefined> {
  const clock = deps.now ?? Date.now;
  const startedAt = clock();
  const byName = new Map<string, ToolRunner>();
  const definitions: ToolDefinition[] = [];
  for (const runner of deps.runners) {
    for (const definition of runner.definitions) {
      // First runner to claim a name keeps it. Ambiguity here would mean the
      // engine choosing which credential a call runs with, which is the one
      // decision it must never make by accident.
      if (!byName.has(definition.name)) {
        byName.set(definition.name, runner);
        definitions.push(definition);
      }
    }
  }

  const messages: LlmMessage[] = [...request.messages];
  const calls: StoredToolCall[] = [];
  let text = "";
  let toolsOffered = definitions.length > 0;
  let budgetNoticeSent = false;

  for (let iteration = 0; ; iteration++) {
    const stream = deps.provider.stream({
      ...request,
      messages: [...messages],
      // Omitted once tools are exhausted or never offered, so a no-tools answer
      // serialises exactly as it did in phase 1.
      ...(toolsOffered ? { tools: definitions } : {}),
    });

    const asked: ToolCall[] = [];
    let tokensIn = 0;
    let tokensOut = 0;
    let usageReported = false;
    let completed = false;
    let assistantText = "";

    try {
      for await (const chunk of stream as AsyncIterable<LlmChunk>) {
        if (chunk.kind === "text") {
          assistantText += chunk.text;
          text += chunk.text;
          // Forwarded as it arrives: the visible difference between this and a
          // form is that the answer starts at once, and a tool round must not
          // take that away.
          yield { kind: "text", text: chunk.text };
        } else if (chunk.kind === "tool_call") {
          asked.push(chunk.call);
        } else {
          tokensIn = chunk.tokensIn;
          tokensOut = chunk.tokensOut;
          usageReported = true;
        }
      }
      completed = true;
    } finally {
      // Per model call, so three calls bill three times. Recorded in `finally`
      // for the same reason phase 1 records before persisting: tokens the
      // provider reported are owed whether or not the rest of the turn works.
      if (usageReported || completed) {
        await deps.onModelUsage(tokensIn, tokensOut, costMicros(deps.model, tokensIn, tokensOut));
      }
    }

    if (asked.length === 0) {
      return { text, calls };
    }

    // Caps are checked after the model asked, not before: the model is allowed
    // to want a tool, it is just not allowed to get one.
    const overIterations = iteration >= MAX_TOOL_ITERATIONS;
    const overConversation =
      deps.priorCalls + calls.length + asked.length > MAX_TOOL_CALLS_PER_CONVERSATION;
    const overTime = clock() - startedAt >= TOOL_WALL_TIME_MS;

    if (overIterations || overConversation || overTime) {
      if (budgetNoticeSent) return { text, calls };
      budgetNoticeSent = true;
      toolsOffered = false;
      messages.push(
        { role: "assistant", content: assistantText, toolCalls: asked },
        {
          role: "tool_results",
          results: asked.map((call) => ({
            callId: call.callId,
            // Said once, as a result rather than a system instruction: the
            // model then answers from what it has instead of apologising for
            // an internal budget the visitor cannot see.
            content:
              "No more tools are available for this answer. Answer from what you already have.",
            isError: true,
          })),
        },
      );
      continue;
    }

    const controller = new AbortController();
    const remaining = Math.max(0, TOOL_WALL_TIME_MS - (clock() - startedAt));
    const timer = setTimeout(() => controller.abort(), remaining);
    const results: LlmToolResult[] = [];

    try {
      for (const call of asked) {
        const runner = byName.get(call.name);
        yield { kind: "tool", call, state: "running", source: runner?.kind ?? "mcp" };
        const callStarted = clock();
        let outcome: ToolRunResult;
        try {
          if (!runner) {
            // The model named a tool nobody offered. A result, not a throw: the
            // answer is still worth finishing.
            outcome = { content: `No tool named ${call.name} is available.`, isError: true };
          } else {
            outcome = await runner.run(call, controller.signal);
          }
        } catch (err) {
          if (err instanceof ProviderError) throw err;
          // Nothing from the failure is forwarded: a server's error body can
          // quote the request, and this string reaches a prompt.
          outcome = {
            content: controller.signal.aborted
              ? "The tool did not answer in time."
              : "The tool could not be called.",
            isError: true,
          };
        }
        const capped = capResult(outcome.content);
        results.push({ callId: call.callId, content: capped.content, isError: outcome.isError });
        calls.push({
          callId: call.callId,
          name: call.name,
          kind: runner?.kind ?? "mcp",
          ok: !outcome.isError,
          ms: clock() - callStarted,
          input: call.input,
          resultBytes: capped.bytes,
          // A prefix, not the body: the owner needs to see what happened, and
          // a third party's payload is not theirs to keep.
          resultPreview: outcome.content.slice(0, RESULT_PREVIEW_CHARS),
        });
        yield {
          kind: "tool",
          call,
          state: "done",
          ok: !outcome.isError,
          source: runner?.kind ?? "mcp",
        };
      }
    } finally {
      clearTimeout(timer);
    }

    messages.push(
      { role: "assistant", content: assistantText, toolCalls: asked },
      { role: "tool_results", results },
    );
  }
}
