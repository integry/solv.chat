import { CHAT_PROTOCOL_VERSION } from "@solvchat/core";

/**
 * The visitor check: Cloudflare Turnstile, run in a frame served by the
 * engine's own origin, its token exchanged at `POST /v1/session` for a
 * signed visitor session the widget sends with every chat and feedback
 * request (see "Visitor check" in docs/architecture.md).
 *
 * Nothing loads until `start()` is called, which the element does on the
 * visitor's first focus or keystroke in the message input, or a click on a
 * suggested question. The frame and the page talk only by `postMessage`:
 * this side accepts a message only from the engine's origin and from the
 * frame's own window, and the frame posts only to this page's origin.
 */

export type CheckResult = { ok: true; session: string } | { ok: false; message: string };

export const CHECK_FAILED_MESSAGE =
  "The security check could not be completed. Check your connection, then try again.";

/** No word from the frame at all (blocked by the page's policy, say). */
export const CHECK_LOAD_TIMEOUT_MS = 15_000;
/** The frame loaded but Turnstile neither answered nor asked the visitor to act. */
export const CHECK_TOKEN_TIMEOUT_MS = 30_000;
/**
 * The whole `POST /v1/session` exchange, response body included. The engine
 * gives Siteverify 5 s, so 15 s leaves room for the network both ways and
 * still releases a waiting message when the request or its body stalls.
 */
export const CHECK_EXCHANGE_TIMEOUT_MS = 15_000;
/** A session this close to expiring is renewed before use rather than sent. */
export const SESSION_RENEW_MARGIN_MS = 60_000;

const STORAGE_PREFIX = "solv-chat-session:";

interface StoredSession {
  session: string;
  expiresAt: number;
  visitorId: string;
}

/** The in-memory copy also names its assistant; storage keys by it instead. */
interface HeldSession extends StoredSession {
  assistant: string;
}

export interface CheckControllerOptions {
  /** The element the frame and the notice live in, inside the panel. */
  host: HTMLElement;
  endpoint: () => string;
  assistant: () => string;
  visitorId: () => string;
  /** "light" or "dark", as the widget shows itself. */
  theme: () => "light" | "dark";
}

function originOf(endpoint: string): string {
  try {
    return new URL(endpoint, location.href).origin;
  } catch {
    return endpoint;
  }
}

export class CheckController {
  #opts: CheckControllerOptions;
  #pending: Promise<CheckResult> | null = null;
  #settle: ((result: CheckResult) => void) | null = null;
  #frame: HTMLIFrameElement | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #waiting = 0;
  #listening = false;
  /** Bumped whenever an attempt settles, so a late exchange cannot settle the next one. */
  #attempt = 0;
  #exchangeAbort: AbortController | null = null;
  /**
   * The last session issued, kept in memory too, so a page whose storage
   * throws (a browser policy, say) still serves the whole visit from one
   * check instead of starting another on every keystroke.
   */
  #held: HeldSession | null = null;

  constructor(opts: CheckControllerOptions) {
    this.#opts = opts;
  }

  /**
   * The stored session, or the one held in memory, when it is for this
   * assistant and visitor and still good for a while; otherwise null.
   */
  session(): string | null {
    const assistant = this.#opts.assistant();
    if (!assistant) return null;
    const good = (saved: Partial<StoredSession> | null): saved is StoredSession =>
      saved !== null &&
      typeof saved.session === "string" &&
      typeof saved.expiresAt === "number" &&
      saved.visitorId === this.#opts.visitorId() &&
      saved.expiresAt - Date.now() > SESSION_RENEW_MARGIN_MS;
    try {
      const raw = sessionStorage.getItem(STORAGE_PREFIX + assistant);
      const saved = raw ? (JSON.parse(raw) as Partial<StoredSession> | null) : null;
      if (good(saved)) return saved.session;
    } catch {
      // Storage unavailable or unreadable: fall back to the copy in memory.
    }
    const held = this.#held;
    return held !== null && held.assistant === assistant && good(held) ? held.session : null;
  }

  /** Forgets the session, stored and in memory, after the engine refused it. */
  clear(): void {
    this.#held = null;
    try {
      sessionStorage.removeItem(STORAGE_PREFIX + this.#opts.assistant());
    } catch {
      // Nothing stored.
    }
  }

  /** Starts the check if no good session is stored and none is running. */
  start(): void {
    void this.#run();
  }

  /**
   * A session for a request that is waiting on it. While this runs, a
   * failure is the caller's to show, not a notice of its own.
   */
  async ensure(): Promise<CheckResult> {
    this.#waiting += 1;
    try {
      return await this.#run();
    } finally {
      this.#waiting -= 1;
    }
  }

  /** Stops a running check and removes the frame (the element left the page). */
  destroy(): void {
    this.#finish({ ok: false, message: CHECK_FAILED_MESSAGE });
    if (this.#listening) {
      window.removeEventListener("message", this.#onMessage);
      this.#listening = false;
    }
  }

  #run(): Promise<CheckResult> {
    const stored = this.session();
    if (stored) return Promise.resolve({ ok: true, session: stored });
    if (this.#pending) return this.#pending;
    this.#pending = new Promise<CheckResult>((resolve) => {
      this.#settle = resolve;
    });
    this.#openFrame();
    return this.#pending;
  }

