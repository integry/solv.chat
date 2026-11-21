/**
 * The check frame is never loaded here: happy-dom does not navigate child
 * frames, and the frame's messages are played by the test, from the
 * frame's own window and the engine's origin, as the real frame sends them.
 * @vitest-environment-options {"settings": {"navigation": {"disableChildFrameNavigation": true}}}
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECK_EXCHANGE_TIMEOUT_MS, CHECK_LOAD_TIMEOUT_MS } from "../src/check.js";
import "../src/widget.js";
import { mountWithIntent } from "./support/intent.js";

const ENGINE = location.origin;

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function mustQuery<T extends Element>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element: ${selector}`);
  return el;
}

interface Recorded {
  url: string;
  body: Record<string, unknown> | null;
}

/** An engine with the visitor check on: config says so, `/v1/session` exchanges a token. */
function fakeEngine(
  options: {
    config?: Record<string, unknown>;
    sessionStatus?: number;
    /** Answers `/v1/session` instead of the default, for stalled or late exchanges. */
    session?: (init: RequestInit | undefined) => Promise<Response>;
  } = {},
) {
  const requests: Recorded[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    requests.push({ url, body });
    if (url.includes("/v1/assistants/")) {
      return Response.json({
        title: "Docs",
        suggestedQuestions: ["How do I start?"],
        visitorCheck: true,
        ...options.config,
      });
    }
    if (url.endsWith("/v1/session")) {
      if (options.session) return options.session(init);
      if (options.sessionStatus && options.sessionStatus !== 200) {
        return Response.json(
          {
            error: "The security check could not be completed. Please try again.",
            code: "check_failed",
          },
          { status: options.sessionStatus },
        );
      }
      return Response.json({ session: "vs1.session-for-test", expiresAt: Date.now() + 3_600_000 });
    }
    if (url.endsWith("/v1/chat")) {
      return new Response(
        sseStream([
          'event: token\ndata: {"text":"Answer"}\n\n',
          'event: done\ndata: {"messageId":"msg_1","conversationId":"cnv_1"}\n\n',
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }
    return new Response("Not found", { status: 404 });
  }) as typeof fetch;
  return requests;
}

function mount() {
  const el = document.createElement("solv-chat");
  el.setAttribute("assistant", "pk_test_check");
  mountWithIntent(el);
  const root = el.shadowRoot;
  if (!root) throw new Error("no shadow root");
  return { el, root };
}

/** Plays a message from the check frame. */
function fromFrame(
  frame: HTMLIFrameElement,
  data: Record<string, unknown>,
  overrides: { origin?: string; source?: unknown } = {},
) {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { solvCheck: 1, ...data },
      origin: overrides.origin ?? ENGINE,
      source: (overrides.source ?? frame.contentWindow) as Window,
    }),
  );
}

