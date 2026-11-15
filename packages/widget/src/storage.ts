import type { ActionResult } from "@solvchat/core";

export interface SavedCitation {
  url: string;
  title: string;
}

export interface SavedAction {
  name: string;
  ok: boolean;
}

export interface SavedTurn {
  role: "user" | "assistant";
  text: string;
  messageId?: string;
  citations?: SavedCitation[];
  feedback?: "up" | "down";
  error?: string;
  /** Call ids the engine is waiting on; a reload marks the turn interrupted. */
  awaiting?: string[];
  /** Actions that ran during this turn, so the transcript survives a reload. */
  actions?: SavedAction[];
}

export interface PendingResume {
  conversationId: string;
  resumeMessageId: string;
  actionResults: ActionResult[];
  depth: number;
}

export interface SavedConversation {
  conversationId: string | null;
  open: boolean;
  turns: SavedTurn[];
  pendingResume?: PendingResume;
}

const VISITOR_KEY = "solv-chat-visitor";
const OPEN_PREFIX = "solv-chat-open:";
const HANDOFF_HASH_PARAM = "solv_handoff=";
const MAX_SAVED_TURNS = 20;
const MAX_HANDOFF_BYTES = 16_384;

let fallbackVisitorId: string | null = null;
const activeOwners = new Map<string, symbol>();

/**
 * A random id that works on plain-http pages too. `crypto.randomUUID` exists
 * only in secure contexts, and an owner may list an `http:` origin; there the
 * id comes from `crypto.getRandomValues`, which every context exposes.
 */
function randomId(): string {
  if (typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {
      // Fall through to getRandomValues.
    }
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * A random id in localStorage, not a cookie. The specification is explicit:
 * the widget sets no cookies, so there is nothing to consent to and nothing
 * sent to a third party.
 */
export function visitorId(): string {
  try {
    let id = localStorage.getItem(VISITOR_KEY);
    if (id === null) {
      id = randomId();
      localStorage.setItem(VISITOR_KEY, id);
    }
    return id;
  } catch {
    if (fallbackVisitorId === null) {
      fallbackVisitorId = randomId();
    }
    return fallbackVisitorId;
  }
}

function adoptVisitorId(id: string): void {
  fallbackVisitorId = id;
  try {
    localStorage.setItem(VISITOR_KEY, id);
  } catch {
    // Ignore storage quota or private-mode errors.
  }
}

/**
 * The open conversation, kept per assistant key in sessionStorage.
 *
 * Why sessionStorage: a visitor who follows a link mid-conversation expects to
 * continue, and one returning tomorrow expects a fresh start. sessionStorage
 * draws that line with no expiry logic. Keyed by assistant so two assistants
 * on one site cannot inherit each other's transcript.
 */
function parsePendingResume(raw: unknown): PendingResume | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (
    typeof record.conversationId !== "string" ||
    record.conversationId === "" ||
    typeof record.resumeMessageId !== "string" ||
    record.resumeMessageId === "" ||
    !Array.isArray(record.actionResults) ||
    typeof record.depth !== "number" ||
    !Number.isInteger(record.depth) ||
    record.depth < 1
  ) {
    return undefined;
  }
  const actionResults: ActionResult[] = [];
  for (const item of record.actionResults) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
    const entry = item as Record<string, unknown>;
    if (typeof entry.callId !== "string" || entry.callId === "" || typeof entry.ok !== "boolean") {
      return undefined;
    }
    if (entry.ok) {
      if (typeof entry.result !== "string") return undefined;
      actionResults.push({ callId: entry.callId, ok: true, result: entry.result });
    } else {
      if (typeof entry.error !== "string") return undefined;
      actionResults.push({ callId: entry.callId, ok: false, error: entry.error });
    }
  }
  return {
    conversationId: record.conversationId,
    resumeMessageId: record.resumeMessageId,
    actionResults,
    depth: record.depth,
  };
}

function parseSavedConversation(parsed: unknown): SavedConversation | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const conversationId = typeof record.conversationId === "string" ? record.conversationId : null;
  const open = typeof record.open === "boolean" ? record.open : false;
  const turns = Array.isArray(record.turns) ? (record.turns as SavedTurn[]) : [];
  const pendingResume = parsePendingResume(record.pendingResume);
  return {
    conversationId,
    open,
    turns,
    ...(pendingResume ? { pendingResume } : {}),
  };
}

export function loadConversation(assistant: string): SavedConversation | null {
  if (!assistant) return null;
  try {
    const raw = sessionStorage.getItem(`${OPEN_PREFIX}${assistant}`);
    if (raw === null) return null;
    return parseSavedConversation(JSON.parse(raw));
  } catch {
    // Private-mode quota errors and malformed data both mean "no saved
    // conversation". A storage failure must never stop the widget opening.
    return null;
  }
}

/**
 * Marks `owner` as the active widget instance for `assistant`, fencing out any
 * superseded instance that still has an in-flight stream or request.
 */
export function claimConversation(assistant: string, owner: symbol): void {
  if (!assistant) return;
  activeOwners.set(assistant, owner);
}

/**
 * Saves the open conversation for an assistant when `owner` is still the
 * active instance, capped to the most recent turns so sessionStorage quota
 * is never exhausted by a long session.
 */
export function saveConversation(assistant: string, saved: SavedConversation, owner: symbol): void {
  if (!assistant || activeOwners.get(assistant) !== owner) return;
  try {
    sessionStorage.setItem(
      `${OPEN_PREFIX}${assistant}`,
      JSON.stringify({
        conversationId: saved.conversationId,
        open: saved.open,
        turns: saved.turns.slice(-MAX_SAVED_TURNS),
        ...(saved.pendingResume ? { pendingResume: saved.pendingResume } : {}),
      }),
    );
  } catch {
    // Ignore storage quota or private-mode errors.
  }
}

