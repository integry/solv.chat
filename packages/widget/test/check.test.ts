/**
 * The check frame is never loaded here: happy-dom does not navigate child
 * frames, and the frame's messages are played by the test, from the
 * frame's own window and the engine's origin, as the real frame sends them.
 * @vitest-environment-options {"settings": {"navigation": {"disableChildFrameNavigation": true}}}
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECK_LOAD_TIMEOUT_MS } from "../src/check.js";
import "../src/widget.js";

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
function fakeEngine(options: { config?: Record<string, unknown>; sessionStatus?: number } = {}) {
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

function mount(): { el: HTMLElement; root: ShadowRoot } {
  const el = document.createElement("solv-chat");
  el.setAttribute("assistant", "pk_test_check");
  document.body.append(el);
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
