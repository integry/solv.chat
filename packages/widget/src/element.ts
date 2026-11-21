import {
  type ActionResult,
  CHAT_PROTOCOL_VERSION,
  MAX_CHAT_MESSAGE_LENGTH,
  parseChatEventLine,
} from "@solvchat/core";
import {
  listForRequest,
  NAVIGATION_NOT_ALLOWED_ERROR,
  type RegisteredAction,
  type RunRequest,
  runAction,
  serialiseResult,
} from "./actions.js";
import {
  type BuiltinSettings,
  clearHighlight,
  installBuiltins,
  setBeforeNavigate,
  setHighlightHost,
  setOnExternalNavigate,
} from "./builtins.js";
import { CheckController } from "./check.js";
import { askToConfirm, type ConfirmHandle } from "./confirm.js";
import { parseSafeHttpUrl, renderMarkdown } from "./markdown.js";
import { readEventLines } from "./sse.js";
import {
  claimConversation,
  loadConversation,
  PENDING_RESUME_TTL_MS,
  type PendingResume,
  type SavedConversation,
  type SavedTurn,
  saveConversation,
  visitorId,
} from "./storage.js";
import { HOLD_BOUND_MS, streamingView } from "./streaming.js";
import {
  PANEL_WIDTH_PROPERTY,
  SIDE_BY_SIDE_MIN_WIDTH_PX,
  SIDE_PANEL_WIDTH_PX,
  styles,
} from "./styles.js";

interface WidgetPublicConfig {
  title: string;
  accentColor: string;
  position: "left" | "right";
  greeting: string;
  suggestedQuestions: string[];
  actions: BuiltinSettings;
  /** The engine runs the visitor check: every request needs a session. */
  visitorCheck: boolean;
  /** "Allow expanding to a side panel": the header shows the expand control. */
  allowExpand: boolean;
}

/**
 * How the open panel is laid out: the floating panel, a column beside the
 * page (the page is narrowed to make room), or the whole screen on a viewport
 * too narrow for side by side.
 */
type Layout = "panel" | "side" | "full";

/** What the widget added to the host's root element, and what was there before. */
interface RootReservation {
  root: HTMLElement;
  property: string;
  value: string;
  priority: string;
  variableValue: string;
  variablePriority: string;
  /** The root's style attribute before, and its parsed form, to put back byte for byte. */
  styleAttribute: string | null;
  cssText: string;
}

/** The answer text being painted while it streams in. */
interface LivePaint {
  textEl: HTMLDivElement;
  turn: SavedTurn;
  frame: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Where the held-back text started, and when it was first held there. */
  heldFrom: number;
  heldSince: number;
}

const TYPING_LABEL = "Writing an answer";

/** A 24-unit square icon for a header button, built from DOM nodes. */
function headerIcon(path: string): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const shape = document.createElementNS(ns, "path");
  shape.setAttribute("d", path);
  shape.setAttribute("fill", "currentColor");
  svg.append(shape);
  return svg;
}

function requestFrame(callback: () => void): number {
  if (typeof requestAnimationFrame === "function") return requestAnimationFrame(callback);
  return setTimeout(callback, 16) as unknown as number;
}

function cancelFrame(handle: number): void {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
  clearTimeout(handle);
}

const DEFAULT_CONFIG: WidgetPublicConfig = {
  title: "Ask a question",
  accentColor: "#2563eb",
  position: "right",
  greeting: "Hello. Ask me anything about this site.",
  suggestedQuestions: [],
  actions: { enabled: false, allowedOrigins: [] },
  visitorCheck: false,
  allowExpand: true,
};

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const DROPPED_RESUME_TIMEOUT_MS = 5_000;

const ACTION_WORDING: Record<string, string> = {
  navigate: "Taking you to another page on this site.",
  highlight: "Pointing at something on this page.",
  fill: "Filling in the form for you.",
};

function buildMovedOnResults(pending: PendingResume): ActionResult[] {
  return pending.actionResults.map((entry) =>
    pending.navigateCallId
      ? entry.callId === pending.navigateCallId
        ? { callId: entry.callId, ok: false as const, error: "the visitor moved on" }
        : entry
      : entry.ok
        ? { callId: entry.callId, ok: false as const, error: "the visitor moved on" }
        : entry,
  );
}

const SCRIPT_ORIGIN = (() => {
  const current = typeof document !== "undefined" ? document.currentScript : null;
  if (current instanceof HTMLScriptElement && current.src) {
    try {
      return new URL(current.src).origin;
    } catch {
      // Fall back to page origin if script src cannot be parsed.
    }
  }
  return typeof location !== "undefined" ? location.origin : "";
})();

export function parsePublicConfig(raw: unknown): Partial<WidgetPublicConfig> {
  if (typeof raw !== "object" || raw === null) return {};
  const data = raw as Record<string, unknown>;
  const widget =
    typeof data.widget === "object" && data.widget !== null
      ? (data.widget as Record<string, unknown>)
      : data;
  const behaviour =
    typeof data.behaviour === "object" && data.behaviour !== null
      ? (data.behaviour as Record<string, unknown>)
      : data;

  const out: Partial<WidgetPublicConfig> = {};
  if (typeof widget.title === "string" && widget.title.trim()) {
    out.title = widget.title.trim();
  }
  if (typeof widget.accentColor === "string" && HEX_COLOR_RE.test(widget.accentColor.trim())) {
    out.accentColor = widget.accentColor.trim();
  }
  if (widget.position === "left" || widget.position === "right") {
    out.position = widget.position;
  }
  // Absent from an older engine's response: the default (on) stays.
  if (typeof widget.allowExpand === "boolean") {
    out.allowExpand = widget.allowExpand;
  }
  if (typeof behaviour.greeting === "string" && behaviour.greeting.trim()) {
    out.greeting = behaviour.greeting.trim();
  }
  if (Array.isArray(behaviour.suggestedQuestions)) {
    out.suggestedQuestions = behaviour.suggestedQuestions.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0,
    );
  }
  // Page actions, read defensively: an older engine sends nothing and the
  // built-ins must then stay off.
  const actions =
    typeof data.actions === "object" && data.actions !== null
      ? (data.actions as Record<string, unknown>)
      : {};
  out.visitorCheck = data.visitorCheck === true;
  out.actions = {
    enabled: actions.builtins === true,
    allowedOrigins: Array.isArray(actions.allowedOrigins)
      ? actions.allowedOrigins.filter((item): item is string => typeof item === "string")
      : [],
  };
  return out;
}

/**
 * The `<solv-chat>` custom element. Renders a Shadow DOM chat launcher and
 * dialog panel with streaming SSE responses, citations, feedback, and
 * sessionStorage conversation restore.
 */
