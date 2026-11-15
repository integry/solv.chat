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
import { styles } from "./styles.js";

interface WidgetPublicConfig {
  title: string;
  accentColor: string;
  position: "left" | "right";
  greeting: string;
  suggestedQuestions: string[];
  actions: BuiltinSettings;
}

const DEFAULT_CONFIG: WidgetPublicConfig = {
  title: "Ask a question",
  accentColor: "#2563eb",
  position: "right",
  greeting: "Hello. Ask me anything about this site.",
  suggestedQuestions: [],
  actions: { enabled: false, allowedOrigins: [] },
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

  #launcher!: HTMLButtonElement;
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
    clearHighlight();
    setBeforeNavigate(null);
    setOnExternalNavigate(null);
    this.#pendingResume = null;
    this.#resumedBubble = null;
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

    header.append(title, closeBtn);

    const messages = document.createElement("div");
    messages.className = "solv-messages";
    messages.setAttribute("role", "log");
    messages.setAttribute("aria-live", "polite");
    messages.setAttribute("aria-relevant", "additions text");

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
    panel.append(header, messages, suggestions, inputError, form);

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
  }

  async #loadConfig(): Promise<void> {
    const assistant = this.#assistant();
    if (!assistant) return;
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
    // Registered after the config says so, and removed if it says not to.
    installBuiltins(this.#config.actions);
    this.#renderSuggestions();
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
    this.#persist();
    if (moveFocus) {
      this.#inputEl.focus();
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
    this.#persist();
    if (restoreFocus) {
      this.#launcher.focus();
    }
  }

  #restore(saved: {
    conversationId: string | null;
    open: boolean;
    turns: SavedTurn[];
    pendingResume?: PendingResume;
  }): void {
    this.#conversationId = saved.conversationId;
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
      if (restoredUnfinished) {
        this.#persist();
      }
    }
  }

  #snapshot(): SavedConversation {
    return {
      conversationId: this.#conversationId,
      open: this.#open,
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
    const handle = askToConfirm(this.#messagesEl, request, action, () => this.#inputEl.focus());
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
        const response = await fetch(`${this.#endpoint()}/v1/feedback`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            protocol: CHAT_PROTOCOL_VERSION,
            assistant: this.#assistant(),
            visitorId: visitorId(),
            messageId: turn.messageId,
            value,
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

  #scrollToBottom(): void {
    this.#messagesEl.scrollTop = this.#messagesEl.scrollHeight;
  }

  async #send(message: string, onAccepted?: () => void): Promise<void> {
    const assistant = this.#assistant();
    const trimmed = message.trim();
    if (!assistant || this.#sending || !trimmed) return;

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
          assistantTurn.text += event.text;
          renderMarkdown(textEl, assistantTurn.text);
          this.#scrollToBottom();
          this.#persist();
        } else if (event.type === "citation") {
          this.#appendCitation(bubble, assistantTurn, event.url, event.title);
          this.#persist();
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
          delete assistantTurn.awaiting;
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

      const response = await this.#sendActionResumeRequest(
        pending.conversationId,
        pending.resumeMessageId,
        actionResults,
        signal,
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
      const response = await this.#sendActionResumeRequest(
        pending.conversationId,
        pending.resumeMessageId,
        buildMovedOnResults(pending),
        controller.signal,
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

    const response = await this.#sendActionResumeRequest(
      done.conversationId,
      done.messageId,
      results,
      signal,
    );

    await this.#consumeStream(response, bubble, textEl, assistantTurn, controller, depth);
  }
}

if (typeof customElements !== "undefined" && !customElements.get("solv-chat")) {
  customElements.define("solv-chat", SolvChat);
}