describe("visitor check in the widget", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    document.body.replaceChildren();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("requests nothing from Turnstile or the frame until the first focus or keystroke", async () => {
    const requests = fakeEngine();
    const { root } = mount();
    await flushAsync();
    // Opening the panel moves focus into the input by itself: still nothing.
    mustQuery<HTMLButtonElement>(root, ".solv-launcher").click();
    await flushAsync();
    expect(root.querySelector("iframe")).toBeNull();
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual(["/v1/assistants/pk_test_check"]);
    for (const r of requests) expect(r.url).not.toContain("challenges.cloudflare.com");

    // The visitor's own keystroke starts it.
    const input = mustQuery<HTMLTextAreaElement>(root, "#solv-input");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "H", bubbles: true }));
    const frame = mustQuery<HTMLIFrameElement>(root, ".solv-check iframe");
    const src = new URL(frame.src);
    expect(src.origin).toBe(ENGINE);
    expect(src.pathname).toBe("/v1/check/frame");
    expect(src.searchParams.get("assistant")).toBe("pk_test_check");
    expect(src.searchParams.get("parent")).toBe(location.origin);
    expect(["light", "dark"]).toContain(src.searchParams.get("theme"));
    // Created inside the collapsed check area: nothing moves.
    expect(frame.closest(".solv-check")?.hasAttribute("data-state")).toBe(false);
    expect(frame.tabIndex).toBe(-1);
  });

  it("starts on a real focus of the input", async () => {
    fakeEngine();
    const { root } = mount();
    await flushAsync();
    mustQuery<HTMLTextAreaElement>(root, "#solv-input").dispatchEvent(new FocusEvent("focus"));
    expect(root.querySelector(".solv-check iframe")).not.toBeNull();
  });

  it("delivers a message sent while the check runs once it completes", async () => {
    const requests = fakeEngine();
    const { root } = mount();
    await flushAsync();
    mustQuery<HTMLButtonElement>(root, ".solv-launcher").click();
    const input = mustQuery<HTMLTextAreaElement>(root, "#solv-input");
    input.dispatchEvent(new FocusEvent("focus"));
    const frame = mustQuery<HTMLIFrameElement>(root, ".solv-check iframe");

    input.value = "How do I start?";
    mustQuery<HTMLFormElement>(root, ".solv-form").requestSubmit();
    await flushAsync();
    // Waiting in the empty "thinking" bubble, not sent, not lost.
    expect(requests.some((r) => r.url.endsWith("/v1/chat"))).toBe(false);
    const bubbles = root.querySelectorAll(".solv-bubble--assistant");
    expect(bubbles.length).toBe(2);
    expect(root.querySelector(".solv-bubble-error")).toBeNull();

    fromFrame(frame, { type: "ready" });
    fromFrame(frame, { type: "token", token: "XXXX.DUMMY.TOKEN.XXXX" });
    await flushAsync();

    const exchange = requests.find((r) => r.url.endsWith("/v1/session"));
    expect(exchange?.body).toMatchObject({
      assistant: "pk_test_check",
      token: "XXXX.DUMMY.TOKEN.XXXX",
    });
    const chat = requests.find((r) => r.url.endsWith("/v1/chat"));
    expect(chat?.body).toMatchObject({
      message: "How do I start?",
      session: "vs1.session-for-test",
    });
    expect(root.textContent).toContain("Answer");
    // The frame is gone once the token is used.
    expect(root.querySelector(".solv-check iframe")).toBeNull();

    // The next message reuses the session: no second check.
    input.value = "And then?";
    mustQuery<HTMLFormElement>(root, ".solv-form").requestSubmit();
    await flushAsync();
    expect(requests.filter((r) => r.url.endsWith("/v1/session"))).toHaveLength(1);
    expect(requests.filter((r) => r.url.endsWith("/v1/chat"))).toHaveLength(2);
  });

  describe("when the page blocks sessionStorage", () => {
    let restore: (() => void) | null = null;

    beforeEach(() => {
      // A browser policy that blocks storage throws on access to it.
      const owner = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage")
        ? globalThis
        : Object.getPrototypeOf(globalThis);
      const original = Object.getOwnPropertyDescriptor(owner, "sessionStorage");
      Object.defineProperty(globalThis, "sessionStorage", {
        configurable: true,
        get() {
          throw new DOMException("The operation is insecure.", "SecurityError");
        },
      });
      restore = () => {
        if (owner === globalThis && original) {
          Object.defineProperty(globalThis, "sessionStorage", original);
        } else {
          delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
        }
      };
    });

    afterEach(() => {
      restore?.();
      restore = null;
    });

    it("keeps a session from a focus-started check for the visit", async () => {
      expect(() => sessionStorage.getItem("x")).toThrow();
      const requests = fakeEngine();
      const { root } = mount();
      await flushAsync();
      mustQuery<HTMLButtonElement>(root, ".solv-launcher").click();
      const input = mustQuery<HTMLTextAreaElement>(root, "#solv-input");
      input.dispatchEvent(new FocusEvent("focus"));
      const frame = mustQuery<HTMLIFrameElement>(root, ".solv-check iframe");
      fromFrame(frame, { type: "ready" });
      fromFrame(frame, { type: "token", token: "XXXX.DUMMY.TOKEN.XXXX" });
      await flushAsync();
      expect(requests.filter((r) => r.url.endsWith("/v1/session"))).toHaveLength(1);

      // Typing does not start another check.
      for (const key of ["H", "i", "!"]) {
        input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      }
      await flushAsync();
      expect(root.querySelector(".solv-check iframe")).toBeNull();

      // Both messages go out with the one session.
      for (const text of ["How do I start?", "And then?"]) {
        input.value = text;
        mustQuery<HTMLFormElement>(root, ".solv-form").requestSubmit();
        await flushAsync();
      }
      expect(root.querySelector(".solv-check iframe")).toBeNull();
      expect(requests.filter((r) => r.url.endsWith("/v1/session"))).toHaveLength(1);
      const chats = requests.filter((r) => r.url.endsWith("/v1/chat"));
      expect(chats.map((r) => r.body?.session)).toEqual([
        "vs1.session-for-test",
        "vs1.session-for-test",
      ]);
    });

    it("forgets the in-memory session when the engine refuses it, and when it nears expiry", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const requests: Recorded[] = [];
      let chatReply = "";
      let issued = 0;
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        requests.push({
          url,
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        if (url.includes("/v1/assistants/")) return Response.json({ visitorCheck: true });
        if (url.endsWith("/v1/session")) {
          issued += 1;
          return Response.json({
            session: `vs1.s${issued}`,
            expiresAt: Date.now() + 3_600_000,
          });
        }
        return new Response(sseStream([chatReply]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }) as typeof fetch;
      const { root } = mount();
      await flushAsync();
      mustQuery<HTMLButtonElement>(root, ".solv-launcher").click();
      const input = mustQuery<HTMLTextAreaElement>(root, "#solv-input");
      const send = async (text: string) => {
        input.value = text;
        mustQuery<HTMLFormElement>(root, ".solv-form").requestSubmit();
        await flushAsync();
        const frame = root.querySelector<HTMLIFrameElement>(".solv-check iframe");
        if (frame) fromFrame(frame, { type: "token", token: `t-${text}` });
        await flushAsync();
      };
      const done = (n: number) =>
        `event: done\ndata: {"messageId":"m${n}","conversationId":"cnv_1"}\n\n`;
      chatReply = done(1);
      await send("one");
      chatReply =
        'event: error\ndata: {"message":"The security check has expired. Please send your message again.","code":"check_required"}\n\n';
      await send("two");
      chatReply = done(3);
      await send("three");
      // Close to expiry, the held session is renewed rather than sent.
      vi.setSystemTime(Date.now() + 3_600_000 - 30_000);
      chatReply = done(4);
      await send("four");
      const sessions = requests
        .filter((r) => r.url.endsWith("/v1/chat"))
        .map((r) => r.body?.session);
      expect(sessions).toEqual(["vs1.s1", "vs1.s1", "vs1.s2", "vs1.s3"]);
    });
  });

  it("starts the check when a suggested question is clicked, and sends it after", async () => {
    const requests = fakeEngine();
    const { root } = mount();
    await flushAsync();
    mustQuery<HTMLButtonElement>(root, ".solv-launcher").click();
    mustQuery<HTMLButtonElement>(root, ".solv-chip").click();
    const frame = mustQuery<HTMLIFrameElement>(root, ".solv-check iframe");
    fromFrame(frame, { type: "token", token: "tok" });
    await flushAsync();
    expect(requests.find((r) => r.url.endsWith("/v1/chat"))?.body).toMatchObject({
      message: "How do I start?",
      session: "vs1.session-for-test",
    });
  });

  it("ignores postMessage from any other origin or window", async () => {
    const requests = fakeEngine();
    const { root } = mount();
    await flushAsync();
    mustQuery<HTMLTextAreaElement>(root, "#solv-input").dispatchEvent(new FocusEvent("focus"));
    const frame = mustQuery<HTMLIFrameElement>(root, ".solv-check iframe");

    fromFrame(frame, { type: "token", token: "forged" }, { origin: "https://evil.example" });
    fromFrame(frame, { type: "token", token: "forged" }, { source: window });
    fromFrame(frame, { type: "interactive" }, { origin: "https://evil.example" });
    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "token", token: "x" }, origin: ENGINE }),
    );
    await flushAsync();
    expect(requests.some((r) => r.url.endsWith("/v1/session"))).toBe(false);
    expect(frame.closest(".solv-check")?.hasAttribute("data-state")).toBe(false);
    expect(root.querySelector(".solv-check iframe")).toBe(frame);
  });

  it("shows an interactive challenge inside the panel, reachable by keyboard", async () => {
    fakeEngine();
    const { root } = mount();
    await flushAsync();
    mustQuery<HTMLButtonElement>(root, ".solv-launcher").click();
    mustQuery<HTMLTextAreaElement>(root, "#solv-input").dispatchEvent(new FocusEvent("focus"));
    const frame = mustQuery<HTMLIFrameElement>(root, ".solv-check iframe");
    fromFrame(frame, { type: "ready" });
    fromFrame(frame, { type: "interactive" });
    const host = mustQuery<HTMLDivElement>(root, ".solv-check");
    expect(host.getAttribute("data-state")).toBe("interactive");
    expect(host.closest(".solv-panel")).not.toBeNull();
    expect(frame.tabIndex).toBe(0);
    expect(mustQuery(root, ".solv-check-note").textContent).toBe(
      "Please complete this quick security check.",
    );
    fromFrame(frame, { type: "settled" });
    expect(host.hasAttribute("data-state")).toBe(false);
  });

  it("waits for the visitor check before sending from the host page", async () => {
    const requests = fakeEngine();
    const { el, root } = mount();
    const answer = el.send("My question");
    const frame = await vi.waitFor(() => mustQuery<HTMLIFrameElement>(root, ".solv-check iframe"));
    const panel = mustQuery<HTMLElement>(root, ".solv-panel");
    expect(panel.hidden).toBe(true);
    expect(requests.some((r) => r.url.endsWith("/v1/chat"))).toBe(false);
    fromFrame(frame, { type: "interactive" });
    expect(panel.hidden).toBe(false);
    fromFrame(frame, { type: "token", token: "test-token" });
    await expect(answer).resolves.toEqual({ text: "Answer" });
    expect(requests.find((r) => r.url.endsWith("/v1/chat"))?.body).toMatchObject({
      message: "My question",
      session: "vs1.session-for-test",
    });
  });

  it("gives no answer and says how to retry when the check fails", async () => {
    const requests = fakeEngine();
    const { root } = mount();
    await flushAsync();
    mustQuery<HTMLButtonElement>(root, ".solv-launcher").click();
    const input = mustQuery<HTMLTextAreaElement>(root, "#solv-input");
    input.dispatchEvent(new FocusEvent("focus"));
    let frame = mustQuery<HTMLIFrameElement>(root, ".solv-check iframe");

    // Failing with no message waiting: a notice in the panel with a retry.
    fromFrame(frame, { type: "error", code: "600010" });
    await flushAsync();
    const notice = mustQuery<HTMLDivElement>(root, ".solv-check-failed");
    expect(notice.getAttribute("role")).toBe("alert");
    expect(notice.textContent).toContain("The security check could not be completed.");
    mustQuery<HTMLButtonElement>(notice, "button").click();
    frame = mustQuery<HTMLIFrameElement>(root, ".solv-check iframe");

    // Failing while a message waits: its bubble says so, and nothing is sent.
    input.value = "Hello?";
    mustQuery<HTMLFormElement>(root, ".solv-form").requestSubmit();
    await flushAsync();
    fromFrame(frame, { type: "error", code: "600010" });
    await flushAsync();
    expect(mustQuery(root, ".solv-bubble-error").textContent).toBe(
      "The security check could not be completed. Check your connection, then try again.",
    );
    expect(requests.some((r) => r.url.endsWith("/v1/chat"))).toBe(false);
    expect(root.querySelector(".solv-check-failed")).toBeNull();
  });

  it("fails, rather than waits forever, when the frame never loads", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const requests = fakeEngine();
    const { root } = mount();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(requests.length).toBe(1));
    mustQuery<HTMLButtonElement>(root, ".solv-launcher").click();
    const input = mustQuery<HTMLTextAreaElement>(root, "#solv-input");
    input.value = "Hello?";
    mustQuery<HTMLFormElement>(root, ".solv-form").requestSubmit();
    await vi.advanceTimersByTimeAsync(CHECK_LOAD_TIMEOUT_MS + 10);
    expect(mustQuery(root, ".solv-bubble-error").textContent).toContain(
      "The security check could not be completed.",
    );
    expect(requests.some((r) => r.url.endsWith("/v1/chat"))).toBe(false);
  });

  describe("a stalled session exchange", () => {
    /** Opens the panel, waits a message on the check and hands the frame a token. */
    async function sendWithToken(root: ShadowRoot) {
      mustQuery<HTMLButtonElement>(root, ".solv-launcher").click();
      const input = mustQuery<HTMLTextAreaElement>(root, "#solv-input");
      input.dispatchEvent(new FocusEvent("focus"));
      const frame = mustQuery<HTMLIFrameElement>(root, ".solv-check iframe");
      fromFrame(frame, { type: "ready" });
      input.value = "Hello?";
      mustQuery<HTMLFormElement>(root, ".solv-form").requestSubmit();
      fromFrame(frame, { type: "token", token: "XXXX.DUMMY.TOKEN.XXXX" });
      await vi.advanceTimersByTimeAsync(0);
    }

    it("fails the waiting message and aborts the request when the exchange never answers", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let signal: AbortSignal | undefined;
      const requests = fakeEngine({
        session: (init) => {
          signal = init?.signal ?? undefined;
          return new Promise<Response>(() => {});
        },
      });
      const { root } = mount();
      await vi.advanceTimersByTimeAsync(0);
      await sendWithToken(root);
      expect(signal?.aborted).toBe(false);
      expect(root.querySelector(".solv-bubble-error")).toBeNull();

      await vi.advanceTimersByTimeAsync(CHECK_EXCHANGE_TIMEOUT_MS + 10);
      expect(mustQuery(root, ".solv-bubble-error").textContent).toBe(
        "The security check could not be completed. Check your connection, then try again.",
      );
      expect(signal?.aborted).toBe(true);
      expect(requests.some((r) => r.url.endsWith("/v1/chat"))).toBe(false);
    });

    it("fails the waiting message when the response body never arrives", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const requests = fakeEngine({
        // Headers arrive; the body stream never sends a byte or closes.
        session: async () =>
          new Response(new ReadableStream<Uint8Array>({ start() {} }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      });
      const { root } = mount();
      await vi.advanceTimersByTimeAsync(0);
      await sendWithToken(root);
      expect(root.querySelector(".solv-bubble-error")).toBeNull();

      await vi.advanceTimersByTimeAsync(CHECK_EXCHANGE_TIMEOUT_MS + 10);
      expect(mustQuery(root, ".solv-bubble-error").textContent).toContain(
        "The security check could not be completed.",
      );
      expect(requests.some((r) => r.url.endsWith("/v1/chat"))).toBe(false);
    });

    it("does not let a late answer to a timed-out exchange settle the retry", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const late: Array<(response: Response) => void> = [];
      const requests = fakeEngine({
        // Ignores the abort, as a response already in flight might.
        session: () => new Promise<Response>((resolve) => late.push(resolve)),
      });
      const { root } = mount();
      await vi.advanceTimersByTimeAsync(0);
      mustQuery<HTMLButtonElement>(root, ".solv-launcher").click();
      const input = mustQuery<HTMLTextAreaElement>(root, "#solv-input");
      input.dispatchEvent(new FocusEvent("focus"));
      let frame = mustQuery<HTMLIFrameElement>(root, ".solv-check iframe");
      fromFrame(frame, { type: "ready" });
      fromFrame(frame, { type: "token", token: "token-1" });
      await vi.advanceTimersByTimeAsync(CHECK_EXCHANGE_TIMEOUT_MS + 10);
      // No message waited, so the notice offers a retry; it opens a new frame.
      mustQuery<HTMLButtonElement>(root, ".solv-check-failed button").click();
      frame = mustQuery<HTMLIFrameElement>(root, ".solv-check iframe");

      // The first exchange answers now: it must not end the retry or store a session.
      late[0]?.(Response.json({ session: "vs1.late", expiresAt: Date.now() + 3_600_000 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(root.querySelector(".solv-check iframe")).toBe(frame);
      expect(sessionStorage.getItem("solv-chat-session:pk_test_check")).toBeNull();

      // The retry's own token still completes it, and the message goes out with that session.
      input.value = "Hello?";
      mustQuery<HTMLFormElement>(root, ".solv-form").requestSubmit();
      fromFrame(frame, { type: "ready" });
      fromFrame(frame, { type: "token", token: "token-2" });
      await vi.advanceTimersByTimeAsync(0);
      late[1]?.(Response.json({ session: "vs1.retry", expiresAt: Date.now() + 3_600_000 }));
      await vi.waitFor(() =>
        expect(requests.find((r) => r.url.endsWith("/v1/chat"))?.body?.session).toBe("vs1.retry"),
      );
    });
  });

  it("shows the engine's refusal of the token and sends nothing", async () => {
    const requests = fakeEngine({ sessionStatus: 403 });
    const { root } = mount();
    await flushAsync();
    mustQuery<HTMLButtonElement>(root, ".solv-launcher").click();
    const input = mustQuery<HTMLTextAreaElement>(root, "#solv-input");
    input.dispatchEvent(new FocusEvent("focus"));
    const frame = mustQuery<HTMLIFrameElement>(root, ".solv-check iframe");
    input.value = "Hello?";
    mustQuery<HTMLFormElement>(root, ".solv-form").requestSubmit();
    fromFrame(frame, { type: "token", token: "XXXX.DUMMY.TOKEN.XXXX" });
    await flushAsync();
    expect(mustQuery(root, ".solv-bubble-error").textContent).toBe(
      "The security check could not be completed. Please try again.",
    );
    expect(requests.some((r) => r.url.endsWith("/v1/chat"))).toBe(false);
  });

  it("does nothing new when the engine runs no check", async () => {
    const requests = fakeEngine({ config: { visitorCheck: undefined } });
    const { root } = mount();
    await flushAsync();
    mustQuery<HTMLButtonElement>(root, ".solv-launcher").click();
    const input = mustQuery<HTMLTextAreaElement>(root, "#solv-input");
    input.dispatchEvent(new FocusEvent("focus"));
    input.value = "Hello?";
    mustQuery<HTMLFormElement>(root, ".solv-form").requestSubmit();
    await flushAsync();
    expect(root.querySelector("iframe")).toBeNull();
    const chat = requests.find((r) => r.url.endsWith("/v1/chat"));
    expect(chat?.body).not.toHaveProperty("session");
    expect(requests.some((r) => r.url.endsWith("/v1/session"))).toBe(false);
  });

  it("forgets a refused session and a full conversation", async () => {
    const requests: Recorded[] = [];
    const replies = [
      'event: done\ndata: {"messageId":"m1","conversationId":"cnv_1"}\n\n',
      'event: error\ndata: {"message":"The security check has expired. Please send your message again.","code":"check_required"}\n\n',
      'event: error\ndata: {"message":"This conversation has reached its limit. Your next question starts a new one.","code":"conversation_cap"}\n\n',
      'event: done\ndata: {"messageId":"m4","conversationId":"cnv_2"}\n\n',
    ];
    let chatReply = "";
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.includes("/v1/assistants/")) return Response.json({ visitorCheck: true });
      if (url.endsWith("/v1/session")) {
        return Response.json({
          session: `vs1.s${requests.length}`,
          expiresAt: Date.now() + 3_600_000,
        });
      }
      return new Response(sseStream([chatReply]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const { root } = mount();
    await flushAsync();
    mustQuery<HTMLButtonElement>(root, ".solv-launcher").click();
    const input = mustQuery<HTMLTextAreaElement>(root, "#solv-input");
    const send = async (text: string) => {
      input.value = text;
      mustQuery<HTMLFormElement>(root, ".solv-form").requestSubmit();
      await flushAsync();
      const frame = root.querySelector<HTMLIFrameElement>(".solv-check iframe");
      if (frame) fromFrame(frame, { type: "token", token: `t-${text}` });
      await flushAsync();
    };
    for (const [i, text] of ["one", "two", "three", "four"].entries()) {
      chatReply = replies[i] ?? "";
      await send(text);
    }
    const chats = requests.filter((r) => r.url.endsWith("/v1/chat"));
    expect(chats.map((r) => r.body?.conversationId)).toEqual([
      undefined,
      "cnv_1",
      "cnv_1",
      undefined,
    ]);
    // Refused as expired, the session was forgotten and the check ran again.
    expect(requests.filter((r) => r.url.endsWith("/v1/session"))).toHaveLength(2);
    expect(chats[2]?.body?.session).not.toBe(chats[1]?.body?.session);
  });
});