  #openFrame(): void {
    const { host } = this.#opts;
    host.replaceChildren();
    host.removeAttribute("data-state");
    if (!this.#listening) {
      window.addEventListener("message", this.#onMessage);
      this.#listening = true;
    }
    const theme = this.#opts.theme();
    const url = new URL("/v1/check/frame", originOf(this.#opts.endpoint()));
    url.searchParams.set("assistant", this.#opts.assistant());
    url.searchParams.set("parent", location.origin);
    url.searchParams.set("theme", theme);

    const note = document.createElement("p");
    note.className = "solv-check-note";
    note.id = "solv-check-note";
    note.textContent = "Please complete this quick security check.";

    const frame = document.createElement("iframe");
    frame.className = "solv-check-frame";
    frame.title = "Security check";
    frame.src = url.href;
    // Out of the tab order until Turnstile asks the visitor to act.
    frame.tabIndex = -1;
    frame.setAttribute("aria-describedby", "solv-check-note");
    // Matching the frame's scheme keeps its background transparent.
    frame.style.colorScheme = theme;
    host.append(note, frame);
    this.#frame = frame;
    this.#arm(CHECK_LOAD_TIMEOUT_MS);
  }

  #arm(ms: number | null): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = ms === null ? null : setTimeout(() => this.#fail(CHECK_FAILED_MESSAGE), ms);
  }

  #onMessage = (event: MessageEvent): void => {
    const frame = this.#frame;
    // Both checks: the origin proves who sent it, the source that it is our frame.
    if (frame === null || event.source !== frame.contentWindow) return;
    if (event.origin !== originOf(this.#opts.endpoint())) return;
    const data = event.data as { solvCheck?: unknown; type?: unknown; token?: unknown } | null;
    if (typeof data !== "object" || data === null || data.solvCheck !== 1) return;
    switch (data.type) {
      case "ready":
        this.#arm(CHECK_TOKEN_TIMEOUT_MS);
        break;
      case "interactive":
        // The visitor has to act: no deadline but Turnstile's own.
        this.#arm(null);
        this.#opts.host.setAttribute("data-state", "interactive");
        frame.tabIndex = 0;
        break;
      case "settled":
        this.#opts.host.removeAttribute("data-state");
        frame.tabIndex = -1;
        this.#arm(CHECK_TOKEN_TIMEOUT_MS);
        break;
      case "token":
        if (typeof data.token === "string" && data.token.length > 0) {
          this.#arm(null);
          void this.#exchange(data.token);
        }
        break;
      case "error":
        this.#fail(CHECK_FAILED_MESSAGE);
        break;
    }
  };

  async #exchange(token: string): Promise<void> {
    // The frame's work is done; the token is spent by the exchange either way.
    this.#removeFrame();
    const attempt = this.#attempt;
    const live = () => attempt === this.#attempt;
    const abort = new AbortController();
    this.#exchangeAbort = abort;
    // A deadline for the request and its body: on expiry `#fail` settles the
    // check and `#finish` aborts the request.
    this.#arm(CHECK_EXCHANGE_TIMEOUT_MS);
    try {
      // The session is for the assistant and visitor it was asked for.
      const assistant = this.#opts.assistant();
      const visitorId = this.#opts.visitorId();
      const response = await fetch(`${this.#opts.endpoint()}/v1/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocol: CHAT_PROTOCOL_VERSION,
          assistant,
          visitorId,
          token,
        }),
        signal: abort.signal,
      });
      if (!live()) return;
      const body = (await response.json().catch(() => null)) as {
        session?: unknown;
        expiresAt?: unknown;
        error?: unknown;
      } | null;
      if (!live()) return;
      if (
        response.ok &&
        body !== null &&
        typeof body.session === "string" &&
        typeof body.expiresAt === "number"
      ) {
        const saved: StoredSession = {
          session: body.session,
          expiresAt: body.expiresAt,
          visitorId,
        };
        this.#held = { ...saved, assistant };
        try {
          sessionStorage.setItem(STORAGE_PREFIX + assistant, JSON.stringify(saved));
        } catch {
          // Storage refused: the copy in memory serves this page.
        }
        this.#finish({ ok: true, session: body.session });
        return;
      }
      this.#fail(
        typeof body?.error === "string" && body.error.trim() ? body.error : CHECK_FAILED_MESSAGE,
      );
    } catch {
      if (live()) this.#fail(CHECK_FAILED_MESSAGE);
    }
  }

  #removeFrame(): void {
    this.#frame?.remove();
    this.#frame = null;
    this.#opts.host.removeAttribute("data-state");
    this.#opts.host.replaceChildren();
  }

  #fail(message: string): void {
    const waiting = this.#waiting > 0;
    this.#finish({ ok: false, message });
    // With no message waiting, the visitor still needs to hear it and how to retry.
    if (!waiting) this.#showFailure(message);
  }

  #showFailure(message: string): void {
    const { host } = this.#opts;
    const notice = document.createElement("div");
    notice.className = "solv-check-failed";
    notice.setAttribute("role", "alert");
    const text = document.createElement("span");
    text.textContent = message;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "solv-fb-btn";
    retry.textContent = "Try again";
    retry.addEventListener("click", () => this.start());
    notice.append(text, retry);
    host.replaceChildren(notice);
    host.setAttribute("data-state", "failed");
  }

  #finish(result: CheckResult): void {
    this.#attempt += 1;
    this.#arm(null);
    const abort = this.#exchangeAbort;
    this.#exchangeAbort = null;
    abort?.abort();
    this.#removeFrame();
    const settle = this.#settle;
    this.#settle = null;
    this.#pending = null;
    settle?.(result);
  }
}