interface CrossOriginHandoff {
  assistant: string;
  targetOrigin: string;
  visitorId: string;
  saved: SavedConversation;
}

const handoffEncoder = new TextEncoder();
const handoffDecoder = new TextDecoder();

function encodeHandoffPayload(json: string): string {
  const bytes = handoffEncoder.encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeHandoffPayload(encoded: string): string | null {
  if (!encoded) return null;
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const pad = base64.length % 4 === 0 ? "" : "=".repeat(4 - (base64.length % 4));
    const binary = atob(base64 + pad);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return handoffDecoder.decode(bytes);
  } catch {
    return null;
  }
}

function parseHandoff(encoded: string): CrossOriginHandoff | null {
  const raw = decodeHandoffPayload(encoded);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.assistant !== "string" ||
      record.assistant === "" ||
      typeof record.targetOrigin !== "string" ||
      record.targetOrigin === "" ||
      typeof record.visitorId !== "string"
    ) {
      return null;
    }
    const saved = parseSavedConversation(record.saved);
    if (!saved) return null;
    return {
      assistant: record.assistant,
      targetOrigin: record.targetOrigin,
      visitorId: record.visitorId,
      saved,
    };
  } catch {
    return null;
  }
}

function extractHandoffFromHash(hash: string): { encoded: string; cleanedHash: string } | null {
  if (!hash.startsWith("#")) return null;
  if (hash.startsWith(`#${HANDOFF_HASH_PARAM}`)) {
    const start = 1 + HANDOFF_HASH_PARAM.length;
    const amp = hash.indexOf("&", start);
    if (amp === -1) {
      return { encoded: hash.slice(start), cleanedHash: "" };
    }
    return { encoded: hash.slice(start, amp), cleanedHash: `#${hash.slice(amp + 1)}` };
  }
  const idx = hash.indexOf(`&${HANDOFF_HASH_PARAM}`);
  if (idx === -1) return null;
  const before = hash.slice(0, idx);
  const start = idx + 1 + HANDOFF_HASH_PARAM.length;
  const amp = hash.indexOf("&", start);
  if (amp === -1) {
    return { encoded: hash.slice(start), cleanedHash: before };
  }
  return { encoded: hash.slice(start, amp), cleanedHash: `${before}${hash.slice(amp)}` };
}

function replaceLocationHash(cleanedHash: string): void {
  try {
    if (typeof history !== "undefined" && typeof history.replaceState === "function") {
      history.replaceState(null, "", `${location.pathname}${location.search}${cleanedHash}`);
    }
  } catch {
    // Ignore history API errors in restricted contexts.
  }
}

/**
 * Encodes the conversation into the destination URL's hash fragment so a
 * real cross-site navigation can restore and resume it where storage and
 * `window.name` are cleared or partitioned by the browser.
 */
export function stageCrossOriginHandoff(
  assistant: string,
  targetHref: string,
  saved: SavedConversation,
): string {
  if (!assistant || !targetHref) return targetHref;
  try {
    const base = typeof location !== "undefined" ? location.href : undefined;
    const url = new URL(targetHref, base);
    let turns = saved.turns.slice(-MAX_SAVED_TURNS);
    const buildJson = (candidateTurns: SavedTurn[]): string => {
      const payload: CrossOriginHandoff = {
        assistant,
        targetOrigin: url.origin,
        visitorId: visitorId(),
        saved: {
          conversationId: saved.conversationId,
          open: saved.open,
          turns: candidateTurns,
          ...(saved.pendingResume ? { pendingResume: saved.pendingResume } : {}),
        },
      };
      return JSON.stringify(payload);
    };
    let json = buildJson(turns);
    while (turns.length > 0 && handoffEncoder.encode(json).byteLength > MAX_HANDOFF_BYTES) {
      turns = turns.slice(1);
      json = buildJson(turns);
    }
    const encoded = encodeHandoffPayload(json);
    const existingHash = url.hash;
    url.hash =
      existingHash === "" || existingHash === "#"
        ? `#${HANDOFF_HASH_PARAM}${encoded}`
        : `${existingHash}&${HANDOFF_HASH_PARAM}${encoded}`;
    return url.href;
  } catch {
    return targetHref;
  }
}

/**
 * Consumes a staged cross-origin handoff from the destination URL's hash
 * fragment for `assistant` on `location.origin`, cleaning the URL and adopting
 * the visitor id so the conversation continues.
 */
export function consumeCrossOriginHandoff(assistant: string): SavedConversation | null {
  if (!assistant || typeof location === "undefined") return null;
  try {
    const extracted = extractHandoffFromHash(location.hash);
    if (!extracted) return null;
    const handoff = parseHandoff(extracted.encoded);
    if (!handoff) {
      replaceLocationHash(extracted.cleanedHash);
      return null;
    }
    if (handoff.assistant !== assistant || handoff.targetOrigin !== location.origin) {
      return null;
    }
    replaceLocationHash(extracted.cleanedHash);
    if (extracted.cleanedHash.length > 1 && typeof document !== "undefined") {
      const rawId = extracted.cleanedHash.slice(1);
      let decodedId = rawId;
      try {
        decodedId = decodeURIComponent(rawId);
      } catch {
        // Keep raw fragment id when malformed.
      }
      const target =
        document.getElementById(decodedId) ??
        (decodedId !== rawId ? document.getElementById(rawId) : null);
      if (target && typeof target.scrollIntoView === "function") {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
    if (handoff.visitorId) {
      adoptVisitorId(handoff.visitorId);
    }
    return handoff.saved;
  } catch {
    return null;
  }
}
