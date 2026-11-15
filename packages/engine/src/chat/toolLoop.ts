import { MAX_ACTION_RESULT_BYTES } from "@solvchat/core";
import { costMicros, type ModelInfo } from "../models.js";
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
  /** Set by a runner that cannot run the call here. */
  pause?: boolean;
}

/**
 * A runner's answer meaning "this call belongs to the client". The loop stops
 * and returns the pending calls; the caller emits `action` events and waits
 * for a follow-up request carrying the results.
 */
export const PAUSE_FOR_CLIENT: ToolRunResult = {
  content: "",
  isError: false,
  pause: true,
};

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
  /** True while awaiting client execution on a paused action reply. */
  pending?: boolean;
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
  /**
   * Atomically reserves `count` tool calls before dispatch. When omitted
   * (previews or standalone callers), the loop checks `priorCalls + calls.length`.
   */
  reserveCalls?: ((count: number) => Promise<boolean>) | undefined;
  /** Recorded per model call so the spend cap sees real spend, not one event. */
  onModelUsage: (tokensIn: number, tokensOut: number, costMicros: number) => Promise<void>;
  /**
   * Optional lease/ownership check called before model/tool work and before
   * emitting output. Returning false stops the loop without suppressing
   * already-reported model usage.
   */
  ensureLease?: (() => Promise<boolean>) | undefined;
  now?: (() => number) | undefined;
}

export interface PendingToolTurn {
  assistantText: string;
  asked: ToolCall[];
  /** Server-side tool results from the same round that paused on a client action. */
  completedResults: LlmToolResult[];
}

export interface ToolLoopContinuation {
  /** Completed tool-exchange messages (assistant + tool_results) within this answer. */
  messages: LlmMessage[];
  /** The in-flight round that paused for client action(s). */
  pendingTurn: PendingToolTurn;
}

export interface ToolLoopOutcome {
  text: string;
  calls: StoredToolCall[];
  /** Calls the client must run. Empty when the answer finished. */
  pending: ToolCall[];
  /** Present only when `pending.length > 0`, to restore model context on resume. */
  continuation?: ToolLoopContinuation | undefined;
  /** True when the loop stopped early because the caller lost its resume lease. */
  abortedByLease?: boolean | undefined;
}

/** Truncates on a UTF-8 boundary and says so, so the model is not misled. */
function capResult(content: string): { content: string; bytes: number } {
  const bytes = encoder.encode(content);
  if (bytes.byteLength <= MAX_TOOL_RESULT_BYTES) {
    return { content, bytes: bytes.byteLength };
  }
  const marker = `\n\n[truncated: result was ${bytes.byteLength} bytes]`;
  const markerBytes = encoder.encode(marker).byteLength;
  let end = Math.max(0, MAX_TOOL_RESULT_BYTES - markerBytes);
  // Step back from any UTF-8 continuation byte (10xxxxxx) so we never split a
  // multi-byte character or introduce U+FFFD replacement bytes.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
    end--;
  }
  const head = decoder.decode(bytes.subarray(0, end));
  return {
    content: `${head}${marker}`,
    bytes: bytes.byteLength,
  };
}

/**
 * Races runner completion against the shared AbortSignal so a runner that
 * ignores `signal` cannot suspend the loop past the wall-time deadline.
 */
