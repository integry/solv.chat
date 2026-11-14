import { Errors, fail, ok, type Result } from "../result.js";
import { isPlainObject, parseUrl, readTrimmedString } from "./shared.js";

/**
 * The chat wire protocol version. The widget sends it on every request; the
 * engine refuses a version it does not support with a plain `error` event.
 *
 * Why now: "Page actions" (phase 2) will add request fields and event types. A
 * widget cached on a visitor's machine must keep working when the engine sends
 * an event type it has never heard of, and the engine must be able to say a
 * widget is too old. Adding the field later means a release where neither side
 * can tell. Phase 1 adds the field and the check, nothing else.
 */
export const CHAT_PROTOCOL_VERSION = 1;
export const SUPPORTED_CHAT_PROTOCOLS: readonly number[] = [1];

export interface ChatRequest {
  protocol: number;
  assistant: string;
  visitorId: string;
  message: string;
  conversationId?: string;
  pageUrl?: string;
  /** The admin "Try it" pane asks for the draft. The engine honours it only
   *  for a request authenticated as the owner, so a visitor cannot read an
   *  unpublished draft by sending this field. */
  target?: "published" | "draft";
}

export type ChatEvent =
  | { type: "token"; text: string }
  | { type: "citation"; url: string; title: string }
  // Declared and never emitted in phase 1: there are no tools yet. Reserving
  // the name means adding them is not a protocol change.
  | { type: "tool"; name: string; state: "running" | "done" }
  | { type: "done"; messageId: string; conversationId: string }
  | { type: "error"; message: string };

export type UnknownChatEvent = { type: "unknown"; name: string };

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

  const message = readTrimmedString(value.message, 1, 4000);
  if (message === null) errors.add("message", "must be 1 to 4000 characters");

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

  if (
    errors.failed ||
    protocol === null ||
    assistant === null ||
    visitorId === null ||
    message === null
  ) {
    return fail(...errors.list);
  }

  const result: ChatRequest = { protocol, assistant, visitorId, message };
  if (conversationId !== undefined) result.conversationId = conversationId;
  if (pageUrl !== undefined) result.pageUrl = pageUrl;
  if (target !== undefined) result.target = target;
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
      return typeof payload.name === "string" &&
        (payload.state === "running" || payload.state === "done")
        ? { type: "tool", name: payload.name, state: payload.state }
        : null;
    case "done":
      return typeof payload.messageId === "string" && typeof payload.conversationId === "string"
        ? { type: "done", messageId: payload.messageId, conversationId: payload.conversationId }
        : null;
    case "error":
      return typeof payload.message === "string"
        ? { type: "error", message: payload.message }
        : null;
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
