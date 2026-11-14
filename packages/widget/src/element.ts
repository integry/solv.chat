import { CHAT_PROTOCOL_VERSION, parseChatEventLine } from "@solvchat/core";
import { readEventLines } from "./sse.js";
import { loadConversation, type SavedTurn, saveConversation, visitorId } from "./storage.js";
import { styles } from "./styles.js";

interface WidgetPublicConfig {
  title: string;
  accentColor: string;
  position: "left" | "right";
  greeting: string;
  suggestedQuestions: string[];
}

const DEFAULT_CONFIG: WidgetPublicConfig = {
  title: "Ask a question",
  accentColor: "#2563eb",
  position: "right",
  greeting: "Hello. Ask me anything about this site.",
  suggestedQuestions: [],
};

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

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

function parsePublicConfig(raw: unknown): Partial<WidgetPublicConfig> {
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
  return out;
}

/**
 * The `<solv-chat>` custom element. Renders a Shadow DOM chat launcher and
 * dialog panel with streaming SSE responses, citations, feedback, and
 * sessionStorage conversation restore.
 */
export class SolvChat extends HTMLElement {
  #root = this.attachShadow({ mode: "open" });
  #initialized = false;
  #open = false;
  #sending = false;
  #conversationId: string | null = null;
  #turns: SavedTurn[] = [];
  #config: WidgetPublicConfig = { ...DEFAULT_CONFIG };

  #launcher!: HTMLButtonElement;
  #panel!: HTMLDivElement;
  #titleEl!: HTMLHeadingElement;
  #messagesEl!: HTMLDivElement;
  #greetingEl!: HTMLDivElement;
  #suggestionsEl!: HTMLDivElement;
  #inputEl!: HTMLTextAreaElement;
  #sendBtn!: HTMLButtonElement;

  connectedCallback(): void {
    if (!this.#initialized) {
      this.#root.adoptedStyleSheets = [styles];
      this.#renderShell();
      this.#initialized = true;
    }

    const saved = loadConversation(this.#assistant());
    if (saved !== null) {
      this.#restore(saved);
    }

    void this.#loadConfig();
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
    input.addEventListener("keydown", (event) => {
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
      const text = this.#inputEl.value.trim();
      if (!text || this.#sending) return;
      this.#inputEl.value = "";
      void this.#send(text);
    });

    form.append(label, input, sendBtn);
    panel.append(header, messages, suggestions, form);

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
    this.#open = false;
    this.#panel.hidden = true;
    this.#launcher.setAttribute("aria-expanded", "false");
    this.#launcher.setAttribute("aria-label", "Open chat");
    this.#persist();
    if (restoreFocus) {
      this.#launcher.focus();
    }
  }

  #restore(saved: { conversationId: string | null; open: boolean; turns: SavedTurn[] }): void {
    this.#conversationId = saved.conversationId;
    this.#turns = saved.turns.map((turn) => ({
      ...turn,
      ...(turn.citations ? { citations: [...turn.citations] } : {}),
    }));

    this.#messagesEl.replaceChildren(this.#greetingEl);
    for (const turn of this.#turns) {
      const { bubble, textEl } = this.#appendBubble(turn.role);
      textEl.textContent = turn.text;
      if (turn.role === "assistant") {
        if (turn.citations) {
          for (const citation of turn.citations) {
            this.#appendCitationLink(bubble, citation.url, citation.title);
          }
        }
        if (turn.messageId) {
          this.#appendFeedbackControls(bubble, turn);
        }
      }
    }
    this.#renderSuggestions();

    if (saved.open) {
      this.#openPanel(false);
    }
  }

  #persist(): void {
    saveConversation(this.#assistant(), {
      conversationId: this.#conversationId,
      open: this.#open,
      turns: this.#turns,
    });
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
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    // Scheme allow-list: a citation URL ultimately comes from pushed content,
    // so `javascript:` or `data:` must never reach an href.
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
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

  #scrollToBottom(): void {
    this.#messagesEl.scrollTop = this.#messagesEl.scrollHeight;
  }

  async #send(message: string): Promise<void> {
    const assistant = this.#assistant();
    if (!assistant) return;

    this.#sending = true;
    this.#sendBtn.disabled = true;

    const userTurn: SavedTurn = { role: "user", text: message };
    this.#turns.push(userTurn);
    const userBubble = this.#appendBubble("user");
    userBubble.textEl.textContent = message;
    this.#renderSuggestions();

    const assistantTurn: SavedTurn = { role: "assistant", text: "" };
    this.#turns.push(assistantTurn);
    const { bubble, textEl } = this.#appendBubble("assistant");
    this.#persist();

    try {
      const requestBody: Record<string, unknown> = {
        // Sent on every request so the engine can refuse a version it does not
        // support instead of guessing what this widget means.
        protocol: CHAT_PROTOCOL_VERSION,
        assistant,
        visitorId: visitorId(),
        message,
      };
      if (this.#conversationId !== null) {
        requestBody.conversationId = this.#conversationId;
      }
      if (location.href.startsWith("http://") || location.href.startsWith("https://")) {
        requestBody.pageUrl = location.href;
      }

      const response = await fetch(`${this.#endpoint()}/v1/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok || !response.body) {
        const msg = "Something went wrong. Please try again.";
        assistantTurn.text = msg;
        textEl.textContent = msg;
        return;
      }

      for await (const raw of readEventLines(response)) {
        const event = parseChatEventLine(raw.name, raw.data);
        // Unknown types are skipped, not an error: a newer engine will send event
        // types this cached bundle has never heard of, and the only acceptable
        // behaviour is to keep rendering the ones it knows.
        if (event.type === "unknown") continue;

        if (event.type === "token") {
          // textContent, never innerHTML: the text comes from a model that can be
          // talked into emitting markup, and a chat bubble is the last place that
          // should execute anything.
          assistantTurn.text += event.text;
          textEl.textContent = assistantTurn.text;
          this.#scrollToBottom();
        } else if (event.type === "citation") {
          this.#appendCitation(bubble, assistantTurn, event.url, event.title);
        } else if (event.type === "done") {
          this.#conversationId = event.conversationId;
          assistantTurn.messageId = event.messageId;
          this.#appendFeedbackControls(bubble, assistantTurn);
          this.#persist();
        } else if (event.type === "error") {
          if (!assistantTurn.text) {
            assistantTurn.text = event.message;
            textEl.textContent = event.message;
          }
        }
      }
    } catch {
      if (!assistantTurn.text) {
        const msg = "Unable to reach the assistant. Please try again.";
        assistantTurn.text = msg;
        textEl.textContent = msg;
      }
    } finally {
      this.#sending = false;
      this.#sendBtn.disabled = false;
      this.#persist();
    }
  }
}

if (typeof customElements !== "undefined" && !customElements.get("solv-chat")) {
  customElements.define("solv-chat", SolvChat);
}
