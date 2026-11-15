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

export interface SavedConversation {
  conversationId: string | null;
  open: boolean;
  turns: SavedTurn[];
}

const VISITOR_KEY = "solv-chat-visitor";
const OPEN_PREFIX = "solv-chat-open:";
const MAX_SAVED_TURNS = 20;

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

/**
 * The open conversation, kept per assistant key in sessionStorage.
 *
 * Why sessionStorage: a visitor who follows a link mid-conversation expects to
 * continue, and one returning tomorrow expects a fresh start. sessionStorage
 * draws that line with no expiry logic. Keyed by assistant so two assistants
 * on one site cannot inherit each other's transcript.
 */
export function loadConversation(assistant: string): SavedConversation | null {
  if (!assistant) return null;
  try {
    const raw = sessionStorage.getItem(`${OPEN_PREFIX}${assistant}`);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const conversationId = typeof record.conversationId === "string" ? record.conversationId : null;
    const open = typeof record.open === "boolean" ? record.open : false;
    const turns = Array.isArray(record.turns) ? (record.turns as SavedTurn[]) : [];
    return { conversationId, open, turns };
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
      }),
    );
  } catch {
    // Ignore storage quota or private-mode errors.
  }
}
