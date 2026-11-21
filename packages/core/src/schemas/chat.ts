import { Errors, fail, ok, type Result } from "../result.js";
import { isPlainObject, parseUrl, readTrimmedString } from "./shared.js";
import { parseToolCredentials, type ToolCredentials } from "./toolCredentials.js";

/**
 * The chat wire protocol version. The widget sends it on every request; the
 * engine refuses a version it does not support with a plain `error` event.
 *
 * Version 2 adds page actions to the request and `action` events plus tool
 * detail to the stream. Version 1 stays supported: a widget cached on a
 * visitor's machine must keep answering questions after the engine is
 * deployed, and an owner who has not re-pasted the script tag has not agreed
 * to anything breaking.
 */
export const CHAT_PROTOCOL_VERSION = 2;
export const SUPPORTED_CHAT_PROTOCOLS: readonly number[] = [1, 2];
export const MAX_CHAT_MESSAGE_LENGTH = 4000;
export const MAX_CHAT_HISTORY_TURNS = 6;

// Caps on what the page may put in front of the model. The specification sets
// none, so these are chosen: enough for the three built-ins and a handful of
// custom actions, small enough that a hostile page cannot inflate a prompt or
// a stored message. Exported so the engine and widget cannot disagree.
export const MAX_PAGE_ACTIONS = 16;
export const MAX_ACTION_NAME_LENGTH = 64;
export const MAX_ACTION_DESCRIPTION_LENGTH = 200;
/**
 * Maximum serialised size in bytes for a single input schema, shared by page
 * actions and MCP tools so one cap governs every schema shown to the model.
 */
export const MAX_ACTION_SCHEMA_BYTES = 16 * 1024;
export const MAX_ACTION_RESULT_BYTES = 8192;

/** The name pattern actions must match, so a name can never look like prose. */
const ACTION_NAME_RE = /^[a-z][a-z0-9_]*$/;

export interface PageAction {
  name: string;
  description: string;
  /** JSON Schema object, passed to the model as data and never executed. */
  inputSchema: Record<string, unknown>;
  /** The page asked for the visitor's confirmation before this one runs. */
  confirm: boolean;
}

export interface ActionResult {
  callId: string;
  ok: boolean;
  /** Present when ok; already capped at MAX_ACTION_RESULT_BYTES. */
  result?: string;
  /** Present when not ok; a plain sentence, never a stack. */
  error?: string;
}

export interface ChatHistoryTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  protocol: number;
  assistant: string;
  visitorId: string;
  /**
   * Absent only on a request that continues an answer, which carries
   * `actionResults` instead. One endpoint, one parser.
   */
  message?: string;
  conversationId?: string;
  pageUrl?: string;
  /** The admin "Try it" pane asks for the draft. The engine honours it only
   *  for a request authenticated as the owner, so a visitor cannot read an
   *  unpublished draft by sending this field. */
  target?: "published" | "draft";
  /** Prior turns resent by the admin "Try it" pane. Ignored except on an
   *  authenticated owner-preview request. */
  history?: ChatHistoryTurn[];
  /** What this page can do, sent on every request; the model sees them as tools. */
  pageActions?: PageAction[];
  /** Results of the actions the engine asked for, continuing a paused answer. */
  actionResults?: ActionResult[];
  /** The assistant message to continue; required with `actionResults`. */
  resumeMessageId?: string;
  /**
   * The signed visitor session from `POST /v1/session`. Required by an
   * engine that runs the visitor check; absent otherwise.
   */
  session?: string;
  /** Request-only MCP credentials keyed by HTTPS endpoint. */
  toolCredentials?: ToolCredentials;
}

/**
 * Longest session string the engine accepts. Its sessions are about 80
 * characters; the bound keeps a hostile body from making the engine hash
 * kilobytes.
 */
export const MAX_VISITOR_SESSION_LENGTH = 256;

/**
 * Codes an `error` event may carry so the widget can act on a refusal, not
 * only show it. Older widgets ignore the field and show the message.
 *
 * - `check_required`: no valid visitor session; run the check again.
 * - `check_config`: the engine's visitor check is set up wrongly.
 * - `visitor_cap`, `ip_cap`: today's messages for this visitor or network are used up.
 * - `conversation_cap`: this conversation is full; start a new one.
 */
export type ChatErrorCode =
  | "check_required"
  | "check_config"
  | "visitor_cap"
  | "ip_cap"
  | "conversation_cap";

const CHAT_ERROR_CODES: readonly string[] = [
  "check_required",
  "check_config",
  "visitor_cap",
  "ip_cap",
  "conversation_cap",
];

