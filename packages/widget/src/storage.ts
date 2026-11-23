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
  restartNotice?: boolean;
  tabOnly?: boolean;
  view?: SavedView;
}

const VISITOR_KEY = "solv-chat-visitor";
const OPEN_PREFIX = "solv-chat-open:";
const MAX_SAVED_TURNS = 20;
const REMEMBER_PREFIX = "solv-chat-conversation:";
const MIGRATED_PREFIX = "solv-chat-migrated:";
export const PENDING_RESUME_TTL_MS = 2 * 60 * 1000;
const CONVERSATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface RememberedConversation {
  raw: string;
  conversationId: string | null;
  turns: SavedTurn[];
  activityAt: number;
  restartNotice?: boolean;
  navigationUntil?: number;
  writerTabId?: string;
}

export function rememberedKey(assistant: string): string {
  return REMEMBER_PREFIX + assistant;
}

export function conversationLocks(): LockManager | undefined {
  try {
    return navigator.locks;
  } catch {
    return undefined;
  }
}

/** Undefined means storage is blocked. Null means there is no current transcript. */
export function readRemembered(assistant: string): RememberedConversation | null | undefined {
  try {
    const key = rememberedKey(assistant);
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    let record: Omit<RememberedConversation, "raw"> | undefined;
    try {
      record = JSON.parse(raw);
    } catch {
      // Remove malformed records as well as expired ones.
    }
    if (
      record &&
      typeof record.activityAt === "number" &&
      Number.isFinite(record.activityAt) &&
      Date.now() - record.activityAt < CONVERSATION_TTL_MS &&
      Array.isArray(record.turns)
    ) {
      return { ...record, turns: record.turns.slice(-MAX_SAVED_TURNS), raw };
    }
    localStorage.removeItem(key);
    return null;
  } catch {
    return undefined;
  }
}

function writeRemembered(
  assistant: string,
  saved: SavedConversation,
  activityAt: number,
  writerTabId?: string,
): RememberedConversation | undefined {
  const record = {
    conversationId: saved.conversationId,
    turns: saved.turns.slice(-MAX_SAVED_TURNS),
    activityAt,
    ...(writerTabId ? { writerTabId } : {}),
    ...(saved.restartNotice ? { restartNotice: true } : {}),
    ...(saved.pendingResume
      ? { navigationUntil: saved.pendingResume.createdAt + PENDING_RESUME_TTL_MS }
      : {}),
  };
  try {
    const raw = JSON.stringify(record);
    localStorage.setItem(MIGRATED_PREFIX + assistant, "1");
    localStorage.setItem(rememberedKey(assistant), raw);
    return { ...record, raw };
  } catch {
    return undefined;
  }
}

export function saveRemembered(
  assistant: string,
  saved: SavedConversation,
  activityAt: number,
  owner: symbol,
): RememberedConversation | undefined {
  const active = activeOwners.get(assistant);
  if (active?.owner !== owner) return undefined;
  active.tabId ??= randomId();
  return writeRemembered(assistant, saved, activityAt, active.tabId);
}

export function clearRemembered(assistant: string, owner: symbol): boolean {
  if (activeOwners.get(assistant)?.owner !== owner) return false;
  try {
    localStorage.removeItem(rememberedKey(assistant));
    localStorage.setItem(MIGRATED_PREFIX + assistant, "1");
    return true;
  } catch {
    return false;
  }
}

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
 * the widget sets no cookies.
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
      try {
        const previous = sessionStorage.getItem(VISITOR_KEY);
        if (previous) fallbackVisitorId = previous;
        else sessionStorage.setItem(VISITOR_KEY, fallbackVisitorId);
      } catch {
        // Keep one visitor id in memory when both stores are blocked.
      }
    }
    return fallbackVisitorId;
  }
}

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
    ...(record.restartNotice === true ? { restartNotice: true } : {}),
    ...(record.tabOnly === true ? { tabOnly: true } : {}),
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

export function loadConversation(
  assistant: string,
  owner: symbol,
): {
  saved: SavedConversation | null;
  remembered: RememberedConversation | null | undefined;
} {
  const key = OPEN_PREFIX + assistant;
  let saved: SavedConversation | null = null;
  try {
    const raw = sessionStorage.getItem(key);
    if (raw !== null) saved = parseSavedConversation(JSON.parse(raw));
  } catch {
    // The transcript can still be restored when only tab storage is blocked.
  }

  let remembered = readRemembered(assistant);
  if (!conversationLocks() || saved?.tabOnly) remembered = undefined;
  if (remembered === null && saved && (saved.turns.length > 0 || saved.conversationId)) {
    try {
      // A reset or expiry must not bring back a legacy transcript from a
      // different tab that has been open since before the upgrade.
      if (localStorage.getItem(MIGRATED_PREFIX + assistant) === null) {
        remembered = writeRemembered(assistant, saved, Date.now());
      }
    } catch {
      remembered = undefined;
    }
  }

  const copied = saved && copiedFromOpener(key, saved.tabId);
  if (copied) {
    // Discard the opener's layout, draft and pending action from the copied tab.
    try {
      sessionStorage.removeItem(key);
      sessionStorage.removeItem(dockKey(assistant));
    } catch {
      // The copied state is still ignored.
    }
    saved = null;
  }

  claimConversation(assistant, owner, saved?.tabId);
  if (remembered !== undefined) {
    const pending = saved?.pendingResume;
    const transcript = remembered ?? { conversationId: null, turns: [], restartNotice: false };
    if (saved || remembered) {
      saved = {
        ...saved,
        conversationId: transcript.conversationId,
        turns: transcript.turns,
        restartNotice: transcript.restartNotice === true,
        open: saved?.open ?? false,
      };
      if (
        pending &&
        (transcript.conversationId !== pending.conversationId ||
          !transcript.turns.some(
            (turn) => turn.messageId === pending.resumeMessageId && turn.awaiting?.length,
          ))
      ) {
        delete saved.pendingResume;
      }
      // Strip legacy copies even when the panel is closed. Once reset or
      // expired, another load must not migrate these turns back into storage.
      saveConversation(assistant, saved, owner, true);
    }
  }
  return { saved, remembered };
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
        ...(saved.tabOnly
          ? {
              conversationId: saved.conversationId,
              turns: saved.turns.slice(-MAX_SAVED_TURNS),
              ...(saved.restartNotice ? { restartNotice: true } : {}),
              tabOnly: true,
            }
          : {}),
        open: saved.open,
        ...(saved.expanded ? { expanded: true } : {}),
        ...(saved.preferredMode ? { preferredMode: saved.preferredMode } : {}),
        tabId: active.tabId,
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