async function runWithDeadline(
  runner: ToolRunner,
  call: ToolCall,
  signal: AbortSignal,
): Promise<ToolRunResult> {
  if (signal.aborted) {
    throw new Error("Tool deadline exceeded");
  }
  const runPromise = Promise.resolve().then(() => runner.run(call, signal));
  // Prevent unhandled rejection if the deadline fires first and the runner rejects later.
  runPromise.catch(() => {});

  let onAbort: (() => void) | undefined;
  const deadlinePromise = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("Tool deadline exceeded"));
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([runPromise, deadlinePromise]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * Streams an answer, running tools the model asks for until it stops asking or
 * a cap is reached. Provider-independent and tool-source-independent: the only
 * things it knows are the LlmProvider interface and the ToolRunner list.
 */
export function runToolLoop(
  deps: ToolLoopDeps,
  request: LlmRequest,
): AsyncGenerator<ToolLoopEvent, ToolLoopOutcome, undefined> {
  return runLoopFrom(deps, request, [], "");
}

/**
 * Continues a paused answer. Same loop, entered with prior completed tool
 * exchanges and the results the client produced, so resumption is not a second
 * code path.
 */
export function resumeToolLoop(
  deps: ToolLoopDeps,
  request: LlmRequest,
  priorText: string,
  pendingCalls: readonly ToolCall[],
  results: readonly LlmToolResult[],
  continuation?: ToolLoopContinuation | undefined,
): AsyncGenerator<ToolLoopEvent, ToolLoopOutcome, undefined> {
  const cappedById = new Map<string, LlmToolResult>();
  for (const r of results) {
    const capped = capResult(r.content);
    cappedById.set(r.callId, { callId: r.callId, content: capped.content, isError: r.isError });
  }

  let continuationMessages: LlmMessage[];
  if (continuation) {
    for (const r of continuation.pendingTurn.completedResults) {
      if (!cappedById.has(r.callId)) {
        cappedById.set(r.callId, r);
      }
    }
    const turnResults: LlmToolResult[] = continuation.pendingTurn.asked.map(
      (call) =>
        cappedById.get(call.callId) ?? {
          callId: call.callId,
          content: "The tool did not return a result.",
          isError: true,
        },
    );
    continuationMessages = [
      ...continuation.messages,
      {
        role: "assistant",
        content: continuation.pendingTurn.assistantText,
        toolCalls: [...continuation.pendingTurn.asked],
      },
      { role: "tool_results", results: turnResults },
    ];
  } else {
    continuationMessages = [
      { role: "assistant", content: priorText, toolCalls: [...pendingCalls] },
      {
        role: "tool_results",
        results: pendingCalls.map(
          (call) =>
            cappedById.get(call.callId) ?? {
              callId: call.callId,
              content: "The tool did not return a result.",
              isError: true,
            },
        ),
      },
    ];
  }

  return runLoopFrom(deps, request, continuationMessages, priorText);
}

async function* runLoopFrom(
  deps: ToolLoopDeps,
  request: LlmRequest,
  initialContinuationMessages: readonly LlmMessage[],
  initialText: string,
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

  // Strip any caller-supplied `tools` so disabling tools truly omits `tools`
  // from subsequent provider requests and only offered runner definitions apply.
  const { tools: _ignoredTools, ...baseRequest } = request;
  const continuationMessages: LlmMessage[] = [...initialContinuationMessages];
  const messages: LlmMessage[] = [...request.messages, ...continuationMessages];
  const calls: StoredToolCall[] = [];
  let text = initialText;
  let toolsOffered = definitions.length > 0;
  let budgetNoticeSent = false;
  let leaseLost = false;
  const checkLease = async (): Promise<boolean> => {
    if (leaseLost) return false;
    if (!deps.ensureLease) return true;
    const ok = await deps.ensureLease();
    if (!ok) leaseLost = true;
    return ok;
  };

  for (let iteration = 0; ; iteration++) {
    if (!(await checkLease())) {
      return { text, calls, pending: [], abortedByLease: true };
    }
    const stream = deps.provider.stream({
      ...baseRequest,
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
          if (!(await checkLease())) {
            break;
          }
          assistantText += chunk.text;
          text += chunk.text;
          // Forwarded as it arrives: the visible difference between this and a
          // form is that the answer starts at once, and a tool round must not
          // take that away.
          yield { kind: "text", text: chunk.text };
        } else if (chunk.kind === "tool_call") {
          if (!(await checkLease())) {
            break;
          }
          asked.push(chunk.call);
        } else {
          tokensIn = chunk.tokensIn;
          tokensOut = chunk.tokensOut;
          usageReported = true;
        }
      }
      completed = !leaseLost;
    } finally {
      // Per model call, so three calls bill three times. Recorded in `finally`
      // for the same reason phase 1 records before persisting: tokens the
      // provider reported are owed whether or not the rest of the turn works,
      // even if the resume lease was lost before the stream finished.
      if (usageReported || completed) {
        await deps.onModelUsage(tokensIn, tokensOut, costMicros(deps.model, tokensIn, tokensOut));
      }
    }

    if (leaseLost) {
      return { text, calls, pending: [], abortedByLease: true };
    }

    if (asked.length === 0) {
      return { text, calls, pending: [] };
    }

    // Caps are checked after the model asked, not before: the model is allowed
    // to want a tool, it is just not allowed to get one.
    const overIterations = iteration >= MAX_TOOL_ITERATIONS;
    const overTime = clock() - startedAt >= TOOL_WALL_TIME_MS;
    let overConversation = deps.reserveCalls
      ? false
      : deps.priorCalls + calls.length + asked.length > MAX_TOOL_CALLS_PER_CONVERSATION;

    if (!overIterations && !overTime && !overConversation && deps.reserveCalls) {
      if (!(await checkLease())) {
        return { text, calls, pending: [], abortedByLease: true };
      }
      overConversation = !(await deps.reserveCalls(asked.length));
    }

    if (overIterations || overConversation || overTime) {
      if (budgetNoticeSent) return { text, calls, pending: [] };
      budgetNoticeSent = true;
      toolsOffered = false;
      const budgetAssistant: LlmMessage = {
        role: "assistant",
        content: assistantText,
        toolCalls: asked,
      };
      const budgetResults: LlmMessage = {
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
      };
      continuationMessages.push(budgetAssistant, budgetResults);
      messages.push(budgetAssistant, budgetResults);
      continue;
    }

    const controller = new AbortController();
    const remaining = Math.max(0, TOOL_WALL_TIME_MS - (clock() - startedAt));
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (remaining === 0) {
      controller.abort();
    } else {
      timer = setTimeout(() => controller.abort(), remaining);
    }
    const results: LlmToolResult[] = [];
    const pending: ToolCall[] = [];

    try {
      for (const call of asked) {
        if (!(await checkLease())) {
          return { text, calls, pending: [], abortedByLease: true };
        }
        const runner = byName.get(call.name);
        const timedOutBeforeStart =
          controller.signal.aborted || clock() - startedAt >= TOOL_WALL_TIME_MS;
        if (timedOutBeforeStart) {
          controller.abort();
        }
        yield { kind: "tool", call, state: "running", source: runner?.kind ?? "mcp" };
        const callStarted = clock();
        let outcome: ToolRunResult;
        try {
          if (timedOutBeforeStart) {
            outcome = { content: "The tool did not answer in time.", isError: true };
          } else if (!runner) {
            // The model named a tool nobody offered. A result, not a throw: the
            // answer is still worth finishing.
            outcome = { content: `No tool named ${call.name} is available.`, isError: true };
          } else {
            outcome = await runWithDeadline(runner, call, controller.signal);
          }
        } catch {
          // Nothing from the failure is forwarded: a server's error body can
          // quote the request, and this string reaches a prompt.
          outcome = {
            content: controller.signal.aborted
              ? "The tool did not answer in time."
              : "The tool could not be called.",
            isError: true,
          };
        }
        if (outcome.pause) {
          pending.push(call);
          calls.push({
            callId: call.callId,
            name: call.name,
            kind: runner?.kind ?? "action",
            ok: false,
            pending: true,
            ms: 0,
            input: call.input,
            resultBytes: 0,
            resultPreview: "",
          });
          continue;
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
        if (!(await checkLease())) {
          return { text, calls, pending: [], abortedByLease: true };
        }
        yield {
          kind: "tool",
          call,
          state: "done",
          ok: !outcome.isError,
          source: runner?.kind ?? "mcp",
        };
      }
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }

    if (pending.length > 0) {
      return {
        text,
        calls,
        pending,
        continuation: {
          messages: continuationMessages,
          pendingTurn: {
            assistantText,
            asked,
            completedResults: results,
          },
        },
      };
    }

    const assistantTurn: LlmMessage = {
      role: "assistant",
      content: assistantText,
      toolCalls: asked,
    };
    const resultsTurn: LlmMessage = { role: "tool_results", results };
    continuationMessages.push(assistantTurn, resultsTurn);
    messages.push(assistantTurn, resultsTurn);
  }
}