export type ChatEvent =
  | { type: "token"; text: string }
  | { type: "citation"; url: string; title: string }
  // `name` and `state` stay required and first: a v1 widget reads exactly
  // those two and ignores the rest, with no change on its side.
  | {
      type: "tool";
      name: string;
      state: "running" | "done";
      callId?: string;
      kind?: "mcp" | "action";
      ok?: boolean;
    }
  // What the widget must run in the page. The engine never sends a selector or
  // a script: only a registered action name and its validated input.
  | {
      type: "action";
      callId: string;
      name: string;
      input: Record<string, unknown>;
      confirm: boolean;
    }
  | {
      type: "done";
      messageId: string;
      conversationId: string;
      /** Call ids the engine is waiting on: the answer paused, not finished. */
      awaitingActions?: string[];
    }
  | { type: "error"; message: string; code?: ChatErrorCode };

export type UnknownChatEvent = { type: "unknown"; name: string };

const encoder = new TextEncoder();

function parsePageActions(raw: unknown, errors: Errors): PageAction[] {
  if (!Array.isArray(raw)) {
    errors.add("pageActions", "must be an array");
    return [];
  }
  if (raw.length > MAX_PAGE_ACTIONS) {
    errors.add("pageActions", `must have at most ${MAX_PAGE_ACTIONS} items`);
  }
  const out: PageAction[] = [];
  const seen = new Set<string>();
  raw.slice(0, MAX_PAGE_ACTIONS).forEach((item, i) => {
    if (!isPlainObject(item)) {
      errors.add(`pageActions[${i}]`, "must be an object");
      return;
    }
    const name = readTrimmedString(item.name, 1, MAX_ACTION_NAME_LENGTH);
    if (name === null || !ACTION_NAME_RE.test(name)) {
      // A constrained name is what lets the prompt list actions without a
      // page being able to write instructions into the tool list.
      errors.add(`pageActions[${i}].name`, "must be lower-case letters, digits and underscores");
      return;
    }
    const description = readTrimmedString(item.description, 0, MAX_ACTION_DESCRIPTION_LENGTH);
    if (description === null) {
      errors.add(
        `pageActions[${i}].description`,
        `must be at most ${MAX_ACTION_DESCRIPTION_LENGTH} characters`,
      );
      return;
    }
    if (!isPlainObject(item.inputSchema)) {
      errors.add(`pageActions[${i}].inputSchema`, "must be a JSON Schema object");
      return;
    }
    // Bound by serialised size rather than by walking the schema: the schema
    // is handed to the provider as data, so its shape is the provider's
    // business, but its size is ours because it lands in every prompt.
    if (encoder.encode(JSON.stringify(item.inputSchema)).byteLength > MAX_ACTION_SCHEMA_BYTES) {
      errors.add(
        `pageActions[${i}].inputSchema`,
        `must be at most ${MAX_ACTION_SCHEMA_BYTES} bytes`,
      );
      return;
    }
    // First registration of a name wins. Two tools with one name would make
    // the engine guess which the model meant, and guessing is how an action
    // ends up running something the page did not offer.
    if (seen.has(name)) return;
    seen.add(name);
    out.push({
      name,
      description,
      inputSchema: item.inputSchema,
      confirm: item.confirm === true,
    });
  });
  return out;
}

function parseActionResults(raw: unknown, errors: Errors): ActionResult[] {
  if (!Array.isArray(raw)) {
    errors.add("actionResults", "must be an array");
    return [];
  }
  if (raw.length > MAX_PAGE_ACTIONS) {
    errors.add("actionResults", `must have at most ${MAX_PAGE_ACTIONS} items`);
  }
  const out: ActionResult[] = [];
  raw.slice(0, MAX_PAGE_ACTIONS).forEach((item, i) => {
    if (!isPlainObject(item)) {
      errors.add(`actionResults[${i}]`, "must be an object");
      return;
    }
    const callId = readTrimmedString(item.callId, 1, 128);
    if (callId === null) {
      errors.add(`actionResults[${i}].callId`, "must be 1 to 128 characters");
      return;
    }
    const ok = item.ok === true;
    const entry: ActionResult = { callId, ok };
    if (ok) {
      // A string, not arbitrary JSON: the result is read by the model as
      // untrusted data, and a string is the only shape whose size we can cap
      // without walking a structure the page controls.
      if (typeof item.result !== "string") {
        errors.add(`actionResults[${i}].result`, "must be a string");
        return;
      }
      if (encoder.encode(item.result).byteLength > MAX_ACTION_RESULT_BYTES) {
        errors.add(
          `actionResults[${i}].result`,
          `must be at most ${MAX_ACTION_RESULT_BYTES} bytes`,
        );
        return;
      }
      entry.result = item.result;
    } else {
      const error = readTrimmedString(item.error, 0, 500);
      entry.error = error ?? "The page could not complete that action.";
    }
    out.push(entry);
  });
  return out;
}

