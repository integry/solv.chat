import type { ActionResult, WidgetOpenMode } from "@solvchat/core";
import { type DockRecord, dockKey } from "./dock.js";

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
  createdAt: number;
  navigateCallId?: string;
}

interface SavedView {
  draft: string;
  /** Omitted when pinned to the latest message. */
  scrollTop?: number;
  inputFocused?: boolean;
}

export interface SavedConversation {
  conversationId: string | null;
  open: boolean;
  /**
   * The open panel was expanded. Saved only when true.
   */
  expanded?: boolean;
  preferredMode?: WidgetOpenMode;
  tabId?: string;
  turns: SavedTurn[];
  pendingResume?: PendingResume;
  view?: SavedView;
}

const VISITOR_KEY = "solv-chat-visitor";
const OPEN_PREFIX = "solv-chat-open:";
const MAX_SAVED_TURNS = 20;
export const PENDING_RESUME_TTL_MS = 2 * 60 * 1000;

const CONFIG_PREFIX = "solv-chat-config:";
const CONFIG_MAX_AGE_MS = 2 * 60 * 1000;

export function loadPublicConfig(url: string): { config: unknown; expiresAt: number } | null {
  try {
    const raw = sessionStorage.getItem(CONFIG_PREFIX + url);
    if (raw === null) return null;
    const { config, savedAt } = JSON.parse(raw);
    const now = Date.now();
    if (
      typeof savedAt === "number" &&
      savedAt <= now &&
      now - savedAt < CONFIG_MAX_AGE_MS &&
      config &&
      typeof config === "object" &&
      !Array.isArray(config)
    ) {
      return { config, expiresAt: savedAt + CONFIG_MAX_AGE_MS };
    }
  } catch {
    // Storage may be unavailable, or the entry may be malformed.
  }
  return null;
}

export function savePublicConfig(url: string, config: object): void {
  try {
    sessionStorage.setItem(CONFIG_PREFIX + url, JSON.stringify({ config, savedAt: Date.now() }));
  } catch {
    // A storage failure must never stop the widget opening.
  }
}

let fallbackVisitorId: string | null = null;
const activeOwners = new Map<string, { owner: symbol; tabId: string | undefined }>();

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
    record.depth < 1 ||
    typeof record.createdAt !== "number" ||
    !Number.isFinite(record.createdAt)
  ) {
    return undefined;
  }
  const navigateCallId =
    typeof record.navigateCallId === "string" && record.navigateCallId !== ""
      ? record.navigateCallId
      : undefined;
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
    createdAt: record.createdAt,
    ...(navigateCallId ? { navigateCallId } : {}),
  };
}

function parseSavedConversation(parsed: unknown): SavedConversation | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const conversationId = typeof record.conversationId === "string" ? record.conversationId : null;
  const open = typeof record.open === "boolean" ? record.open : false;
  const expanded = record.expanded === true;
  const turns = Array.isArray(record.turns) ? (record.turns as SavedTurn[]) : [];
  const pendingResume = parsePendingResume(record.pendingResume);
  const view = record.view as Partial<SavedView> | null | undefined;
  return {
    conversationId,
    open,
    ...(expanded ? { expanded } : {}),
    ...(record.preferredMode === "panel" || record.preferredMode === "side"
      ? { preferredMode: record.preferredMode }
      : {}),
    ...(typeof record.tabId === "string" ? { tabId: record.tabId } : {}),
    turns,
    ...(pendingResume ? { pendingResume } : {}),
    ...(view && typeof view.draft === "string"
      ? {
          view: {
            draft: view.draft,
            ...(typeof view.scrollTop === "number" &&
            Number.isFinite(view.scrollTop) &&
            view.scrollTop >= 0
              ? { scrollTop: view.scrollTop }
              : {}),
            ...(view.inputFocused === true ? { inputFocused: true } : {}),
          },
        }
      : {}),
  };
}

function copiedFromOpener(key: string, tabId: string | undefined): boolean {
  const opener = window.opener as Window | null;
  if (!opener) return false;
  try {
    const raw = opener.sessionStorage.getItem(key);
    if (raw === null) return false;
    const saved = parseSavedConversation(JSON.parse(raw));
    return saved !== null && saved.tabId === tabId;
  } catch {
    // A cross-origin or closed opener does not expose its sessionStorage.
    return false;
  }
}

export function loadConversation(assistant: string): SavedConversation | null {
  if (!assistant) return null;
  try {
    const key = `${OPEN_PREFIX}${assistant}`;
    const raw = sessionStorage.getItem(key);
    if (raw === null) return null;
    const saved = parseSavedConversation(JSON.parse(raw));
    // A same-origin popup starts with a copy of its opener's sessionStorage.
    // The id is kept for the lifetime of the conversation, even as turns change.
    if (saved && copiedFromOpener(key, saved.tabId)) {
      // Discard the copy now, since the opener may be gone on the next load.
      sessionStorage.removeItem(key);
      sessionStorage.removeItem(dockKey(assistant));
      return null;
    }
    return saved;
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
export function claimConversation(assistant: string, owner: symbol, tabId?: string): void {
  if (!assistant) return;
  activeOwners.set(assistant, { owner, tabId });
}

/**
 * Saves the open conversation for an assistant when `owner` is still the
 * active instance, capped to the most recent turns so sessionStorage quota
 * is never exhausted by a long session.
 */
export function saveConversation(
  assistant: string,
  saved: SavedConversation,
  owner: symbol,
  existingOnly = false,
): boolean {
  const active = activeOwners.get(assistant);
  if (!assistant || active?.owner !== owner) return false;
  try {
    const key = `${OPEN_PREFIX}${assistant}`;
    if (existingOnly && !sessionStorage.getItem(key)) return false;
    active.tabId ??= randomId();
    sessionStorage.setItem(
      key,
      JSON.stringify({
        conversationId: saved.conversationId,
        open: saved.open,
        ...(saved.expanded ? { expanded: true } : {}),
        ...(saved.preferredMode ? { preferredMode: saved.preferredMode } : {}),
        tabId: active.tabId,
        turns: saved.turns.slice(-MAX_SAVED_TURNS),
        ...(saved.pendingResume ? { pendingResume: saved.pendingResume } : {}),
        ...(saved.view ? { view: saved.view } : {}),
      }),
    );
    return true;
  } catch {
    // Ignore storage quota or private-mode errors.
    return false;
  }
}

export function saveDock(
  assistant: string,
  owner: symbol,
  dock: [DockRecord[0], DockRecord[1], DockRecord[2], DockRecord[3]] | null,
): void {
  const active = activeOwners.get(assistant);
  if (!assistant || active?.owner !== owner) return;
  try {
    const key = dockKey(assistant);
    const previous = sessionStorage.getItem(key);
    if (dock && active.tabId) {
      const next = JSON.stringify([...dock, active.tabId] satisfies DockRecord);
      if (previous !== next) sessionStorage.setItem(key, next);
    } else if (!dock && previous !== null) {
      sessionStorage.removeItem(key);
    }
  } catch {
    // The widget also works without storage.
  }
}