export class SolvChat extends HTMLElement {
  #root = this.attachShadow({ mode: "open" });
  #owner = Symbol();
  #initialized = false;
  #open = false;
  #sending = false;
  #abortController: AbortController | null = null;
  /** Open confirmation prompts, refused if the panel closes or we unmount. */
  #openConfirms = new Set<ConfirmHandle>();
  /** Turn controller whose remaining confirmations were dismissed by closing the panel. */
  #dismissedTurn: AbortController | null = null;
  #conversationId: string | null = null;
  #turns: SavedTurn[] = [];
  #pendingResume: PendingResume | null = null;
  #resumedBubble: { bubble: HTMLDivElement; textEl: HTMLDivElement; turn: SavedTurn } | null = null;
  #config: WidgetPublicConfig = { ...DEFAULT_CONFIG };
  /** Set by `preview()`: the element then loads and sends nothing. */
  #previewing = false;
  /** The visitor has focused or typed in the input, or picked a suggestion. */
  #interacted = false;
  /** Set while the widget itself moves focus to the input, which is not the visitor's doing. */
  #focusingInput = false;
  #check!: CheckController;
  /** The visitor chose the side panel; remembered with the open conversation. */
  #expanded = false;
  #reservation: RootReservation | null = null;
  #wideQuery: MediaQueryList | null = null;
  #onWideChange = (): void => this.#applyLayout();
  /** The visitor has not scrolled up from the newest message. */
  #pinned = true;
  #paints = new Map<HTMLDivElement, LivePaint>();
  /** Bubbles whose typing indicator has been announced once already. */
  #announced = new WeakSet<HTMLDivElement>();

  #launcher!: HTMLButtonElement;
  #expandBtn!: HTMLButtonElement;
  #collapseBtn!: HTMLButtonElement;
  #panel!: HTMLDivElement;
  #titleEl!: HTMLHeadingElement;
  #messagesEl!: HTMLDivElement;
  #greetingEl!: HTMLDivElement;
  #suggestionsEl!: HTMLDivElement;
  #inputErrorEl!: HTMLDivElement;
  #inputEl!: HTMLTextAreaElement;
  #sendBtn!: HTMLButtonElement;