/** Reads the optional `session` field shared by the chat and feedback bodies. */
export function parseSessionField(raw: unknown, errors: Errors): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.length < 1 || raw.length > MAX_VISITOR_SESSION_LENGTH) {
    errors.add("session", `must be 1 to ${MAX_VISITOR_SESSION_LENGTH} characters`);
    return undefined;
  }
  return raw;
}

/** Validates an incoming public chat request. */
export function parseChatRequest(value: unknown): Result<ChatRequest> {
  if (!isPlainObject(value)) return fail("body: must be a JSON object");

  const errors = new Errors();

  let protocol: number | null = null;
  if (value.protocol === undefined) {
    errors.add("protocol", "is required");
  } else if (typeof value.protocol !== "number" || !Number.isInteger(value.protocol)) {
    errors.add("protocol", "must be an integer");
  } else if (!SUPPORTED_CHAT_PROTOCOLS.includes(value.protocol)) {
    errors.add(
      "protocol",
      `unsupported protocol version ${value.protocol}; supported: ${SUPPORTED_CHAT_PROTOCOLS.join(", ")}`,
    );
  } else {
    protocol = value.protocol;
  }

  const assistant = readTrimmedString(value.assistant, 4, 128);
  if (assistant === null || !assistant.startsWith("pk_") || /\s/.test(assistant)) {
    errors.add("assistant", "must be a public key starting with pk_");
  }

  const visitorId = readTrimmedString(value.visitorId, 1, 128);
  if (visitorId === null) errors.add("visitorId", "must be 1 to 128 characters");

  let actionResults: ActionResult[] | undefined;
  if (value.actionResults !== undefined) {
    actionResults = parseActionResults(value.actionResults, errors);
  }

  // A continuing request carries results instead of a question.
  let message: string | null = null;
  if (value.message !== undefined || actionResults === undefined) {
    message = readTrimmedString(value.message, 1, MAX_CHAT_MESSAGE_LENGTH);
    if (message === null) {
      errors.add("message", `must be 1 to ${MAX_CHAT_MESSAGE_LENGTH} characters`);
    }
  }

  let resumeMessageId: string | undefined;
  if (value.resumeMessageId !== undefined) {
    const parsed = readTrimmedString(value.resumeMessageId, 1, 128);
    if (parsed === null) errors.add("resumeMessageId", "must be 1 to 128 characters");
    else resumeMessageId = parsed;
  }
  if (actionResults !== undefined && resumeMessageId === undefined) {
    // Without it the engine would have to guess which answer to continue, and
    // two requests in one conversation can interleave.
    errors.add("resumeMessageId", "is required with actionResults");
  }

  let pageActions: PageAction[] | undefined;
  if (value.pageActions !== undefined) {
    pageActions = parsePageActions(value.pageActions, errors);
  }

  const session = parseSessionField(value.session, errors);
  const toolCredentials =
    value.toolCredentials === undefined ? undefined : parseToolCredentials(value.toolCredentials);
  if (toolCredentials === null) {
    errors.add(
      "toolCredentials",
      "must contain up to 8 HTTPS endpoints with valid keys of up to 4096 characters",
    );
  }

  let conversationId: string | undefined;
  if (value.conversationId !== undefined) {
    const parsed = readTrimmedString(value.conversationId, 1, 128);
    if (parsed === null) errors.add("conversationId", "must be 1 to 128 characters");
    else conversationId = parsed;
  }

  let pageUrl: string | undefined;
  if (value.pageUrl !== undefined) {
    const parsed = parseUrl(value.pageUrl, ["https:", "http:"]);
    if (parsed === null) errors.add("pageUrl", "must be an absolute http or https URL");
    else pageUrl = parsed.href;
  }

  let target: "published" | "draft" | undefined;
  if (value.target !== undefined) {
    if (value.target !== "published" && value.target !== "draft") {
      errors.add("target", 'must be "published" or "draft"');
    } else {
      target = value.target;
    }
  }

  let history: ChatHistoryTurn[] | undefined;
  if (value.history !== undefined) {
    if (!Array.isArray(value.history)) {
      errors.add("history", "must be an array");
    } else {
      if (value.history.length > MAX_CHAT_HISTORY_TURNS) {
        errors.add("history", `must have at most ${MAX_CHAT_HISTORY_TURNS} items`);
      }
      const turns: ChatHistoryTurn[] = [];
      value.history.slice(0, MAX_CHAT_HISTORY_TURNS).forEach((item, i) => {
        if (!isPlainObject(item)) {
          errors.add(`history[${i}]`, "must be an object");
          return;
        }
        const role = item.role;
        if (role !== "user" && role !== "assistant") {
          errors.add(`history[${i}].role`, 'must be "user" or "assistant"');
        }
        const content = readTrimmedString(item.content, 1, MAX_CHAT_MESSAGE_LENGTH);
        if (content === null) {
          errors.add(`history[${i}].content`, `must be 1 to ${MAX_CHAT_MESSAGE_LENGTH} characters`);
        }
        if ((role === "user" || role === "assistant") && content !== null) {
          turns.push({ role, content });
        }
      });
      history = turns;
    }
  }

  if (errors.failed || protocol === null || assistant === null || visitorId === null) {
    return fail(...errors.list);
  }

  const result: ChatRequest = { protocol, assistant, visitorId };
  if (message !== null) result.message = message;
  if (conversationId !== undefined) result.conversationId = conversationId;
  if (pageUrl !== undefined) result.pageUrl = pageUrl;
  if (target !== undefined) result.target = target;
  if (history !== undefined) result.history = history;
  if (pageActions !== undefined) result.pageActions = pageActions;
  if (actionResults !== undefined) result.actionResults = actionResults;
  if (resumeMessageId !== undefined) result.resumeMessageId = resumeMessageId;
  if (session !== undefined) result.session = session;
  if (toolCredentials) result.toolCredentials = toolCredentials;
  return ok(result);
}

