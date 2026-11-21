import {
  type ActionResult,
  CHAT_PROTOCOL_VERSION,
  CONFIG_LIMITS,
  MAX_CHAT_MESSAGE_LENGTH,
  parseChatEventLine,
  type WidgetOpenMode,
  type WidgetShortcut,
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
import { CheckController, type CheckResult } from "./check.js";
import { askToConfirm, type ConfirmHandle } from "./confirm.js";
import { parseSafeHttpUrl, renderMarkdown } from "./markdown.js";
import { readEventLines } from "./sse.js";
import {
  claimConversation,
  loadConversation,
  loadPublicConfig,
  PENDING_RESUME_TTL_MS,
  type PendingResume,
  type SavedConversation,
  type SavedTurn,
  saveConversation,
  savePublicConfig,
  visitorId,
} from "./storage.js";
import { HOLD_BOUND_MS, streamingView } from "./streaming.js";
import {
  PANEL_WIDTH_PROPERTY,
  SIDE_BY_SIDE_MIN_WIDTH_PX,
  SIDE_PANEL_WIDTH_PX,
  styles,
} from "./styles.js";

// The element's public declarations must also work when the widget is
// installed by itself, so this shape uses no package imports.
interface WidgetPublicConfig {
  title: string;
  accentColor: string;
  position: "left" | "right";
  allowExpand: boolean;
  opensAs: "panel" | "side";
  launcherLabel: string;
  keyboardShortcut: "none" | "/" | "mod-k";
  greeting: string;
  suggestedQuestions: string[];
  actions: BuiltinSettings;
  /** The engine runs the visitor check: every request needs a session. */
  visitorCheck: boolean;
}

declare global {
  interface HTMLElementTagNameMap {
    "solv-chat": SolvChat;
  }
}

export interface WidgetOpenOptions {
  mode?: WidgetPublicConfig["opensAs"];
  focus?: boolean;
}

export interface WidgetSendOptions {
  open?: boolean;
}

export interface WidgetSendResult {
  text: string;
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
  maxWidthValue: string;
  maxWidthPriority: string;
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
const MESSAGE_TOO_LONG = `Message must be ${MAX_CHAT_MESSAGE_LENGTH.toLocaleString("en-US")} characters or fewer.`;
const ASSISTANT_UNAVAILABLE = "This assistant is not available.";
const RESPONSE_INTERRUPTED = "Response interrupted. Please try again.";
const CHAT_FAILED = "Something went wrong. Please try again.";

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
  opensAs: "panel",
  launcherLabel: "Chat",
  keyboardShortcut: "none",
};

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const CONFIG_OPEN_WAIT_MS = 3_000;
const CONFIG_RESUME_WAIT_MS = 2_000;
const CONFIG_RECOVERY_WAIT_MS = 2_000;
const DROPPED_RESUME_TIMEOUT_MS = 5_000;

type ChatStreamEvent = Exclude<ReturnType<typeof parseChatEventLine>, { type: "unknown" }> & {
  configUnavailable?: true;
};

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
  if (widget.opensAs === "panel" || widget.opensAs === "side") {
    out.opensAs = widget.opensAs;
  }
  const label = typeof widget.launcherLabel === "string" ? widget.launcherLabel.trim() : "";
  if (label.length > 0 && label.length <= CONFIG_LIMITS.launcherLabel) {
    out.launcherLabel = label;
  }
  if (
    widget.keyboardShortcut === "none" ||
    widget.keyboardShortcut === "/" ||
    widget.keyboardShortcut === "mod-k"
  ) {
    out.keyboardShortcut = widget.keyboardShortcut;
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

const connectedWidgets = new Set<SolvChat>();
let legacyClick: Event | undefined;

function captureClick(event: Event): void {
  if (event.isTrusted) legacyClick = event;
}

function hasUserActivation(): boolean {
  return navigator.userActivation?.isActive ?? Boolean(legacyClick?.eventPhase);
}

function hostTrigger(event: Event, selector: string): Element | undefined {
  return event
    .composedPath()
    .find((node): node is Element => node instanceof Element && node.matches(selector));
}

function openFromHostClick(event: MouseEvent): void {
  if (!event.isTrusted || event.defaultPrevented || !hasUserActivation()) return;
  const trigger = hostTrigger(event, "[data-solv-chat-open]");
  if (!trigger) return;
  const widget = connectedWidgets.values().next().value;
  if (!widget) return;
  const mode = trigger.getAttribute("data-solv-chat-open");
  event.preventDefault();
  void widget.open(mode === "side" || mode === "panel" ? { mode } : undefined);
}

function matchesShortcut(event: KeyboardEvent, shortcut: WidgetShortcut): boolean {
  if (event.altKey || event.isComposing || event.repeat) return false;
  if (shortcut === "/") return event.key === "/" && !event.ctrlKey && !event.metaKey;
  return (
    shortcut === "mod-k" &&
    !event.shiftKey &&
    event.key.toLowerCase() === "k" &&
    event.ctrlKey !== event.metaKey
  );
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
  #connection = 0;
  #configLoading: Promise<void> | null = null;
  #open = false;
  #sending = false;
  #abortController: AbortController | null = null;
  #hostSend = false;
  /** Open confirmation prompts, refused if the panel closes or we unmount. */
  #openConfirms = new Set<ConfirmHandle>();
  /** Turn controller whose remaining confirmations were dismissed by closing the panel. */
  #dismissedTurn: AbortController | null = null;
  #conversationId: string | null = null;
  #turns: SavedTurn[] = [];
  #pendingResume: PendingResume | null = null;
  #resumedBubble: { bubble: HTMLDivElement; textEl: HTMLDivElement; turn: SavedTurn } | null = null;
  #config = DEFAULT_CONFIG;
  #configReady = false;
  #configMissing = false;
  #configNeedsSaving = false;
  #cachedConfigExpiresAt: number | undefined;
  #configRequest: Promise<void> | undefined;
  #configOpenWait: Promise<void> | undefined;
  #configAbort: AbortController | undefined;
  #configUrl: string | undefined;
  #triggerEvents: AbortController | undefined;
  #reloadConfigOnConnect = false;
  #openingWithConfig: { mode: WidgetOpenMode | undefined } | null = null;
  #pendingShortcuts = new Set<WidgetShortcut>();
  /** Set by `preview()`: the element then loads and sends nothing. */
  #previewing = false;
  /** An interaction that can start the visitor check has happened. */
  #interacted = false;
  /** Set while the widget itself moves focus to the input, which is not the visitor's doing. */
  #focusingInput = false;
  #check!: CheckController;
  #expanded = false;
  #preferredMode: WidgetOpenMode | undefined;
  #onShortcut = (event: KeyboardEvent): void => {
    if (!event.isTrusted || event.defaultPrevented) return;
    const shortcut = this.#keyboardShortcut();
    const candidate = shortcut ?? (matchesShortcut(event, "/") ? "/" : "mod-k");
    if (!matchesShortcut(event, candidate)) return;
    if (
      event
        .composedPath()
        .some(
          (node) =>
            node instanceof HTMLElement &&
            (node.isContentEditable || node.matches("input, textarea, select")),
        )
    )
      return;
    if (shortcut === undefined) {
      // The response can confirm the key after dispatch. Leave the page's
      // default key action alone until we know the owner configured it.
      this.#pendingShortcuts.add(candidate);
    } else {
      event.preventDefault();
      void this.#openRequested({}, true);
    }
  };
  #reservation: RootReservation | null = null;
  #wideQuery: MediaQueryList | null = null;
  #onWideChange = (): void => this.#applyLayout();
  /** The visitor has not scrolled up from the newest message. */
  #pinned = true;
  #paints = new Map<HTMLDivElement, LivePaint>();
  /** Bubbles whose typing indicator has been announced once already. */
  #announced = new WeakSet<HTMLDivElement>();

  #launcher!: HTMLButtonElement;
  #launcherLabel!: HTMLSpanElement;
  #launcherIcon!: SVGSVGElement;
  #shortcutBadge!: HTMLElement;
  #expandBtn!: HTMLButtonElement;
  #collapseBtn!: HTMLButtonElement;
  #closeBtn!: HTMLButtonElement;
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
    if (connectedWidgets.size === 0) {
      if (!navigator.userActivation) window.addEventListener("click", captureClick, true);
      window.addEventListener("click", openFromHostClick);
    }
    connectedWidgets.add(this);
    this.#connection++;
    const url = this.#publicConfigUrl();
    if (url !== this.#configUrl) {
      this.#configUrl = url;
      this.#configRequest = undefined;
      if (!this.#previewing) {
        this.#showLoading();
        const cached = url ? loadPublicConfig(url) : null;
        this.#cachedConfigExpiresAt = cached?.expiresAt;
        if (cached) this.#applyConfig({ ...DEFAULT_CONFIG, ...parsePublicConfig(cached.config) });
      }
    }
    this.#watchShortcut();
    this.#bindHostTriggers();

    let expiredPending: PendingResume | null = null;
    const assistant = this.#assistant();
    if (assistant) {
      const saved = loadConversation(assistant);
      claimConversation(assistant, this.#owner, saved?.tabId);
      if (saved?.pendingResume) {
        if (Date.now() - saved.pendingResume.createdAt > PENDING_RESUME_TTL_MS) {
          expiredPending = saved.pendingResume;
          delete saved.pendingResume;
        }
      }
      this.#restore(saved);
    } else {
      this.#applyLayout();
    }

    if (expiredPending) {
      this.#persist();
      const loading = this.#loadConfig();
      const signal = this.#configAbort?.signal;
      void loading.then(() => this.#reportDroppedResume(expiredPending, signal));
    }

    if (this.#pendingResume && this.#resumedBubble) {
      const pending = this.#pendingResume;
      const target = this.#resumedBubble;
      for (const widget of connectedWidgets) {
        if (
          widget !== this &&
          widget.#assistant() === assistant &&
          widget.#pendingResume?.resumeMessageId === pending.resumeMessageId &&
          widget.#resumedBubble === null
        ) {
          widget.#abortController?.abort();
        }
      }
      // Claim synchronously so another widget cannot also restore this turn.
      this.#pendingResume = null;
      this.#resumedBubble = null;
      this.#persist();
      void this.#resumeAfterConfigLoad(pending, target);
    } else if (this.#open || this.#reloadConfigOnConnect) {
      void this.#loadConfig();
    } else if (url && this.#keyboardShortcut() === undefined) {
      // Give same-tick callers a chance to supply an admin preview.
      const connection = this.#connection;
      queueMicrotask(() => {
        if (this.isConnected && connection === this.#connection) void this.#loadConfig();
      });
    }
    this.#reloadConfigOnConnect = false;
  }

  disconnectedCallback(): void {
    this.#connection++;
    this.#reloadConfigOnConnect = this.#configLoading !== null;
    this.#openingWithConfig = null;
    this.#pendingShortcuts.clear();
    this.#triggerEvents?.abort();
    this.#configAbort?.abort();
    this.#configAbort = undefined;
    this.#configRequest = undefined;
    this.#configOpenWait = undefined;
    this.#configLoading = null;
    connectedWidgets.delete(this);
    if (connectedWidgets.size === 0) {
      window.removeEventListener("click", captureClick, true);
      window.removeEventListener("click", openFromHostClick);
      legacyClick = undefined;
    }
    this.#watchShortcut();
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
      this.#hostSend = false;
      this.#sendBtn.disabled = !this.#configReady;
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

  #publicConfigUrl(): string {
    const assistant = this.#assistant();
    return assistant ? `${this.#endpoint()}/v1/assistants/${encodeURIComponent(assistant)}` : "";
  }

  #bindHostTriggers(): void {
    this.#triggerEvents = new AbortController();
    const { signal } = this.#triggerEvents;
    for (const type of ["pointerenter", "focus", "touchstart"]) {
      this.ownerDocument.addEventListener(type, this.#onHostTrigger, {
        capture: true,
        passive: true,
        signal,
      });
    }
    this.ownerDocument.addEventListener("click", this.#onHostTrigger, { signal });
  }

  #onHostTrigger = (event: Event): void => {
    const trigger = hostTrigger(event, "[data-solv-chat-trigger], [data-solv-chat-open]");
    if (!trigger) return;
    const targeted = this.id !== "" && trigger.getAttribute("data-solv-chat-trigger") === this.id;
    if (event.type === "click") {
      if (!targeted || event.defaultPrevented) return;
      event.preventDefault();
      if (!this.#open) void this.#openRequested({}, true);
    } else if (
      (targeted ||
        (trigger.hasAttribute("data-solv-chat-open") &&
          connectedWidgets.values().next().value === this)) &&
      (event.type !== "pointerenter" || event.composedPath()[0] === trigger)
    ) {
      void this.#loadConfig();
    }
  };

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
      onInteractive: () => {
        if (this.#hostSend && !this.#open && !this.#dismissedTurn) {
          this.#openPanel(false, this.#expandedOnOpen() ?? false);
        }
      },
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
    const launcherLabel = document.createElement("span");
    launcherLabel.className = "solv-launcher-label";
    const launcherIcon = headerIcon(
      "M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H8l-6 4V5a2 2 0 0 1 2-2Zm0 2v13l3.4-2H20V5Z",
    );
    const shortcutBadge = document.createElement("kbd");
    shortcutBadge.className = "solv-shortcut";
    shortcutBadge.setAttribute("aria-hidden", "true");
    launcher.append(launcherIcon, launcherLabel, shortcutBadge);
    for (const type of ["pointerenter", "focus", "touchstart"]) {
      launcher.addEventListener(type, () => void this.#loadConfig(), { passive: true });
    }
    launcher.addEventListener("click", () => {
      if (this.#open) this.#closePanel(true);
      else void this.#openRequested({}, false);
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
    this.#launcherLabel = launcherLabel;
    this.#launcherIcon = launcherIcon;
    this.#shortcutBadge = shortcutBadge;
    this.#expandBtn = expandBtn;
    this.#collapseBtn = collapseBtn;
    this.#closeBtn = closeBtn;
  }

  /** Opens the chat during a user gesture. */
  open(options: WidgetOpenOptions = {}): Promise<void> {
    if (!hasUserActivation() || !this.isConnected) return Promise.resolve();
    return this.#openRequested(options, true);
  }

  async close(): Promise<void> {
    this.#closePanel(this.#root.activeElement !== null);
  }

  toggle(): Promise<void> {
    if (this.#open) return this.close();
    if (!hasUserActivation() || !this.isConnected) return Promise.resolve();
    return this.#openRequested({}, true);
  }

  /** Submits host-page input and returns the complete reply as text. */
  async send(text: string, options: WidgetSendOptions = {}): Promise<WidgetSendResult> {
    const result = await this.#send(text, undefined, options);
    if (result instanceof Error) throw result;
    return result;
  }

  async #waitForConfig(loading: Promise<void>, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    });
    try {
      await Promise.race([loading, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Shows public config in the admin preview without requesting or storing anything. */
  preview(config: unknown, showPanel = true): void {
    this.#previewing = true;
    this.#openingWithConfig = null;
    this.#pendingShortcuts.clear();
    const settings = {
      ...DEFAULT_CONFIG,
      ...parsePublicConfig(config),
      actions: { enabled: false, allowedOrigins: [] },
    };
    this.#open = showPanel;
    // In the small preview frame, show the column as a full-height panel.
    this.#expanded = showPanel && settings.allowExpand && settings.opensAs === "side";
    this.#panel.hidden = !showPanel;
    this.#applyConfig(settings);
    this.#updateLauncher();
    this.#applyLayout();
  }

  #loadConfig(): Promise<void> {
    if (this.#previewing) return Promise.resolve();
    if (this.#configRequest) return this.#configRequest;
    if (this.#cachedConfigExpiresAt !== undefined && Date.now() >= this.#cachedConfigExpiresAt) {
      this.#cachedConfigExpiresAt = undefined;
      this.#showLoading();
    }
    const url = this.#configUrl;
    if (!url) {
      this.#applyConfig(DEFAULT_CONFIG);
      return Promise.resolve();
    }
    // Let the browser attach its own validator, avoiding a CORS preflight.
    const controller = new AbortController();
    this.#configAbort = controller;
    this.#configRequest = this.#fetchConfig(url, this.#configReady, controller.signal).finally(
      () => {
        if (this.#configAbort === controller) this.#configLoading = null;
      },
    );
    this.#configLoading = this.#configRequest;
    return this.#configRequest;
  }

  async #fetchConfig(url: string, revalidate: boolean, signal: AbortSignal): Promise<void> {
    const isCurrent = () => !signal.aborted && !this.#previewing && url === this.#publicConfigUrl();
    try {
      const response = await fetch(url, { cache: revalidate ? "no-cache" : "default", signal });
      if (isCurrent()) this.#configMissing = response.status === 404;
      if (response.ok) {
        const config = { ...DEFAULT_CONFIG, ...parsePublicConfig(await response.json()) };
        if (!isCurrent()) return;
        this.#cachedConfigExpiresAt = undefined;
        this.#applyConfig(config);
        if (!isCurrent()) return;
        this.#configNeedsSaving = true;
        if (this.#open) this.#saveConfig();
      }
    } catch {
      // An unreachable endpoint follows the same fallback as a refused read.
    }
    if (isCurrent() && !this.#configReady) this.#applyConfig(DEFAULT_CONFIG);
  }

  #showLoading(): void {
    this.#configReady = false;
    this.#configMissing = false;
    this.#configNeedsSaving = false;
    this.#config = DEFAULT_CONFIG;
    this.#panel.setAttribute("data-loading", "");
    this.#titleEl.textContent = "Loading chat…";
    this.#messagesEl.hidden = true;
    this.#suggestionsEl.hidden = true;
    this.#inputEl.placeholder = "";
    this.#inputEl.disabled = true;
    this.#sendBtn.disabled = true;
    const accent = this.getAttribute("launcher-accent-color")?.trim();
    this.#applyLauncherStyle(
      this.getAttribute("launcher-position") === "left" ? "left" : "right",
      accent && HEX_COLOR_RE.test(accent) ? accent : DEFAULT_CONFIG.accentColor,
    );
    this.#updateLauncher();
    this.#watchShortcut();
    this.#applyLayout();
  }

  #saveConfig(): void {
    const url = this.#configUrl;
    if (!url || url !== this.#publicConfigUrl() || !this.#configNeedsSaving || this.#previewing)
      return;
    this.#configNeedsSaving = false;
    const { actions, ...presentation } = this.#config;
    savePublicConfig(url, {
      ...presentation,
      actions: { builtins: actions.enabled, allowedOrigins: actions.allowedOrigins },
    });
  }

  #applyLauncherStyle(position: "left" | "right", accentColor: string): void {
    if (this.style.getPropertyValue("--solv-accent") !== accentColor) {
      this.style.setProperty("--solv-accent", accentColor);
    }
    if (position === "left") {
      if (this.getAttribute("data-position") !== position)
        this.setAttribute("data-position", position);
    } else if (this.hasAttribute("data-position")) {
      this.removeAttribute("data-position");
    }
  }

  #applyConfig(config: WidgetPublicConfig): void {
    const previous = this.#configReady ? this.#config : null;
    if (previous && JSON.stringify(previous) === JSON.stringify(config)) return;
    this.#config = config;
    this.#configReady = true;
    this.#updateLauncher();
    this.#watchShortcut();
    this.#applyLauncherStyle(config.position, config.accentColor);
    if (this.#titleEl.textContent !== config.title) this.#titleEl.textContent = config.title;
    if (this.#greetingEl.textContent !== config.greeting)
      this.#greetingEl.textContent = config.greeting;
    if (!previous) {
      this.#panel.removeAttribute("data-loading");
      this.#messagesEl.hidden = false;
      this.#inputEl.placeholder = "Ask a question...";
      this.#inputEl.disabled = false;
      this.#sendBtn.disabled = this.#sending;
    }
    if (JSON.stringify(previous?.actions) !== JSON.stringify(config.actions)) {
      installBuiltins(config.actions);
    }
    if (
      JSON.stringify(previous?.suggestedQuestions) !== JSON.stringify(config.suggestedQuestions)
    ) {
      this.#renderSuggestions();
    }
    if (this.#openingWithConfig) {
      const { mode } = this.#openingWithConfig;
      this.#openingWithConfig = null;
      this.#openPanel(false, this.#expandedOnOpen(mode) ?? false);
    } else {
      this.#applyLayout();
    }
    if (!previous && this.#open && this.#root.activeElement === this.#closeBtn) this.#focusInput();
    if (this.#interacted) this.#visitorInteracted();
    const shortcutPressed = this.#pendingShortcuts.has(config.keyboardShortcut);
    this.#pendingShortcuts.clear();
    if (shortcutPressed) void this.#openRequested({}, true);
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
    if (
      !this.#configReady ||
      this.#turns.length > 0 ||
      this.#config.suggestedQuestions.length === 0
    ) {
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

  #keyboardShortcut(): WidgetShortcut | undefined {
    if (this.#configReady) return this.#config.keyboardShortcut;
    const hint = this.getAttribute("launcher-shortcut");
    if (hint === "none" || hint === "/" || hint === "mod-k") return hint;
    return this.#configUrl ? undefined : "none";
  }

  #watchShortcut(): void {
    if (this.isConnected && this.#keyboardShortcut() !== "none") {
      window.addEventListener("keydown", this.#onShortcut);
    } else {
      window.removeEventListener("keydown", this.#onShortcut);
    }
  }

  #updateLauncher(): void {
    const { launcherLabel, title } = this.#config;
    const keyboardShortcut = this.#keyboardShortcut() ?? "none";
    const label = this.#configReady
      ? launcherLabel
      : this.getAttribute("launcher-label")?.trim() || (this.#configUrl ? "" : launcherLabel);
    this.#launcherIcon.toggleAttribute("hidden", label !== "");
    if (this.#launcherLabel.textContent !== label) this.#launcherLabel.textContent = label;
    this.#launcher.setAttribute("aria-expanded", String(this.#open));
    let accessibleName = label;
    if (this.#configReady && label.toLowerCase() !== title.toLowerCase()) {
      accessibleName = `${label} — ${title}`;
    } else if (!this.#configReady) {
      if (this.#open) accessibleName = "Close chat";
      else if (!label || label === DEFAULT_CONFIG.launcherLabel) accessibleName = "Open chat";
    }
    this.#launcher.setAttribute("aria-label", accessibleName);
    this.#shortcutBadge.hidden = keyboardShortcut === "none";
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    this.#shortcutBadge.textContent =
      keyboardShortcut === "mod-k" ? (mac ? "⌘ K" : "Ctrl K") : keyboardShortcut === "/" ? "/" : "";
    if (keyboardShortcut === "none") this.#launcher.removeAttribute("aria-keyshortcuts");
    else
      this.#launcher.setAttribute(
        "aria-keyshortcuts",
        keyboardShortcut === "/" ? "/" : "Control+K Meta+K",
      );
  }

  #expandedOnOpen(mode?: WidgetOpenMode): boolean | undefined {
    if (this.#configReady && !this.#config.allowExpand) return false;
    if (mode === undefined && this.#preferredMode !== undefined) {
      return this.#preferredMode === "side";
    }
    if (!this.#isWide()) return false;
    const hint = this.getAttribute("opens-as");
    const openingMode = mode ?? (this.#configReady ? this.#config.opensAs : hint);
    if (openingMode === "panel" || openingMode === "side") return openingMode === "side";
    return undefined;
  }

  async #openRequested(options: WidgetOpenOptions, visitorCheck: boolean): Promise<void> {
    const connection = this.#connection;
    const loading = this.#loadConfig();
    const { mode, focus = true } = options;
    if (!this.#open || mode !== undefined) {
      this.#openingWithConfig = this.#configReady ? null : { mode };
      this.#openPanel(focus, this.#expandedOnOpen(mode) ?? false);
    } else {
      this.#openPanel(focus);
    }
    if (visitorCheck) this.#visitorInteracted();
    if (this.#configReady) return;
    this.#configOpenWait ??= this.#waitForConfig(loading, CONFIG_OPEN_WAIT_MS);
    await this.#configOpenWait;
    if (this.isConnected && connection === this.#connection && this.#open && !this.#configReady) {
      this.#applyConfig(DEFAULT_CONFIG);
    }
  }

  #emit(action: "open" | "close" | "expand" | "collapse"): void {
    this.dispatchEvent(new Event(`solv-chat:${action}`, { bubbles: true, composed: true }));
  }

  #openPanel(moveFocus = false, expanded = this.#expanded): void {
    const wasOpen = this.#open;
    const wasExpanded = wasOpen && this.#expanded && this.#config.allowExpand;
    if (!wasOpen) this.#panel.toggleAttribute("data-opened-while-loading", !this.#configReady);
    this.#expanded = expanded;
    this.#dismissedTurn = null;
    this.#open = true;
    this.#panel.hidden = false;
    this.#updateLauncher();
    this.#applyLayout();
    this.#saveConfig();
    if (this.#configReady) this.#persist();
    if (moveFocus) {
      if (this.#configReady) this.#focusInput();
      else this.#closeBtn.focus();
    }
    if (!wasOpen) this.#emit("open");
    const isExpanded = this.#expanded && this.#config.allowExpand;
    if (this.#open && wasExpanded !== isExpanded) this.#emit(isExpanded ? "expand" : "collapse");
  }

  #closePanel(restoreFocus: boolean): void {
    if (!this.#open) return;
    for (const handle of this.#openConfirms) handle.dismiss();
    this.#openConfirms.clear();
    this.#dismissedTurn = this.#abortController;
    this.#open = false;
    this.#panel.hidden = true;
    this.#openingWithConfig = null;
    this.#updateLauncher();
    this.#applyLayout();
    this.#persist();
    if (restoreFocus) this.#launcher.focus();
    this.#emit("close");
  }

  /** Expands to the side panel or collapses back, keeping focus in the panel. */
  #setExpanded(expanded: boolean): void {
    if (!this.#config.allowExpand || !this.#open || this.#expanded === expanded) return;
    this.#expanded = expanded;
    this.#preferredMode = expanded ? "side" : "panel";
    this.#panel.removeAttribute("data-opened-while-loading");
    this.#applyLayout();
    this.#persist();
    (expanded ? this.#collapseBtn : this.#expandBtn).focus();
    this.#emit(expanded ? "expand" : "collapse");
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
    const allow = this.#configReady && this.#config.allowExpand;
    const opening = this.#openingWithConfig;
    const expanded = opening ? this.#expandedOnOpen(opening.mode) : this.#expanded;
    const wanted = this.#open && expanded === true && (allow || !this.#configReady);
    this.#panel.toggleAttribute("data-layout-pending", this.#open && expanded === undefined);
    const layout: Layout = wanted ? (this.#isWide() ? "side" : "full") : "panel";
    if (layout === "side" && this.isConnected) this.#reserveRoom();
    else this.#releaseRoom();
    this.#watchViewport((wanted || opening !== null) && this.isConnected);
    if (layout === "panel") this.removeAttribute("data-layout");
    else this.setAttribute("data-layout", layout);
    this.#launcher.hidden = layout !== "panel";
    // With the owner's setting off the controls are not in the panel at all,
    // so nothing announces or focuses them; on, they sit before the close button.
    if (!allow) {
      this.#expandBtn.remove();
      this.#collapseBtn.remove();
    } else if (this.#expandBtn.parentNode === null) {
      this.#closeBtn.before(this.#expandBtn, this.#collapseBtn);
    }
    this.#expandBtn.hidden = this.#expanded;
    this.#collapseBtn.hidden = !this.#expanded;
  }

  /**
   * Narrows the host page by the column's width: a margin on the root element
   * on the widget's side, a maximum width so an explicitly sized root narrows
   * too, and the width in a custom property the host can use
   * to move what it fixed to that edge. What was there is kept to put back.
   */
  #reserveRoom(): void {
    const side = this.getAttribute("data-position") === "left" ? "left" : "right";
    const property = `margin-${side}`;
    if (this.#reservation?.property === property) return;
    this.#releaseRoom();
    const root = document.documentElement;
    if (!root) return;
    const style = root.style;
    // Read before anything changes, so the host's own limit is the one kept.
    const hostMaxWidth =
      root.ownerDocument.defaultView?.getComputedStyle(root).getPropertyValue("max-width") ?? "";
    const reservation: RootReservation = {
      root,
      property,
      value: style.getPropertyValue(property),
      priority: style.getPropertyPriority(property),
      variableValue: style.getPropertyValue(PANEL_WIDTH_PROPERTY),
      variablePriority: style.getPropertyPriority(PANEL_WIDTH_PROPERTY),
      maxWidthValue: style.getPropertyValue("max-width"),
      maxWidthPriority: style.getPropertyPriority("max-width"),
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
    this.#limitRootWidth(root, hostMaxWidth);
  }

  /**
   * A margin narrows the root only while its width is automatic; a page that
   * sets one (`html { width: 100% }`) would stay viewport-wide under the
   * column. A maximum width of the viewport less the margins (and, for a
   * content-box root, its padding and border) keeps it beside the column
   * either way, and still honours a smaller maximum the host set.
   */
  #limitRootWidth(root: HTMLElement, hostMaxWidth: string): void {
    const view = root.ownerDocument.defaultView;
    if (!view) return;
    const computed = view.getComputedStyle(root);
    const px = (name: string): number => {
      const value = Number.parseFloat(computed.getPropertyValue(name));
      return Number.isFinite(value) ? value : 0;
    };
    let used = px("margin-left") + px("margin-right");
    if (computed.getPropertyValue("box-sizing") !== "border-box") {
      used +=
        px("padding-left") +
        px("padding-right") +
        px("border-left-width") +
        px("border-right-width");
    }
    const room = `calc(100% - ${used}px)`;
    const limit = hostMaxWidth && hostMaxWidth !== "none" ? `min(${hostMaxWidth}, ${room})` : room;
    root.style.setProperty("max-width", limit, "important");
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
    if (reservation.maxWidthValue) {
      style.setProperty("max-width", reservation.maxWidthValue, reservation.maxWidthPriority);
    } else {
      style.removeProperty("max-width");
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

  #restore(saved: SavedConversation | null): void {
    this.#conversationId = saved?.conversationId ?? null;
    this.#expanded = saved?.expanded === true;
    // Older records store the last layout alone, omitting expanded when it was false.
    const legacyMode = saved && !saved.tabId ? (saved.expanded ? "side" : "panel") : undefined;
    this.#preferredMode = saved?.preferredMode ?? legacyMode;
    this.#pendingResume = saved?.pendingResume ?? null;
    this.#resumedBubble = null;
    this.#turns = (saved?.turns ?? []).map((turn) => ({
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
          turn.messageId === this.#pendingResume.resumeMessageId &&
          (!turn.error || Boolean(turn.awaiting?.length));
        const unfinished =
          !canResume &&
          !turn.error &&
          (!turn.messageId || (turn.awaiting !== undefined && turn.awaiting.length > 0));
        if (canResume) {
          delete turn.error;
          this.#resumedBubble = { bubble, textEl, turn };
        } else if (unfinished) {
          delete turn.awaiting;
          turn.error = RESPONSE_INTERRUPTED;
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

    if (saved?.open) {
      this.#openPanel();
    } else {
      this.#open = false;
      this.#panel.hidden = true;
      this.#updateLauncher();
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
      ...(this.#preferredMode ? { preferredMode: this.#preferredMode } : {}),
      turns: this.#turns,
      ...(this.#pendingResume ? { pendingResume: this.#pendingResume } : {}),
    };
  }

  #persist(): void {
    if (this.#previewing) return;
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
    const controller = this.#abortController;
    if (this.#dismissedTurn && this.#dismissedTurn === controller) {
      return false;
    }
    // Opening the panel first: a prompt the visitor cannot see is not consent.
    if (!this.#open) this.#openPanel();
    if (!this.#open || controller?.signal.aborted) return false;
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
      if (submitting || turn.feedback || !turn.messageId || !this.isConnected || this.#previewing)
        return;
      const connection = this.#connection;
      const assistant = this.#assistant();
      const endpoint = this.#endpoint();
      const isCurrent = () =>
        connection === this.#connection &&
        !this.#previewing &&
        assistant === this.#assistant() &&
        endpoint === this.#endpoint();
      submitting = true;
      upBtn.disabled = true;
      downBtn.disabled = true;
      ack.textContent = "";

      const send = (session?: string) =>
        fetch(`${endpoint}/v1/feedback`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            protocol: CHAT_PROTOCOL_VERSION,
            assistant,
            visitorId: visitorId(),
            messageId: turn.messageId,
            value,
            ...(session ? { session } : {}),
          }),
        });
      try {
        const check = this.#checkRequired() ? await this.#sessionFor() : undefined;
        if (!isCurrent()) return;
        if (check?.ok === false) throw new Error("No visitor session");
        const configLoading = check ? null : this.#configLoading;
        let response = await send(check?.session);
        if (!isCurrent()) return;
        if (configLoading && response.status === 403) {
          const refusal = await response.json().catch(() => null);
          if (refusal?.code === "check_required") {
            const recovered = await this.#recoverVisitorSession(configLoading, isCurrent);
            if (!isCurrent()) return;
            if (recovered?.ok) response = await send(recovered.session);
          }
        }
        if (!isCurrent()) return;
        if (!response.ok) {
          throw new Error(`Feedback request failed with status ${response.status}`);
        }

        turn.feedback = value;
        upBtn.setAttribute("aria-pressed", value === "up" ? "true" : "false");
        downBtn.setAttribute("aria-pressed", value === "down" ? "true" : "false");
        ack.textContent = "Thanks for the feedback.";
        this.#persist();
      } catch {
        if (!isCurrent()) return;
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
      ? RESPONSE_INTERRUPTED
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
    this.#moveTypingLast(bubble, indicator);
    this.#scrollToBottom();
  }

  #keepTypingLast(bubble: HTMLDivElement): void {
    const indicator = bubble.querySelector<HTMLDivElement>(".solv-typing");
    if (indicator) this.#moveTypingLast(bubble, indicator);
  }

  /**
   * Moves the indicator to the end of `bubble`. A node moved inside a live
   * region is added again, and would be read out again, so the label it was
   * announced with is dropped first and the dots move alone.
   */
  #moveTypingLast(bubble: HTMLDivElement, indicator: HTMLDivElement): void {
    if (bubble.lastElementChild === indicator) return;
    if (indicator.parentNode === bubble) indicator.querySelector(".sr-only")?.remove();
    bubble.append(indicator);
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

  #sessionFor(): Promise<CheckResult> {
    this.#interacted = true;
    return this.#check.ensure();
  }

  async #recoverVisitorSession(
    configLoading: Promise<void>,
    isCurrent: () => boolean,
  ): Promise<CheckResult | undefined> {
    if (!isCurrent()) return;
    // Give this refusal its own deadline. The config request can still finish
    // later and apply settings for future interactions.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CONFIG_RECOVERY_WAIT_MS);
    });
    try {
      await Promise.race([configLoading, deadline]);
    } finally {
      clearTimeout(timer);
    }
    if (isCurrent() && this.#checkRequired()) return this.#sessionFor();
  }

  async #send(
    message: string,
    onAccepted?: () => void,
    options?: WidgetSendOptions,
  ): Promise<WidgetSendResult | Error> {
    const assistant = this.#assistant();
    if (this.#sending)
      return new Error("Wait for the current reply before sending another message.");
    const trimmed = typeof message === "string" ? message.trim() : "";
    if (!trimmed) return new Error("Enter a message.");
    if (!assistant || !this.isConnected || this.#previewing || (!options && !this.#configReady)) {
      return new Error(ASSISTANT_UNAVAILABLE);
    }
    if (trimmed.length > MAX_CHAT_MESSAGE_LENGTH) {
      if (!options) this.#showInputError(MESSAGE_TOO_LONG);
      return new Error(MESSAGE_TOO_LONG);
    }

    // Reserve the turn before settings load or an open event reaches the host.
    const controller = new AbortController();
    this.#abortController = controller;
    this.#sending = true;
    this.#hostSend = options !== undefined;
    this.#sendBtn.disabled = true;

    try {
      if (options) {
        if (options.open) {
          await this.#openRequested({}, false);
        } else {
          await this.#waitForConfig(this.#loadConfig(), CONFIG_OPEN_WAIT_MS);
        }
        if (controller.signal.aborted) return new Error(RESPONSE_INTERRUPTED);
        if (this.#previewing || this.#configMissing || assistant !== this.#assistant()) {
          return new Error(ASSISTANT_UNAVAILABLE);
        }
        if (!this.#configReady) this.#applyConfig(DEFAULT_CONFIG);
      }
      return await this.#sendTurn(assistant, trimmed, controller, onAccepted);
    } catch {
      return new Error(CHAT_FAILED);
    } finally {
      if (this.#abortController === controller) {
        this.#abortController = null;
        this.#sending = false;
        this.#hostSend = false;
        this.#sendBtn.disabled = !this.#configReady;
      }
      if (this.#dismissedTurn === controller) {
        this.#dismissedTurn = null;
      }
    }
  }

  async #sendTurn(
    assistant: string,
    trimmed: string,
    controller: AbortController,
    onAccepted?: () => void,
  ): Promise<WidgetSendResult | Error> {
    this.#clearInputError();
    onAccepted?.();

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

    const { signal } = controller;

    try {
      if (pending) {
        // Best-effort notification: dispatch without awaiting so a stalled
        // reporting request or stream never blocks the visitor's new message.
        void this.#reportDroppedResume(pending, signal);
      }
      const requestBody: Record<string, unknown> = {
        // Sent on every request so the engine can refuse a version it does not
        // support instead of guessing what this widget means.
        protocol: CHAT_PROTOCOL_VERSION,
        assistant,
        visitorId: visitorId(),
        message: trimmed,
      };
      if (this.#conversationId !== null) {
        requestBody.conversationId = this.#conversationId;
      }
      if (location.href.startsWith("http://") || location.href.startsWith("https://")) {
        requestBody.pageUrl = location.href;
      }
      await this.#consumeStream(
        (session) => {
          const pageActions = listForRequest();
          return fetch(`${this.#endpoint()}/v1/chat`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ...requestBody,
              ...(session ? { session } : {}),
              // A site that registers no actions sends the phase 1 body.
              ...(pageActions.length > 0 ? { pageActions } : {}),
            }),
            signal,
          });
        },
        bubble,
        textEl,
        assistantTurn,
        controller,
        0,
      );
    } catch {
      if (!signal.aborted && !assistantTurn.error) {
        delete assistantTurn.awaiting;
        this.#markTurnInterrupted(bubble, assistantTurn);
      }
    } finally {
      this.#finishPaint(textEl);
      this.#hideTyping(bubble);
      if (!signal.aborted) this.#persist();
    }
    if (assistantTurn.error) return new Error(assistantTurn.error);
    if (signal.aborted || assistantTurn.awaiting?.length || !assistantTurn.messageId) {
      return new Error(RESPONSE_INTERRUPTED);
    }
    return { text: assistantTurn.text };
  }

  async *#chatEvents(
    send: (session?: string) => Promise<Response>,
    signal: AbortSignal,
  ): AsyncGenerator<ChatStreamEvent> {
    const assistant = this.#assistant();
    const endpoint = this.#endpoint();
    const isCurrent = () =>
      !signal.aborted &&
      !this.#previewing &&
      assistant === this.#assistant() &&
      endpoint === this.#endpoint();
    // The thinking indicator stays up while configuration or the check is needed.
    let check = this.#checkRequired() ? await this.#sessionFor() : undefined;
    let configLoading = check ? null : this.#configLoading;
    while (isCurrent()) {
      if (check?.ok === false) {
        yield { type: "error", message: check.message };
        return;
      }
      const response = await send(check?.session);
      if (!isCurrent()) return;
      if (!response.ok || !response.body) {
        yield { type: "error", message: CHAT_FAILED };
        return;
      }
      let refusalMessage: string | undefined;
      for await (const raw of readEventLines(response)) {
        if (!isCurrent()) return;
        const event = parseChatEventLine(raw.name, raw.data);
        // A newer engine can send event types this bundle has never heard of.
        if (event.type === "unknown") continue;
        if (configLoading && event.type === "error" && event.code === "check_required") {
          refusalMessage = event.message;
          break;
        }
        configLoading = null;
        if (event.type === "error" && event.code === "check_required") this.#check.clear();
        yield event;
      }
      if (!configLoading || refusalMessage === undefined) return;
      // This refusal precedes all chat work. A single retry is safe once
      // the delayed config and visitor session are available.
      check = await this.#recoverVisitorSession(configLoading, isCurrent);
      if (!isCurrent()) return;
      if (!check) {
        yield { type: "error", message: refusalMessage, configUnavailable: true };
        return;
      }
      configLoading = null;
    }
  }

  async #consumeStream(
    send: (session?: string) => Promise<Response>,
    bubble: HTMLDivElement,
    textEl: HTMLDivElement,
    assistantTurn: SavedTurn,
    controller: AbortController,
    depth: number,
    onAdmitted?: () => void,
  ): Promise<"config_unavailable" | undefined> {
    const { signal } = controller;
    if (signal.aborted) return;

    let terminated = false;
    let resumeEvent: {
      messageId: string;
      conversationId: string;
      awaitingActions: string[];
    } | null = null;
    const pendingActions: RunRequest[] = [];

    try {
      for await (const event of this.#chatEvents(send, signal)) {
        if (signal.aborted) break;
        if (onAdmitted && event.type !== "error") {
          onAdmitted();
          onAdmitted = undefined;
        }

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
          const msg = event.message.trim() || CHAT_FAILED;
          if (onAdmitted && event.configUnavailable) {
            // The refusal came before the engine could claim the saved
            // continuation. Show the error here and let a later page resume it.
            this.#setTurnError(bubble, assistantTurn, msg);
            return "config_unavailable";
          }
          delete assistantTurn.awaiting;
          // The engine will not take more in this conversation; the next
          // question starts a new one, as the message says.
          if (event.code === "conversation_cap") this.#conversationId = null;
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
    return undefined;
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
    const releasePending = () => {
      if (this.#pendingResume === pending) {
        this.#pendingResume = null;
        this.#persist();
      }
    };
    let keepPending = false;

    try {
      await this.#waitForConfig(this.#loadConfig(), CONFIG_RESUME_WAIT_MS);
      if (!this.isConnected || signal.aborted) return;
      if (!this.#configReady) this.#applyConfig(DEFAULT_CONFIG);
      if (this.#configLoading) {
        // Keep the turn recoverable across navigation if the fallback attempt
        // still needs to wait for configuration and a visitor session.
        this.#pendingResume = pending;
        this.#persist();
      }

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

      const outcome = await this.#consumeStream(
        (session) =>
          this.#sendActionResumeRequest(
            pending.conversationId,
            pending.resumeMessageId,
            actionResults,
            signal,
            session,
          ),
        target.bubble,
        target.textEl,
        target.turn,
        controller,
        pending.depth,
        releasePending,
      );
      keepPending = outcome === "config_unavailable";
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
        if (!keepPending) releasePending();
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

    await this.#consumeStream(
      (session) =>
        this.#sendActionResumeRequest(
          done.conversationId,
          done.messageId,
          results,
          signal,
          session,
        ),
      bubble,
      textEl,
      assistantTurn,
      controller,
      depth,
    );
  }
}

if (typeof customElements !== "undefined" && !customElements.get("solv-chat")) {
  customElements.define("solv-chat", SolvChat);
}