  connectedCallback(): void {
    if (!this.#initialized) {
      this.#root.adoptedStyleSheets = [styles];
      this.#renderShell();
      this.#initialized = true;
    }
    setHighlightHost(this.#root);

    let expiredPending: PendingResume | null = null;
    const assistant = this.#assistant();
    if (assistant) {
      claimConversation(assistant, this.#owner);
      const saved = loadConversation(assistant);
      if (saved?.pendingResume) {
        if (Date.now() - saved.pendingResume.createdAt > PENDING_RESUME_TTL_MS) {
          expiredPending = saved.pendingResume;
          delete saved.pendingResume;
        }
      }
      this.#restore(saved ?? { conversationId: null, open: false, turns: [] });
    } else {
      this.#applyLayout();
    }

    if (expiredPending) {
      this.#persist();
      void this.#reportDroppedResume(expiredPending);
    }

    if (this.#pendingResume && this.#resumedBubble) {
      const pending = this.#pendingResume;
      const target = this.#resumedBubble;
      // Consume immediately so a second connect cannot resume the same continuation.
      this.#pendingResume = null;
      this.#resumedBubble = null;
      this.#persist();
      void this.#resumeAfterConfigLoad(pending, target);
    } else {
      void this.#loadConfig();
    }
  }

  disconnectedCallback(): void {
    // A pending promise here would hang the answer; every one of these paths
    // means the visitor did not say yes.
    for (const handle of this.#openConfirms) handle.dismiss();
    this.#openConfirms.clear();
    this.#dismissedTurn = null;
    this.#check?.destroy();
    clearHighlight();
    setBeforeNavigate(null);
    setOnExternalNavigate(null);
    this.#pendingResume = null;
    this.#resumedBubble = null;
    // The page gets back exactly what it had; the choice itself stays saved,
    // so the panel opens expanded again on the next page.
    this.#releaseRoom();
    this.#watchViewport(false);
    for (const textEl of [...this.#paints.keys()]) this.#finishPaint(textEl);
    if (this.#abortController) {
      this.#abortController.abort();
      this.#abortController = null;
      this.#sending = false;
      if (this.#sendBtn) {
        this.#sendBtn.disabled = false;
      }
    }
  }

  #assistant(): string {
    return (this.getAttribute("assistant") ?? "").trim();
  }

  #endpoint(): string {
    const attr = this.getAttribute("endpoint")?.trim();
    if (attr) {
      try {
        return new URL(attr, location.href).origin;
      } catch {
        return attr.replace(/\/+$/, "");
      }
    }
    return SCRIPT_ORIGIN;
  }

  #renderShell(): void {
    const wrap = document.createElement("div");
    wrap.className = "solv-wrap";

    const panel = document.createElement("div");
    panel.className = "solv-panel";
    panel.id = "solv-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-labelledby", "solv-title");
    panel.hidden = true;
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.#open) {
        event.preventDefault();
        this.#closePanel(true);
      }
    });

    const header = document.createElement("div");
    header.className = "solv-header";

    const title = document.createElement("h2");
    title.className = "solv-title";
    title.id = "solv-title";
    title.textContent = this.#config.title;

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "solv-close";
    closeBtn.setAttribute("aria-label", "Close chat");
    closeBtn.textContent = "\u00d7";
    closeBtn.addEventListener("click", () => this.#closePanel(true));

    const expandBtn = document.createElement("button");
    expandBtn.type = "button";
    expandBtn.className = "solv-expand";
    expandBtn.setAttribute("aria-label", "Expand to a side panel");
    expandBtn.setAttribute("aria-controls", "solv-panel");
    expandBtn.setAttribute("aria-expanded", "false");
    expandBtn.title = "Expand";
    expandBtn.append(
      headerIcon("M4 4h6v2H6v4H4V4zm10 0h6v6h-2V6h-4V4zM4 14h2v4h4v2H4v-6zm14 4v-4h2v6h-6v-2h4z"),
    );
    expandBtn.addEventListener("click", () => this.#setExpanded(true));

    const collapseBtn = document.createElement("button");
    collapseBtn.type = "button";
    collapseBtn.className = "solv-collapse";
    collapseBtn.setAttribute("aria-label", "Collapse to a small window");
    collapseBtn.setAttribute("aria-controls", "solv-panel");
    collapseBtn.setAttribute("aria-expanded", "true");
    collapseBtn.title = "Collapse";
    collapseBtn.hidden = true;
    collapseBtn.append(
      headerIcon("M8 4h2v6H4V8h4V4zm6 0h2v4h4v2h-6V4zM4 14h6v6H8v-4H4v-2zm10 0h6v2h-4v4h-2v-6z"),
    );
    collapseBtn.addEventListener("click", () => this.#setExpanded(false));

    const headerActions = document.createElement("div");
    headerActions.className = "solv-header-actions";
    headerActions.append(expandBtn, collapseBtn, closeBtn);

    header.append(title, headerActions);

    const messages = document.createElement("div");
    messages.className = "solv-messages";
    messages.setAttribute("role", "log");
    messages.setAttribute("aria-live", "polite");
    messages.setAttribute("aria-relevant", "additions text");
    // Kept at the newest message only while the visitor has not scrolled up.
    messages.addEventListener("scroll", () => {
      this.#pinned = messages.scrollHeight - messages.scrollTop - messages.clientHeight <= 32;
    });

    const greeting = document.createElement("div");
    greeting.className = "solv-bubble solv-bubble--assistant";
    greeting.textContent = this.#config.greeting;
    messages.append(greeting);

    const suggestions = document.createElement("div");
    suggestions.className = "solv-suggestions";
    suggestions.hidden = true;

    const inputError = document.createElement("div");
    inputError.className = "solv-input-error";
    inputError.id = "solv-input-error";
    inputError.setAttribute("role", "alert");
    inputError.hidden = true;

    const form = document.createElement("form");
    form.className = "solv-form";

    const label = document.createElement("label");
    label.className = "sr-only";
    label.htmlFor = "solv-input";
    label.textContent = "Message";

    const input = document.createElement("textarea");
    input.className = "solv-input";
    input.id = "solv-input";
    input.rows = 1;
    input.placeholder = "Ask a question...";
    input.setAttribute("aria-describedby", "solv-input-error");
    // The visitor check starts here and nowhere earlier: not on page load,
    // not when the panel opens (which moves focus here by itself).
    input.addEventListener("focus", () => {
      if (!this.#focusingInput) this.#visitorInteracted();
    });
    input.addEventListener("keydown", () => this.#visitorInteracted());
    input.addEventListener("input", () => {
      if (this.#inputEl.value.trim().length <= MAX_CHAT_MESSAGE_LENGTH) {
        this.#clearInputError();
      }
    });
    let composing = false;
    input.addEventListener("compositionstart", () => {
      composing = true;
    });
    input.addEventListener("compositionend", () => {
      composing = false;
    });
    input.addEventListener("keydown", (event) => {
      if (composing || event.isComposing || event.keyCode === 229) {
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        form.requestSubmit();
      }
    });

    const sendBtn = document.createElement("button");
    sendBtn.type = "submit";
    sendBtn.className = "solv-send";
    sendBtn.textContent = "Send";

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.#send(this.#inputEl.value, () => {
        this.#inputEl.value = "";
      });
    });

    form.append(label, input, sendBtn);

    // Always in the panel and collapsed, so creating the frame inside it
    // moves nothing; it opens only when Turnstile asks the visitor to act.
    const checkHost = document.createElement("div");
    checkHost.className = "solv-check";
    this.#check = new CheckController({
      host: checkHost,
      endpoint: () => this.#endpoint(),
      assistant: () => this.#assistant(),
      visitorId: () => visitorId(),
      theme: () =>
        typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light",
    });

    panel.append(header, messages, suggestions, inputError, checkHost, form);

    const launcher = document.createElement("button");
    launcher.type = "button";
    launcher.className = "solv-launcher";
    launcher.setAttribute("aria-expanded", "false");
    launcher.setAttribute("aria-controls", "solv-panel");
    launcher.setAttribute("aria-label", "Open chat");
    launcher.textContent = "Chat";
    launcher.addEventListener("click", () => {
      if (this.#open) {
        this.#closePanel(true);
      } else {
        this.#openPanel(true);
      }
    });

    wrap.append(panel, launcher);
    this.#root.append(wrap);

    this.#panel = panel;
    this.#titleEl = title;
    this.#messagesEl = messages;
    this.#greetingEl = greeting;
    this.#suggestionsEl = suggestions;
    this.#inputErrorEl = inputError;
    this.#inputEl = input;
    this.#sendBtn = sendBtn;
    this.#launcher = launcher;
    this.#expandBtn = expandBtn;
    this.#collapseBtn = collapseBtn;
  }

  /**
   * Shows `config` (the shape `GET /v1/assistants/:publicKey` returns) with
   * the panel open, for the admin's live preview. From then on the element
   * makes no requests: config is not fetched, messages are not sent, and
   * page actions stay off. Call it again to update what is shown.
   */
  preview(config: unknown): void {
    this.#previewing = true;
    this.#config = {
      ...DEFAULT_CONFIG,
      ...parsePublicConfig(config),
      actions: { enabled: false, allowedOrigins: [] },
    };
    this.#applyConfig();
    if (!this.#open) this.#openPanel(false);
  }

  async #loadConfig(): Promise<void> {
    const assistant = this.#assistant();
    if (!assistant || this.#previewing) return;
    try {
      const response = await fetch(
        `${this.#endpoint()}/v1/assistants/${encodeURIComponent(assistant)}`,
      );
      if (!response.ok) return;
      const parsed = parsePublicConfig(await response.json());
      this.#config = { ...this.#config, ...parsed };
      this.#applyConfig();
    } catch {
      // Keep default config if the config endpoint is unreachable.
    }
  }

  #applyConfig(): void {
    this.#titleEl.textContent = this.#config.title;
    this.#greetingEl.textContent = this.#config.greeting;
    this.style.setProperty("--solv-accent", this.#config.accentColor);
    if (this.#config.position === "left") {
      this.setAttribute("data-position", "left");
    } else {
      this.removeAttribute("data-position");
    }
    this.#applyLayout();
    // Registered after the config says so, and removed if it says not to.
    installBuiltins(this.#config.actions);
    this.#renderSuggestions();
    // The visitor got to the input before the config arrived.
    if (this.#interacted) this.#visitorInteracted();
  }

  #checkRequired(): boolean {
    return this.#config.visitorCheck && !this.#previewing;
  }

  #visitorInteracted(): void {
    this.#interacted = true;
    if (this.#checkRequired() && this.#assistant()) this.#check.start();
  }

  #focusInput(): void {
    this.#focusingInput = true;
    try {
      this.#inputEl.focus();
    } finally {
      this.#focusingInput = false;
    }
  }

  #renderSuggestions(): void {
    this.#suggestionsEl.replaceChildren();
    if (this.#turns.length > 0 || this.#config.suggestedQuestions.length === 0) {
      this.#suggestionsEl.hidden = true;
      return;
    }
    for (const question of this.#config.suggestedQuestions) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "solv-chip";
      chip.textContent = question;
      chip.addEventListener("click", () => {
        if (!this.#sending) {
          this.#visitorInteracted();
          void this.#send(question);
        }
      });
      this.#suggestionsEl.append(chip);
    }
    this.#suggestionsEl.hidden = false;
  }

  #openPanel(moveFocus: boolean): void {
    this.#dismissedTurn = null;
    this.#open = true;
    this.#panel.hidden = false;
    this.#launcher.setAttribute("aria-expanded", "true");
    this.#launcher.setAttribute("aria-label", "Close chat");
    this.#applyLayout();
    this.#persist();
    if (moveFocus) {
      this.#focusInput();
    }
  }

  #closePanel(restoreFocus: boolean): void {
    for (const handle of this.#openConfirms) handle.dismiss();
    this.#openConfirms.clear();
    this.#dismissedTurn = this.#abortController;
    this.#open = false;
    this.#panel.hidden = true;
    this.#launcher.setAttribute("aria-expanded", "false");
    this.#launcher.setAttribute("aria-label", "Open chat");
    this.#applyLayout();
    this.#persist();
    if (restoreFocus) {
      this.#launcher.focus();
    }
  }

  /** Expands to the side panel or collapses back, keeping focus in the panel. */
  #setExpanded(expanded: boolean): void {
    if (!this.#config.allowExpand || !this.#open || this.#expanded === expanded) return;
    this.#expanded = expanded;
    this.#applyLayout();
    this.#persist();
    // The control pressed is now hidden; its counterpart sits in the same place.
    (expanded ? this.#collapseBtn : this.#expandBtn).focus();
  }

  #isWide(): boolean {
    return (
      typeof matchMedia === "function" &&
      matchMedia(`(min-width: ${SIDE_BY_SIDE_MIN_WIDTH_PX}px)`).matches
    );
  }

  #watchViewport(on: boolean): void {
    if (on && this.#wideQuery === null && typeof matchMedia === "function") {
      this.#wideQuery = matchMedia(`(min-width: ${SIDE_BY_SIDE_MIN_WIDTH_PX}px)`);
      this.#wideQuery.addEventListener?.("change", this.#onWideChange);
    } else if (!on && this.#wideQuery !== null) {
      this.#wideQuery.removeEventListener?.("change", this.#onWideChange);
      this.#wideQuery = null;
    }
  }

  /** Puts the panel, the launcher, the header controls and the page in line with the state. */
  #applyLayout(): void {
    if (!this.#initialized) return;
    const allow = this.#config.allowExpand;
    const wanted = this.#open && this.#expanded && allow;
    const layout: Layout = wanted ? (this.#isWide() ? "side" : "full") : "panel";
    if (layout === "side" && this.isConnected) this.#reserveRoom();
    else this.#releaseRoom();
    this.#watchViewport(wanted && this.isConnected);
    if (layout === "panel") this.removeAttribute("data-layout");
    else this.setAttribute("data-layout", layout);
    this.#launcher.hidden = layout !== "panel";
    this.#expandBtn.hidden = !allow || this.#expanded;
    this.#collapseBtn.hidden = !allow || !this.#expanded;
  }

  /**
   * Narrows the host page by the column's width: a margin on the root element
   * on the widget's side, and the width in a custom property the host can use
   * to move what it fixed to that edge. What was there is kept to put back.
   */
  #reserveRoom(): void {
    const side = this.#config.position === "left" ? "left" : "right";
    const property = `margin-${side}`;
    if (this.#reservation?.property === property) return;
    this.#releaseRoom();
    const root = document.documentElement;
    if (!root) return;
    const style = root.style;
    const reservation: RootReservation = {
      root,
      property,
      value: style.getPropertyValue(property),
      priority: style.getPropertyPriority(property),
      variableValue: style.getPropertyValue(PANEL_WIDTH_PROPERTY),
      variablePriority: style.getPropertyPriority(PANEL_WIDTH_PROPERTY),
      styleAttribute: root.getAttribute("style"),
      cssText: style.cssText,
    };
    const width = `${SIDE_PANEL_WIDTH_PX}px`;
    // The host's own margin is kept and the column added to it.
    if (reservation.value)
      style.setProperty(property, `calc(${reservation.value} + ${width})`, "important");
    if (!reservation.value || style.getPropertyValue(property) === reservation.value) {
      style.setProperty(property, width, "important");
    }
    style.setProperty(PANEL_WIDTH_PROPERTY, width);
    this.#reservation = reservation;
  }

  /** Removes exactly what `#reserveRoom` added. */
  #releaseRoom(): void {
    const reservation = this.#reservation;
    if (reservation === null) return;
    this.#reservation = null;
    const { root } = reservation;
    const style = root.style;
    if (reservation.value) {
      style.setProperty(reservation.property, reservation.value, reservation.priority);
    } else {
      style.removeProperty(reservation.property);
    }
    if (reservation.variableValue) {
      style.setProperty(
        PANEL_WIDTH_PROPERTY,
        reservation.variableValue,
        reservation.variablePriority,
      );
    } else {
      style.removeProperty(PANEL_WIDTH_PROPERTY);
    }
    // Nothing else changed meanwhile: put the attribute back as it was written.
    // Reading it first makes the browser write out the changes above now
    // (Chromium does so lazily), so they cannot land after it is restored.
    root.getAttribute("style");
    if (style.cssText === reservation.cssText) {
      if (reservation.styleAttribute === null) root.removeAttribute("style");
      else root.setAttribute("style", reservation.styleAttribute);
    }
  }

  #restore(saved: {
    conversationId: string | null;
    open: boolean;
    expanded?: boolean;
    turns: SavedTurn[];
    pendingResume?: PendingResume;
  }): void {
    this.#conversationId = saved.conversationId;
    this.#expanded = saved.expanded === true;
    this.#pendingResume = saved.pendingResume ?? null;
    this.#resumedBubble = null;
    this.#turns = saved.turns.map((turn) => ({
      ...turn,
      ...(turn.citations ? { citations: [...turn.citations] } : {}),
      ...(turn.actions ? { actions: turn.actions.map((action) => ({ ...action })) } : {}),
      ...(turn.awaiting ? { awaiting: [...turn.awaiting] } : {}),
    }));

    this.#messagesEl.replaceChildren(this.#greetingEl);
    let restoredUnfinished = false;
    for (const turn of this.#turns) {
      const { bubble, textEl } = this.#appendBubble(turn.role);
      if (turn.role === "assistant") {
        renderMarkdown(textEl, turn.text);
        if (turn.actions) {
          for (const action of turn.actions) {
            this.#appendActionNote(bubble, action.name, action.ok);
          }
        }
        if (turn.citations) {
          for (const citation of turn.citations) {
            this.#appendCitationLink(bubble, citation.url, citation.title);
          }
        }
        const canResume =
          this.#pendingResume !== null &&
          !turn.error &&
          turn.messageId === this.#pendingResume.resumeMessageId;
        const unfinished =
          !canResume &&
          !turn.error &&
          (!turn.messageId || (turn.awaiting !== undefined && turn.awaiting.length > 0));
        if (canResume) {
          this.#resumedBubble = { bubble, textEl, turn };
        } else if (unfinished) {
          delete turn.awaiting;
          turn.error = "Response interrupted. Please try again.";
          restoredUnfinished = true;
        }
        if (turn.error) {
          this.#renderBubbleError(bubble, turn.error);
        }
        if (turn.messageId && !unfinished && !canResume && !turn.error) {
          this.#appendFeedbackControls(bubble, turn);
        }
      } else {
        textEl.textContent = turn.text;
      }
    }
    this.#renderSuggestions();

    if (this.#pendingResume && !this.#resumedBubble) {
      this.#pendingResume = null;
    }

    if (saved.open) {
      this.#openPanel(false);
    } else {
      this.#open = false;
      this.#panel.hidden = true;
      this.#launcher.setAttribute("aria-expanded", "false");
      this.#launcher.setAttribute("aria-label", "Open chat");
      this.#applyLayout();
      if (restoredUnfinished) {
        this.#persist();
      }
    }
  }

  #snapshot(): SavedConversation {
    return {
      conversationId: this.#conversationId,
      open: this.#open,
      ...(this.#expanded ? { expanded: true } : {}),
      turns: this.#turns,
      ...(this.#pendingResume ? { pendingResume: this.#pendingResume } : {}),
    };
  }

  #persist(): void {
    saveConversation(this.#assistant(), this.#snapshot(), this.#owner);
  }

  #appendBubble(role: "user" | "assistant"): { bubble: HTMLDivElement; textEl: HTMLDivElement } {
    const bubble = document.createElement("div");
    bubble.className = `solv-bubble solv-bubble--${role}`;

    const textEl = document.createElement("div");
    textEl.className = "solv-bubble-text";
    bubble.append(textEl);

    this.#messagesEl.append(bubble);
    this.#scrollToBottom();
    return { bubble, textEl };
  }

  #appendCitation(bubble: HTMLDivElement, turn: SavedTurn, url: string, title: string): void {
    const link = this.#appendCitationLink(bubble, url, title);
    if (link === null) return;
    if (!turn.citations) turn.citations = [];
    turn.citations.push({ url: link.href, title: link.textContent ?? "" });
  }

  #appendCitationLink(
    bubble: HTMLDivElement,
    url: string,
    title: string,
  ): HTMLAnchorElement | null {
    // Scheme allow-list: a citation URL ultimately comes from pushed content,
    // so `javascript:` or `data:` must never reach an href.
    const parsed = parseSafeHttpUrl(url);
    if (!parsed) {
      return null;
    }

    let container = bubble.querySelector<HTMLDivElement>(".solv-citations");
    if (!container) {
      container = document.createElement("div");
      container.className = "solv-citations";
      bubble.append(container);
    }

    const link = document.createElement("a");
    link.className = "solv-citation";
    link.href = parsed.href;
    link.textContent = title || parsed.hostname;
    // noopener/noreferrer: we are linking out of the owner's page on their
    // behalf and should leak nothing by default.
    link.rel = "noopener noreferrer";
    link.target = "_blank";
    container.append(link);
    return link;
  }

  /**
   * Asks the visitor. Bound as a field so it can be handed to `runAction`
   * without losing `this`.
   */
  #confirmAction = async (request: RunRequest, action: RegisteredAction): Promise<boolean> => {
    if (this.#dismissedTurn && this.#dismissedTurn === this.#abortController) {
      return false;
    }
    // Opening the panel first: a prompt the visitor cannot see is not consent.
    if (!this.#open) this.#openPanel(false);
    const handle = askToConfirm(this.#messagesEl, request, action, () => this.#focusInput());
    this.#openConfirms.add(handle);
    try {
      return await handle.answer;
    } finally {
      this.#openConfirms.delete(handle);
      this.#scrollToBottom();
    }
  };

  /**
   * One line saying what the assistant is about to do, for every action and not
   * only the confirmed ones: "The widget says what it is about to do" is
   * unconditional in the specification.
   */
  #announceAction(bubble: HTMLDivElement, name: string): HTMLDivElement {
    const note = document.createElement("div");
    note.className = "solv-action-note";
    note.textContent = ACTION_WORDING[name] ?? `Using ${name} on this page.`;
    bubble.append(note);
    this.#keepTypingLast(bubble);
    this.#scrollToBottom();
    return note;
  }

  #appendActionNote(bubble: HTMLDivElement, name: string, ok: boolean): void {
    let container = bubble.querySelector<HTMLDivElement>(".solv-actions");
    if (!container) {
      container = document.createElement("div");
      container.className = "solv-actions";
      bubble.append(container);
    }
    const note = document.createElement("span");
    note.className = "solv-action";
    note.textContent = ok ? `Ran ${name}` : `Could not run ${name}`;
    container.append(note);
    this.#keepTypingLast(bubble);
  }

  #appendFeedbackControls(bubble: HTMLDivElement, turn: SavedTurn): void {
    if (!turn.messageId || bubble.querySelector(".solv-feedback")) return;

    const row = document.createElement("div");
    row.className = "solv-feedback";

    const upBtn = document.createElement("button");
    upBtn.type = "button";
    upBtn.className = "solv-fb-btn";
    upBtn.textContent = "Helpful";
    upBtn.setAttribute("aria-label", "Helpful");
    upBtn.setAttribute("aria-pressed", turn.feedback === "up" ? "true" : "false");

    const downBtn = document.createElement("button");
    downBtn.type = "button";
    downBtn.className = "solv-fb-btn";
    downBtn.textContent = "Not helpful";
    downBtn.setAttribute("aria-label", "Not helpful");
    downBtn.setAttribute("aria-pressed", turn.feedback === "down" ? "true" : "false");

    const ack = document.createElement("span");
    ack.className = "solv-fb-ack";

    if (turn.feedback) {
      upBtn.disabled = true;
      downBtn.disabled = true;
      ack.textContent = "Thanks for the feedback.";
    }

    let submitting = false;

    const submit = async (value: "up" | "down") => {
      if (submitting || turn.feedback || !turn.messageId) return;
      submitting = true;
      upBtn.disabled = true;
      downBtn.disabled = true;
      ack.textContent = "";

      try {
        const session = this.#checkRequired() ? await this.#sessionFor() : undefined;
        if (session === null) throw new Error("No visitor session");
        const response = await fetch(`${this.#endpoint()}/v1/feedback`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            protocol: CHAT_PROTOCOL_VERSION,
            assistant: this.#assistant(),
            visitorId: visitorId(),
            messageId: turn.messageId,
            value,
            ...(session ? { session } : {}),
          }),
        });
        if (!response.ok) {
          throw new Error(`Feedback request failed with status ${response.status}`);
        }

        turn.feedback = value;
        upBtn.setAttribute("aria-pressed", value === "up" ? "true" : "false");
        downBtn.setAttribute("aria-pressed", value === "down" ? "true" : "false");
        ack.textContent = "Thanks for the feedback.";
        this.#persist();
      } catch {
        upBtn.disabled = false;
        downBtn.disabled = false;
        upBtn.setAttribute("aria-pressed", "false");
        downBtn.setAttribute("aria-pressed", "false");
        ack.textContent = "Could not send feedback. Try again.";
      } finally {
        submitting = false;
      }
    };

    upBtn.addEventListener("click", () => void submit("up"));
    downBtn.addEventListener("click", () => void submit("down"));

    row.append(upBtn, downBtn, ack);
    bubble.append(row);
  }

  #showInputError(message: string): void {
    this.#inputErrorEl.textContent = message;
    this.#inputErrorEl.hidden = false;
    this.#inputEl.setAttribute("aria-invalid", "true");
  }

  #clearInputError(): void {
    if (this.#inputErrorEl.hidden) return;
    this.#inputErrorEl.textContent = "";
    this.#inputErrorEl.hidden = true;
    this.#inputEl.removeAttribute("aria-invalid");
  }

  #setTurnError(bubble: HTMLDivElement, turn: SavedTurn, message: string): void {
    this.#hideTyping(bubble);
    turn.error = message;
    this.#renderBubbleError(bubble, message);
    this.#scrollToBottom();
  }

  #markTurnInterrupted(bubble: HTMLDivElement, turn: SavedTurn): void {
    const msg = turn.text
      ? "Response interrupted. Please try again."
      : "Unable to reach the assistant. Please try again.";
    this.#setTurnError(bubble, turn, msg);
  }

  #renderBubbleError(bubble: HTMLDivElement, message: string): void {
    bubble.classList.add("solv-bubble--error");
    let errorEl = bubble.querySelector<HTMLDivElement>(".solv-bubble-error");
    if (!errorEl) {
      errorEl = document.createElement("div");
      errorEl.className = "solv-bubble-error";
      errorEl.setAttribute("role", "alert");
      bubble.append(errorEl);
    }
    errorEl.textContent = message;
  }

  /**
   * Keeps the newest message in view, unless the visitor has scrolled up to
   * read something earlier. `force` is for the visitor's own new message.
   */
  #scrollToBottom(force = false): void {
    if (force) this.#pinned = true;
    if (!this.#pinned) return;
    this.#messagesEl.scrollTop = this.#messagesEl.scrollHeight;
  }

  /**
   * Shows the typing indicator at the end of `bubble`: three dots, and the
   * first time for this answer a visually hidden "Writing an answer" that
   * the live region announces. Shown again later (a tool, a page action) it
   * is the dots alone, so the announcement is made once.
   */
  #showTyping(bubble: HTMLDivElement): void {
    let indicator = bubble.querySelector<HTMLDivElement>(".solv-typing");
    if (!indicator) {
      indicator = document.createElement("div");
      indicator.className = "solv-typing";
      for (let i = 0; i < 3; i++) {
        const dot = document.createElement("span");
        dot.className = "solv-typing-dot";
        dot.setAttribute("aria-hidden", "true");
        indicator.append(dot);
      }
      if (!this.#announced.has(bubble)) {
        this.#announced.add(bubble);
        const label = document.createElement("span");
        label.className = "sr-only";
        label.textContent = TYPING_LABEL;
        indicator.append(label);
      }
    }
    // Last in the bubble, after any note about an action.
    if (bubble.lastElementChild !== indicator) bubble.append(indicator);
    this.#scrollToBottom();
  }

  #keepTypingLast(bubble: HTMLDivElement): void {
    const indicator = bubble.querySelector(".solv-typing");
    if (indicator && bubble.lastElementChild !== indicator) bubble.append(indicator);
  }

  #hideTyping(bubble: HTMLDivElement): void {
    bubble.querySelector(".solv-typing")?.remove();
  }

  /**
   * Paints the streamed answer in `textEl` on the next animation frame, so a
   * fast stream lays out once a frame rather than once a token.
   */
  #queuePaint(textEl: HTMLDivElement, turn: SavedTurn): void {
    let entry = this.#paints.get(textEl);
    if (!entry) {
      entry = { textEl, turn, frame: null, timer: null, heldFrom: -1, heldSince: 0 };
      this.#paints.set(textEl, entry);
    }
    entry.turn = turn;
    if (entry.frame !== null) return;
    const live = entry;
    entry.frame = requestFrame(() => {
      live.frame = null;
      this.#paint(live);
    });
  }

  #paint(entry: LivePaint): void {
    const text = entry.turn.text;
    const view = streamingView(text);
    let markdown = view.markdown;
    if (view.heldFrom < text.length) {
      const now = Date.now();
      if (entry.heldFrom !== view.heldFrom) {
        entry.heldFrom = view.heldFrom;
        entry.heldSince = now;
      }
      const waited = now - entry.heldSince;
      if (waited >= HOLD_BOUND_MS) {
        // Held long enough: shown as it stands, so text never waits for long.
        markdown = text;
      } else if (entry.timer === null) {
        entry.timer = setTimeout(() => {
          entry.timer = null;
          if (this.#paints.get(entry.textEl) === entry) this.#queuePaint(entry.textEl, entry.turn);
        }, HOLD_BOUND_MS - waited);
      }
    } else {
      entry.heldFrom = -1;
    }
    renderMarkdown(entry.textEl, markdown);
    if (entry.textEl.childNodes.length > 0) {
      const bubble = entry.textEl.parentElement;
      if (bubble instanceof HTMLDivElement) this.#hideTyping(bubble);
    }
    this.#scrollToBottom();
    this.#persist();
  }

  /** Paints the whole text now, as it renders at rest, and stops painting `textEl`. */
  #finishPaint(textEl: HTMLDivElement): void {
    const entry = this.#paints.get(textEl);
    if (!entry) return;
    this.#paints.delete(textEl);
    if (entry.frame !== null) cancelFrame(entry.frame);
    if (entry.timer !== null) clearTimeout(entry.timer);
    renderMarkdown(textEl, entry.turn.text);
  }

  /** Why the last check failed, for the bubble that waited on it. */
  #checkFailure = "";

  /**
   * The session to send: undefined when the engine runs no check, null when
   * the check could not be completed (`#checkFailure` says why).
   */
  async #sessionFor(): Promise<string | null | undefined> {
    if (!this.#checkRequired()) return undefined;
    this.#interacted = true;
    const result = await this.#check.ensure();
    if (result.ok) return result.session;
    this.#checkFailure = result.message;
    return null;
  }

  async #send(message: string, onAccepted?: () => void): Promise<void> {
    const assistant = this.#assistant();
    const trimmed = message.trim();
    if (!assistant || this.#previewing || this.#sending || !trimmed) return;

    if (trimmed.length > MAX_CHAT_MESSAGE_LENGTH) {
      this.#showInputError(
        `Message must be ${MAX_CHAT_MESSAGE_LENGTH.toLocaleString("en-US")} characters or fewer.`,
      );
      return;
    }

    this.#clearInputError();
    onAccepted?.();
    this.#sending = true;
    this.#sendBtn.disabled = true;

    const pending = this.#pendingResume;
    if (pending) {
      this.#pendingResume = null;
      this.#resumedBubble = null;
      this.#clearPendingNavigation(pending.resumeMessageId);
      this.#persist();
    }

    const userTurn: SavedTurn = { role: "user", text: trimmed };
    this.#turns.push(userTurn);
    const userBubble = this.#appendBubble("user");
    userBubble.textEl.textContent = trimmed;
    this.#renderSuggestions();

    const assistantTurn: SavedTurn = { role: "assistant", text: "" };
    this.#turns.push(assistantTurn);
    const { bubble, textEl } = this.#appendBubble("assistant");
    // From the moment it is sent, through the visitor check, until text arrives.
    this.#showTyping(bubble);
    this.#scrollToBottom(true);
    this.#persist();

    const controller = new AbortController();
    this.#abortController = controller;
    const { signal } = controller;

    try {
      if (pending) {
        // Best-effort notification: dispatch without awaiting so a stalled
        // reporting request or stream never blocks the visitor's new message.
        void this.#reportDroppedResume(pending, signal);
      }
      // With the visitor check on, the message waits here, in the same
      // empty "thinking" bubble, until the check has a session for it.
      const session = this.#checkRequired() ? await this.#sessionFor() : undefined;
      if (session !== undefined && signal.aborted) return;
      if (session === null) {
        this.#setTurnError(bubble, assistantTurn, this.#checkFailure);
        return;
      }
      const requestBody: Record<string, unknown> = {
        // Sent on every request so the engine can refuse a version it does not
        // support instead of guessing what this widget means.
        protocol: CHAT_PROTOCOL_VERSION,
        assistant,
        visitorId: visitorId(),
        message: trimmed,
      };
      if (session) requestBody.session = session;
      if (this.#conversationId !== null) {
        requestBody.conversationId = this.#conversationId;
      }
      if (location.href.startsWith("http://") || location.href.startsWith("https://")) {
        requestBody.pageUrl = location.href;
      }
      const pageActions = listForRequest();
      // Omitted when the page registered nothing, so a site that never calls
      // register sends exactly the phase 1 body.
      if (pageActions.length > 0) {
        requestBody.pageActions = pageActions;
      }

      const response = await fetch(`${this.#endpoint()}/v1/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
        signal,
      });

      await this.#consumeStream(response, bubble, textEl, assistantTurn, controller, 0);
    } catch {
      if (!signal.aborted && !assistantTurn.error) {
        delete assistantTurn.awaiting;
        this.#markTurnInterrupted(bubble, assistantTurn);
      }
    } finally {
      this.#finishPaint(textEl);
      this.#hideTyping(bubble);
      if (this.#abortController === controller) {
        this.#abortController = null;
        this.#sending = false;
        this.#sendBtn.disabled = false;
      }
      if (this.#dismissedTurn === controller) {
        this.#dismissedTurn = null;
      }
      if (!signal.aborted) {
        this.#persist();
      }
    }
  }

  async #consumeStream(
    response: Response,
    bubble: HTMLDivElement,
    textEl: HTMLDivElement,
    assistantTurn: SavedTurn,
    controller: AbortController,
    depth: number,
  ): Promise<void> {
    const { signal } = controller;
    if (signal.aborted) return;

    if (!response.ok || !response.body) {
      delete assistantTurn.awaiting;
      this.#setTurnError(bubble, assistantTurn, "Something went wrong. Please try again.");
      return;
    }

    let terminated = false;
    let resumeEvent: {
      messageId: string;
      conversationId: string;
      awaitingActions: string[];
    } | null = null;
    const pendingActions: RunRequest[] = [];

    try {
      for await (const raw of readEventLines(response)) {
        if (signal.aborted) break;
        const event = parseChatEventLine(raw.name, raw.data);
        // Unknown types are skipped, not an error: a newer engine will send event
        // types this cached bundle has never heard of, and the only acceptable
        // behaviour is to keep rendering the ones it knows.
        if (event.type === "unknown") continue;

        if (event.type === "token") {
          // DOM nodes and textContent only, never raw HTML assignment: the text
          // comes from a model that can be talked into emitting markup, and a
          // chat bubble is the last place that should execute anything.
          // Painted once a frame, holding back a half-written link or list
          // marker for a moment (see `streaming.ts`).
          assistantTurn.text += event.text;
          this.#queuePaint(textEl, assistantTurn);
        } else if (event.type === "citation") {
          this.#appendCitation(bubble, assistantTurn, event.url, event.title);
          this.#persist();
        } else if (event.type === "tool") {
          // A tool is working: the answer is not stuck.
          if (event.state === "running") this.#showTyping(bubble);
          else if (assistantTurn.text !== "") this.#hideTyping(bubble);
        } else if (event.type === "action") {
          // Queued rather than run on arrival: `done` names the full set, and
          // running them in one pass keeps one follow-up request per pause.
          pendingActions.push({
            callId: event.callId,
            name: event.name,
            input: event.input,
            confirm: event.confirm,
          });
        } else if (event.type === "done") {
          terminated = true;
          this.#finishPaint(textEl);
          this.#conversationId = event.conversationId;
          assistantTurn.messageId = event.messageId;
          if (event.awaitingActions && event.awaitingActions.length > 0) {
            if (depth < 5) {
              // The answer paused, it did not finish: no feedback controls yet,
              // and the pending calls are persisted so a reload mid-round-trip
              // marks the turn interrupted rather than complete.
              assistantTurn.awaiting = [...event.awaitingActions];
              this.#persist();
              resumeEvent = {
                messageId: event.messageId,
                conversationId: event.conversationId,
                awaitingActions: event.awaitingActions,
              };
            } else {
              // Local round limit reached while the answer is still paused:
              // never mark a paused response complete.
              delete assistantTurn.awaiting;
              this.#markTurnInterrupted(bubble, assistantTurn);
              this.#persist();
            }
          } else {
            delete assistantTurn.awaiting;
            this.#appendFeedbackControls(bubble, assistantTurn);
            this.#persist();
          }
        } else if (event.type === "error") {
          terminated = true;
          this.#finishPaint(textEl);
          this.#hideTyping(bubble);
          delete assistantTurn.awaiting;
          if (event.code === "check_required") this.#check.clear();
          // The engine will not take more in this conversation; the next
          // question starts a new one, as the message says.
          if (event.code === "conversation_cap") this.#conversationId = null;
          const msg = event.message.trim() || "Something went wrong. Please try again.";
          this.#setTurnError(bubble, assistantTurn, msg);
          this.#persist();
        }
      }

      if (!terminated && !signal.aborted) {
        delete assistantTurn.awaiting;
        this.#markTurnInterrupted(bubble, assistantTurn);
      }
    } catch {
      if (!terminated && !signal.aborted) {
        delete assistantTurn.awaiting;
        this.#markTurnInterrupted(bubble, assistantTurn);
      }
    }
    this.#finishPaint(textEl);
    if (!resumeEvent) this.#hideTyping(bubble);

    if (resumeEvent && !signal.aborted) {
      await this.#resumeWithActionResults(
        bubble,
        textEl,
        assistantTurn,
        resumeEvent,
        pendingActions,
        controller,
        depth + 1,
      );
    }
  }

  async #resumeAfterConfigLoad(
    pending: PendingResume,
    target: { bubble: HTMLDivElement; textEl: HTMLDivElement; turn: SavedTurn },
  ): Promise<void> {
    // Reserve sending state synchronously before awaiting config so a visitor
    // cannot submit a competing message while configuration is in flight.
    const controller = new AbortController();
    this.#abortController = controller;
    this.#sending = true;
    this.#sendBtn.disabled = true;
    const { signal } = controller;
    // The answer carries on after the page change: say so straight away.
    this.#showTyping(target.bubble);

    try {
      await this.#loadConfig();
      if (!this.isConnected || signal.aborted) return;

      const actionResults =
        pending.navigateCallId && typeof location !== "undefined"
          ? pending.actionResults.map((entry) =>
              entry.callId === pending.navigateCallId
                ? {
                    ...entry,
                    ok: true as const,
                    result: serialiseResult({ opened: location.href }),
                  }
                : entry,
            )
          : pending.actionResults;

      const session = this.#checkRequired() ? await this.#sessionFor() : undefined;
      if (signal.aborted) return;
      if (session === null) {
        delete target.turn.awaiting;
        this.#setTurnError(target.bubble, target.turn, this.#checkFailure);
        return;
      }
      const response = await this.#sendActionResumeRequest(
        pending.conversationId,
        pending.resumeMessageId,
        actionResults,
        signal,
        session,
      );
      await this.#consumeStream(
        response,
        target.bubble,
        target.textEl,
        target.turn,
        controller,
        pending.depth,
      );
    } catch {
      if (!signal.aborted && !target.turn.error) {
        delete target.turn.awaiting;
        this.#markTurnInterrupted(target.bubble, target.turn);
      }
    } finally {
      this.#finishPaint(target.textEl);
      this.#hideTyping(target.bubble);
      if (this.#abortController === controller) {
        this.#abortController = null;
        this.#sending = false;
        this.#sendBtn.disabled = false;
      }
      if (this.#dismissedTurn === controller) {
        this.#dismissedTurn = null;
      }
      if (!signal.aborted) {
        this.#persist();
      }
    }
  }

  #clearPendingNavigation(resumeMessageId: string): void {
    for (const el of this.#messagesEl.querySelectorAll(".solv-nav-status")) {
      el.remove();
    }
    for (const turn of this.#turns) {
      if (turn.messageId === resumeMessageId && turn.awaiting) {
        delete turn.awaiting;
      }
    }
  }

  async #reportDroppedResume(pending: PendingResume, signal?: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    const timer = setTimeout(onAbort, DROPPED_RESUME_TIMEOUT_MS);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      // Best effort: with the check on, only a session already held is used;
      // this notice never starts a check of its own.
      const session = this.#checkRequired() ? this.#check.session() : undefined;
      if (session === null) return;
      const response = await this.#sendActionResumeRequest(
        pending.conversationId,
        pending.resumeMessageId,
        buildMovedOnResults(pending),
        controller.signal,
        session,
      );
      await response.text().catch(() => {});
    } catch {
      // Best-effort notification; never block a new message or connect.
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  #appendExternalNavButton(bubble: HTMLDivElement, target: URL): void {
    const wrap = document.createElement("div");
    wrap.className = "solv-nav-external";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "solv-fb-btn solv-nav-open";
    btn.textContent = `Open ${target.host} in a new tab`;
    btn.addEventListener("click", () => {
      window.open(target.href, "_blank", "noopener,noreferrer");
    });
    wrap.append(btn);
    bubble.append(wrap);
    this.#scrollToBottom();
  }

  async #sendActionResumeRequest(
    conversationId: string,
    resumeMessageId: string,
    actionResults: ActionResult[],
    signal: AbortSignal,
    session: string | undefined,
  ): Promise<Response> {
    const requestBody: Record<string, unknown> = {
      protocol: CHAT_PROTOCOL_VERSION,
      assistant: this.#assistant(),
      visitorId: visitorId(),
      conversationId,
      // Names the answer to continue: two requests in one conversation can
      // interleave, so "the latest" is not good enough.
      resumeMessageId,
      actionResults,
    };
    if (session) requestBody.session = session;
    if (location.href.startsWith("http://") || location.href.startsWith("https://")) {
      requestBody.pageUrl = location.href;
    }
    const pageActions = listForRequest();
    if (pageActions.length > 0) {
      requestBody.pageActions = pageActions;
    }

    return fetch(`${this.#endpoint()}/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
      signal,
    });
  }

  /**
   * Runs the queued actions and sends their results back so the answer can
   * continue. A second request rather than a held stream: `navigate` replaces
   * the page, and this must survive that.
   */
  async #resumeWithActionResults(
    bubble: HTMLDivElement,
    textEl: HTMLDivElement,
    assistantTurn: SavedTurn,
    done: { messageId: string; conversationId: string; awaitingActions?: string[] },
    pendingActions: RunRequest[],
    controller: AbortController,
    depth: number,
  ): Promise<void> {
    const { signal } = controller;
    const byId = new Map(pendingActions.map((req) => [req.callId, req]));
    const toRun = (done.awaitingActions ?? []).map(
      (callId) => byId.get(callId) ?? { callId, name: "", input: {}, confirm: false },
    );

    const results: ActionResult[] = [];
    // A page action is in progress, then the answer continues.
    this.#showTyping(bubble);
    try {
      for (let i = 0; i < toRun.length; i++) {
        const request = toRun[i];
        if (!request || signal.aborted) return;
        clearHighlight();
        let navigatedTo: URL | null = null;
        let externalTarget: URL | null = null;
        setBeforeNavigate((target) => {
          navigatedTo = target;
          const pendingResults: ActionResult[] = [
            ...results,
            {
              callId: request.callId,
              ok: true,
              result: serialiseResult({ opened: target.href }),
            },
            ...toRun.slice(i + 1).map((rem) => ({
              callId: rem.callId,
              ok: false as const,
              error: "Page navigated before action could run.",
            })),
          ];
          this.#pendingResume = {
            conversationId: done.conversationId,
            resumeMessageId: done.messageId,
            actionResults: pendingResults,
            depth,
            createdAt: Date.now(),
            navigateCallId: request.callId,
          };
          if (request.name) {
            if (!assistantTurn.actions) assistantTurn.actions = [];
            assistantTurn.actions.push({ name: request.name, ok: true });
            this.#persist();
            assistantTurn.actions.pop();
          } else {
            this.#persist();
          }
        });
        setOnExternalNavigate((target) => {
          externalTarget = target;
        });
        const actionNote = request.name ? this.#announceAction(bubble, request.name) : null;
        const result = await runAction(request, { confirm: this.#confirmAction });
        setBeforeNavigate(null);
        setOnExternalNavigate(null);
        if (signal.aborted) return;
        if (
          request.name === "navigate" &&
          !result.ok &&
          result.error === NAVIGATION_NOT_ALLOWED_ERROR &&
          actionNote
        ) {
          actionNote.textContent = "The assistant cannot open that page.";
        }
        if (navigatedTo !== null) {
          const target: URL = navigatedTo;
          if (result.ok) {
            const status = document.createElement("div");
            status.className = "solv-nav-status";
            status.setAttribute("role", "status");
            status.textContent = `Taking you to ${target.pathname || "/"}…`;
            bubble.append(status);
            this.#scrollToBottom();
            return;
          }
          // Navigation threw synchronously while the document stayed active:
          // clear the pending continuation so this widget resumes the answer.
          this.#pendingResume = null;
        }
        results.push(result);
        if (request.name) {
          if (!assistantTurn.actions) assistantTurn.actions = [];
          assistantTurn.actions.push({ name: request.name, ok: result.ok });
          this.#appendActionNote(bubble, request.name, result.ok);
          this.#scrollToBottom();
        }
        if (externalTarget !== null) {
          this.#appendExternalNavButton(bubble, externalTarget);
        }
        this.#persist();
      }
    } finally {
      setBeforeNavigate(null);
      setOnExternalNavigate(null);
    }

    const session = this.#checkRequired() ? await this.#sessionFor() : undefined;
    if (signal.aborted) return;
    if (session === null) {
      delete assistantTurn.awaiting;
      this.#setTurnError(bubble, assistantTurn, this.#checkFailure);
      return;
    }
    const response = await this.#sendActionResumeRequest(
      done.conversationId,
      done.messageId,
      results,
      signal,
      session,
    );

    await this.#consumeStream(response, bubble, textEl, assistantTurn, controller, depth);
  }
}

if (typeof customElements !== "undefined" && !customElements.get("solv-chat")) {
  customElements.define("solv-chat", SolvChat);
}