/** Serializes a ChatEvent as SSE `event:` / `data:` lines. */
export function serializeChatEvent(event: ChatEvent): string {
  const { type, ...data } = event;
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function isKnownChatEvent(name: string, payload: Record<string, unknown>): ChatEvent | null {
  switch (name) {
    case "token":
      return typeof payload.text === "string" ? { type: "token", text: payload.text } : null;
    case "citation":
      return typeof payload.url === "string" && typeof payload.title === "string"
        ? { type: "citation", url: payload.url, title: payload.title }
        : null;
    case "tool":
      if (
        typeof payload.name !== "string" ||
        (payload.state !== "running" && payload.state !== "done")
      ) {
        return null;
      }
      return {
        type: "tool",
        name: payload.name,
        state: payload.state,
        ...(typeof payload.callId === "string" ? { callId: payload.callId } : {}),
        ...(payload.kind === "mcp" || payload.kind === "action" ? { kind: payload.kind } : {}),
        ...(typeof payload.ok === "boolean" ? { ok: payload.ok } : {}),
      };
    case "action":
      return typeof payload.callId === "string" &&
        typeof payload.name === "string" &&
        isPlainObject(payload.input)
        ? {
            type: "action",
            callId: payload.callId,
            name: payload.name,
            input: payload.input,
            confirm: payload.confirm === true,
          }
        : null;
    case "done":
      if (typeof payload.messageId !== "string" || typeof payload.conversationId !== "string") {
        return null;
      }
      return {
        type: "done",
        messageId: payload.messageId,
        conversationId: payload.conversationId,
        ...(Array.isArray(payload.awaitingActions)
          ? {
              awaitingActions: payload.awaitingActions.filter(
                (id): id is string => typeof id === "string",
              ),
            }
          : {}),
      };
    case "error":
      if (typeof payload.message !== "string") return null;
      return typeof payload.code === "string" && CHAT_ERROR_CODES.includes(payload.code)
        ? { type: "error", message: payload.message, code: payload.code as ChatErrorCode }
        : { type: "error", message: payload.message };
    default:
      return null;
  }
}

/**
 * An unrecognised name becomes `{ type: "unknown" }` rather than an error: a
 * deployed widget will meet event types from a newer engine, and the only
 * acceptable behaviour is to ignore them and keep rendering the known ones.
 */
export function parseChatEventLine(name: string, data: string): ChatEvent | UnknownChatEvent {
  try {
    const parsed: unknown = JSON.parse(data);
    if (!isPlainObject(parsed)) return { type: "unknown", name };
    return isKnownChatEvent(name, parsed) ?? { type: "unknown", name };
  } catch {
    // Malformed payload on a known name: treat as unknown rather than throw
    // inside the widget's render loop.
    return { type: "unknown", name };
  }
}
