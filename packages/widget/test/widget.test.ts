import { CHAT_PROTOCOL_VERSION, MAX_CHAT_MESSAGE_LENGTH } from "@solvchat/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/widget.js";

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function mountWidget(assistant = "pk_test_123", endpoint?: string): HTMLElement {
  const el = document.createElement("solv-chat");
  el.setAttribute("assistant", assistant);
  if (endpoint) {
    el.setAttribute("endpoint", endpoint);
  }
  document.body.append(el);
  return el;
}

function shadow(el: HTMLElement): ShadowRoot {
  const root = el.shadowRoot;
  if (!root) throw new Error("Expected shadowRoot");
  return root;
}

function mustQuery<T extends Element>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element: ${selector}`);
  return el;
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("<solv-chat>", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    document.body.replaceChildren();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("renders closed, opens on click, moves focus in, and returns focus to launcher on Escape", async () => {
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as typeof fetch;

    const el = mountWidget();
    await flushAsync();
    const root = shadow(el);

    const panel = mustQuery<HTMLDivElement>(root, ".solv-panel");
    const launcher = mustQuery<HTMLButtonElement>(root, ".solv-launcher");
    const input = mustQuery<HTMLTextAreaElement>(root, "#solv-input");

    expect(panel.hidden).toBe(true);
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.hasAttribute("aria-modal")).toBe(false);
    expect(launcher.getAttribute("aria-expanded")).toBe("false");

    launcher.click();
    expect(panel.hidden).toBe(false);
    expect(launcher.getAttribute("aria-expanded")).toBe("true");
    expect(root.activeElement).toBe(input);

    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel.hidden).toBe(true);
    expect(launcher.getAttribute("aria-expanded")).toBe("false");
    expect(root.activeElement).toBe(launcher);
  });

  it("streams tokens in order, sends CHAT_PROTOCOL_VERSION, ignores unknown events, and renders safe citations", async () => {
    const requests: Array<{ url: string; init?: RequestInit | undefined }> = [];

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      requests.push({ url, init });

      if (url.endsWith("/v1/assistants/pk_test_123")) {
        return Response.json({
          title: "Docs Helper",
          greeting: "Hi there!",
          suggestedQuestions: ["How do I start?"],
        });
      }

      if (url.endsWith("/v1/chat")) {
        return new Response(
          sseStream([
            'event: token\ndata: {"text":"Hello "}\n\n',
            'event: page_action\ndata: {"action":"navigate","url":"/pricing"}\n\n',
            'event: token\ndata: {"text":"world <img onerror=alert(1)>"}\n\n',
            'event: citation\ndata: {"url":"https://docs.example.com/guide","title":"Guide"}\n\n',
            'event: citation\ndata: {"url":"javascript:alert(1)","title":"Evil"}\n\n',
            'event: done\ndata: {"messageId":"msg_1","conversationId":"conv_1"}\n\n',
          ]),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        );
      }

      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const el = mountWidget("pk_test_123");
    await flushAsync();
    const root = shadow(el);

    mustQuery<HTMLButtonElement>(root, ".solv-launcher").click();
    const input = mustQuery<HTMLTextAreaElement>(root, "#solv-input");
    const form = mustQuery<HTMLFormElement>(root, ".solv-form");

    input.value = "How does it work?";
    form.requestSubmit();
    await flushAsync();

    // Every fetch stays on the same origin.
    for (const req of requests) {
      expect(new URL(req.url).origin).toBe(location.origin);
    }

    const chatCall = requests.find((r) => r.url.endsWith("/v1/chat"));
    expect(chatCall).toBeDefined();
    const sentBody = JSON.parse(String(chatCall?.init?.body)) as Record<string, unknown>;
    expect(sentBody.protocol).toBe(CHAT_PROTOCOL_VERSION);
    expect(sentBody.assistant).toBe("pk_test_123");
    expect(sentBody.message).toBe("How does it work?");

    const assistantBubbles = root.querySelectorAll(".solv-bubble--assistant .solv-bubble-text");
    const answerEl = assistantBubbles[0];
    expect(answerEl).toBeDefined();
    expect(answerEl?.textContent).toBe("Hello world <img onerror=alert(1)>");
    expect(answerEl?.querySelector("img")).toBeNull();

    const links = root.querySelectorAll<HTMLAnchorElement>(".solv-citation");
    expect(links).toHaveLength(1);
    expect(links[0]?.href).toBe("https://docs.example.com/guide");
    expect(links[0]?.rel).toBe("noopener noreferrer");
    expect(links[0]?.textContent).toBe("Guide");
  });

  it("restores conversation for the same assistant key, isolates other keys, and resets when sessionStorage is cleared", async () => {
    const conversationIds: Array<string | undefined> = [];

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/chat")) {
        const body = JSON.parse(String(init?.body)) as { conversationId?: string };
        conversationIds.push(body.conversationId);
        const convId = body.conversationId ?? "conv_abc";
        return new Response(
          sseStream([
            'event: token\ndata: {"text":"Answer"}\n\n',
            `event: done\ndata: {"messageId":"msg_1","conversationId":"${convId}"}\n\n`,
          ]),
          { status: 200 },
        );
      }
      return Response.json({});
    }) as typeof fetch;

    const first = mountWidget("pk_site_a");
    await flushAsync();
    const firstRoot = shadow(first);
    mustQuery<HTMLButtonElement>(firstRoot, ".solv-launcher").click();
    mustQuery<HTMLTextAreaElement>(firstRoot, "#solv-input").value = "First question";
    mustQuery<HTMLFormElement>(firstRoot, ".solv-form").requestSubmit();
    await flushAsync();

    // Fresh element with same assistant key restores transcript and continues conversationId.
    first.remove();
    const second = mountWidget("pk_site_a");
    await flushAsync();
    const secondRoot = shadow(second);

    expect(mustQuery(secondRoot, ".solv-panel").hasAttribute("hidden")).toBe(false);
    expect(secondRoot.textContent).toContain("First question");
    expect(secondRoot.textContent).toContain("Answer");

    mustQuery<HTMLTextAreaElement>(secondRoot, "#solv-input").value = "Follow up";
    mustQuery<HTMLFormElement>(secondRoot, ".solv-form").requestSubmit();
    await flushAsync();
    expect(conversationIds).toEqual([undefined, "conv_abc"]);

    // Different assistant key does not inherit the conversation.
    second.remove();
    const other = mountWidget("pk_site_b");
    await flushAsync();
    const otherRoot = shadow(other);
    expect(otherRoot.textContent).not.toContain("First question");
    expect(mustQuery<HTMLDivElement>(otherRoot, ".solv-panel").hidden).toBe(true);

    // Clearing sessionStorage starts fresh for pk_site_a.
    other.remove();
    sessionStorage.clear();
    const fresh = mountWidget("pk_site_a");
    await flushAsync();
    const freshRoot = shadow(fresh);
    expect(freshRoot.textContent).not.toContain("First question");
    expect(mustQuery<HTMLDivElement>(freshRoot, ".solv-panel").hidden).toBe(true);
  });

  it("reuses visitorId in localStorage and keeps document.cookie empty", async () => {
    const visitorIds: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/chat")) {
        const body = JSON.parse(String(init?.body)) as { visitorId: string };
        visitorIds.push(body.visitorId);
        return new Response(
          sseStream([
            'event: token\ndata: {"text":"Hi"}\n\n',
            'event: done\ndata: {"messageId":"m1","conversationId":"c1"}\n\n',
          ]),
          { status: 200 },
        );
      }
      return Response.json({});
    }) as typeof fetch;

    const el1 = mountWidget("pk_v1");
    await flushAsync();
    const root1 = shadow(el1);
    mustQuery<HTMLTextAreaElement>(root1, "#solv-input").value = "Q1";
    mustQuery<HTMLFormElement>(root1, ".solv-form").requestSubmit();
    await flushAsync();

    el1.remove();
    const el2 = mountWidget("pk_v1");
    await flushAsync();
    const root2 = shadow(el2);
    mustQuery<HTMLTextAreaElement>(root2, "#solv-input").value = "Q2";
    mustQuery<HTMLFormElement>(root2, ".solv-form").requestSubmit();
    await flushAsync();

    expect(visitorIds).toHaveLength(2);
    expect(visitorIds[0]).toBeTruthy();
    expect(visitorIds[0]).toBe(visitorIds[1]);
    expect(localStorage.getItem("solv-chat-visitor")).toBe(visitorIds[0]);
    expect(document.cookie).toBe("");
  });

  describe("on a plain-http page, where crypto.randomUUID does not exist", () => {
    beforeEach(() => {
      // Secure-context-only: an owner may list an http: origin, and there the
      // browser exposes getRandomValues but not randomUUID.
      Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    });

    afterEach(() => {
      Reflect.deleteProperty(crypto, "randomUUID");
    });

    async function askAndVote(): Promise<{ chat: string[]; feedback: string[] }> {
      const chat: string[] = [];
      const feedback: string[] = [];
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const body = JSON.parse(String(init?.body ?? "{}")) as { visitorId?: string };
        if (url.endsWith("/v1/chat")) {
          chat.push(body.visitorId ?? "");
          return new Response(
            sseStream([
              'event: token\ndata: {"text":"Hi"}\n\n',
              'event: done\ndata: {"messageId":"msg_http_1","conversationId":"cnv_http_1"}\n\n',
            ]),
            { status: 200 },
          );
        }
        if (url.endsWith("/v1/feedback")) {
          feedback.push(body.visitorId ?? "");
          return new Response(null, { status: 204 });
        }
        return Response.json({});
      }) as typeof fetch;

      const el = mountWidget("pk_http");
      await flushAsync();
      const root = shadow(el);
      mustQuery<HTMLTextAreaElement>(root, "#solv-input").value = "Q over http";
      mustQuery<HTMLFormElement>(root, ".solv-form").requestSubmit();
      await flushAsync();
      expect(root.textContent).not.toContain("Unable to reach the assistant");
      mustQuery<HTMLButtonElement>(root, 'button[aria-label="Helpful"]').click();
      await flushAsync();
      expect(root.textContent).toContain("Thanks for the feedback.");
      return { chat, feedback };
    }

    it("still sends messages and feedback with a stored visitor id", async () => {
      const { chat, feedback } = await askAndVote();
      expect(chat).toHaveLength(1);
      expect(chat[0]).toMatch(/^[0-9a-f]{32}$/);
      expect(feedback).toEqual(chat);
      expect(localStorage.getItem("solv-chat-visitor")).toBe(chat[0]);
    });

    it("still sends when localStorage is unavailable too", async () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("storage blocked");
      });
      const { chat, feedback } = await askAndVote();
      expect(chat).toHaveLength(1);
      expect(chat[0]).toMatch(/^[0-9a-f]{32}$/);
      expect(feedback).toEqual(chat);
    });
  });

  it("posts feedback once per message and shows an acknowledgement", async () => {
    const feedbackPosts: Array<Record<string, unknown>> = [];

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/chat")) {
        return new Response(
          sseStream([
            'event: token\ndata: {"text":"Helpful answer"}\n\n',
            'event: done\ndata: {"messageId":"msg_fb_1","conversationId":"conv_fb_1"}\n\n',
          ]),
          { status: 200 },
        );
      }
      if (url.endsWith("/v1/feedback")) {
        feedbackPosts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ ok: true });
      }
      return Response.json({});
    }) as typeof fetch;

    const el = mountWidget("pk_fb");
    await flushAsync();
    const root = shadow(el);

    mustQuery<HTMLTextAreaElement>(root, "#solv-input").value = "Test";
    mustQuery<HTMLFormElement>(root, ".solv-form").requestSubmit();
    await flushAsync();

    const upBtn = mustQuery<HTMLButtonElement>(root, 'button[aria-label="Helpful"]');
    const downBtn = mustQuery<HTMLButtonElement>(root, 'button[aria-label="Not helpful"]');
    const ack = mustQuery<HTMLSpanElement>(root, ".solv-fb-ack");

    upBtn.click();
    downBtn.click();
    upBtn.click();
    await flushAsync();

    expect(feedbackPosts).toHaveLength(1);
    expect(feedbackPosts[0]).toMatchObject({
      protocol: CHAT_PROTOCOL_VERSION,
      assistant: "pk_fb",
      messageId: "msg_fb_1",
      value: "up",
    });
    expect(upBtn.disabled).toBe(true);
    expect(downBtn.disabled).toBe(true);
    expect(ack.textContent).toBe("Thanks for the feedback.");
  });

  it("restores feedback controls on HTTP 500 or network error without persisting, and allows retry", async () => {
    let feedbackAttempt = 0;
    let resolveInFlight: ((res: Response) => void) | undefined;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/chat")) {
        return new Response(
          sseStream([
            'event: token\ndata: {"text":"Answer"}\n\n',
            'event: done\ndata: {"messageId":"msg_fb_err","conversationId":"conv_fb_err"}\n\n',
          ]),
          { status: 200 },
        );
      }
      if (url.endsWith("/v1/feedback")) {
        feedbackAttempt += 1;
        if (feedbackAttempt === 1) {
          return new Promise<Response>((resolve) => {
            resolveInFlight = resolve;
          });
        }
        if (feedbackAttempt === 2) {
          throw new Error("Network failure");
        }
        return Response.json({ ok: true });
      }
      return Response.json({});
    }) as typeof fetch;

    const el = mountWidget("pk_fb_retry");
    await flushAsync();
    const root = shadow(el);

    mustQuery<HTMLTextAreaElement>(root, "#solv-input").value = "Test";
    mustQuery<HTMLFormElement>(root, ".solv-form").requestSubmit();
    await flushAsync();

    const upBtn = mustQuery<HTMLButtonElement>(root, 'button[aria-label="Helpful"]');
    const downBtn = mustQuery<HTMLButtonElement>(root, 'button[aria-label="Not helpful"]');
    const ack = mustQuery<HTMLSpanElement>(root, ".solv-fb-ack");

    // First click: in-flight disables buttons, does not acknowledge yet.
    upBtn.click();
    expect(upBtn.disabled).toBe(true);
    expect(downBtn.disabled).toBe(true);
    expect(ack.textContent).toBe("");

    // Resolve first attempt with HTTP 500.
    resolveInFlight?.(new Response("Server error", { status: 500 }));
    await flushAsync();

    expect(upBtn.disabled).toBe(false);
    expect(downBtn.disabled).toBe(false);
    expect(upBtn.getAttribute("aria-pressed")).toBe("false");
    expect(downBtn.getAttribute("aria-pressed")).toBe("false");
    expect(ack.textContent).toBe("Could not send feedback. Try again.");

    // Reloading must not restore failed feedback as submitted.
    el.remove();
    const reloaded = mountWidget("pk_fb_retry");
    await flushAsync();
    const reloadedRoot = shadow(reloaded);
    const reloadedUp = mustQuery<HTMLButtonElement>(reloadedRoot, 'button[aria-label="Helpful"]');
    const reloadedDown = mustQuery<HTMLButtonElement>(
      reloadedRoot,
      'button[aria-label="Not helpful"]',
    );
    const reloadedAck = mustQuery<HTMLSpanElement>(reloadedRoot, ".solv-fb-ack");
    expect(reloadedUp.disabled).toBe(false);
    expect(reloadedDown.disabled).toBe(false);
    expect(reloadedAck.textContent).toBe("");

    // Second attempt: network error also restores controls.
    reloadedDown.click();
    await flushAsync();
    expect(reloadedUp.disabled).toBe(false);
    expect(reloadedDown.disabled).toBe(false);
    expect(reloadedAck.textContent).toBe("Could not send feedback. Try again.");

    // Third attempt: HTTP 200 persists and disables controls.
    reloadedDown.click();
    await flushAsync();
    expect(reloadedUp.disabled).toBe(true);
    expect(reloadedDown.disabled).toBe(true);
    expect(reloadedDown.getAttribute("aria-pressed")).toBe("true");
    expect(reloadedAck.textContent).toBe("Thanks for the feedback.");
  });

  it("disables open transition when prefers-reduced-motion: reduce matches", async () => {
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as typeof fetch;

    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn((query: string) => ({
      matches: query.includes("prefers-reduced-motion: reduce"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;

    try {
      const el = mountWidget("pk_motion");
      await flushAsync();
      const root = shadow(el);
      const sheet = root.adoptedStyleSheets[0];
      expect(sheet).toBeDefined();
      const rules = Array.from(sheet?.cssRules ?? []);
      const reducedRule = rules.find(
        (rule): rule is CSSMediaRule =>
          "conditionText" in rule &&
          String((rule as CSSMediaRule).conditionText).includes("prefers-reduced-motion: reduce"),
      );
      expect(reducedRule).toBeDefined();
      const reducedRules = Array.from(reducedRule?.cssRules ?? []).filter(
        (rule): rule is CSSStyleRule => "selectorText" in rule,
      );
      for (const selector of [
        ".solv-panel",
        ".solv-launcher",
        ".solv-chip",
        ".solv-send",
        ".solv-fb-btn",
      ]) {
        const match = reducedRules.find((rule) => rule.selectorText.includes(selector));
        expect(match?.style.transition).toBe("none");
      }

      // No unconditional top-level rule may set `transition` and override reduced motion.
      const topLevelTransitions = rules
        .filter(
          (rule): rule is CSSStyleRule => "selectorText" in rule && !("conditionText" in rule),
        )
        .filter((rule) => rule.style.transition !== "");
      expect(topLevelTransitions).toEqual([]);
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it("registers <solv-chat> as a side-effect-only module with no named exports", async () => {
    const mod = await import("../src/widget.js");
    expect(Object.keys(mod)).toEqual([]);
    expect(customElements.get("solv-chat")).toBeDefined();
  });

  it("aborts the in-flight fetch signal when removed from the DOM", async () => {
    let capturedSignal: AbortSignal | undefined;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/chat")) {
        capturedSignal = init?.signal ?? undefined;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return Response.json({});
    }) as typeof fetch;

    const el = mountWidget("pk_abort_on_remove");
    await flushAsync();
    const root = shadow(el);

    mustQuery<HTMLButtonElement>(root, ".solv-launcher").click();
    mustQuery<HTMLTextAreaElement>(root, "#solv-input").value = "In-flight question";
    mustQuery<HTMLFormElement>(root, ".solv-form").requestSubmit();
    await flushAsync();

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);
    expect(streamController).toBeDefined();

    el.remove();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("allows an element removed mid-stream and re-attached to claim ownership and send again", async () => {
    const encoder = new TextEncoder();
    let streamController1: ReadableStreamDefaultController<Uint8Array> | undefined;
    const signals: Array<AbortSignal | undefined> = [];
    let chatCall = 0;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/chat")) {
        chatCall += 1;
        signals.push(init?.signal ?? undefined);
        if (chatCall === 1) {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              streamController1 = controller;
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response(
          sseStream([
            'event: token\ndata: {"text":"Second answer"}\n\n',
            'event: done\ndata: {"messageId":"msg_re2","conversationId":"conv_re2"}\n\n',
          ]),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return Response.json({});
    }) as typeof fetch;

    const el = mountWidget("pk_reconnect");
    await flushAsync();
    const root = shadow(el);

    mustQuery<HTMLButtonElement>(root, ".solv-launcher").click();
    mustQuery<HTMLTextAreaElement>(root, "#solv-input").value = "First question";
    mustQuery<HTMLFormElement>(root, ".solv-form").requestSubmit();
    await flushAsync();

    expect(streamController1).toBeDefined();
    streamController1?.enqueue(encoder.encode('event: token\ndata: {"text":"Partial "}\n\n'));
    await flushAsync();

    // Remove and re-attach the same element mid-stream.
    el.remove();
    expect(signals[0]?.aborted).toBe(true);

    document.body.append(el);
    await flushAsync();

    // Re-attached element can immediately send a new message.
    mustQuery<HTMLTextAreaElement>(root, "#solv-input").value = "Second question";
    mustQuery<HTMLFormElement>(root, ".solv-form").requestSubmit();
    await flushAsync();

    // Stale chunks arriving on the aborted first stream must not overwrite storage.
    streamController1?.enqueue(encoder.encode('event: token\ndata: {"text":"stale"}\n\n'));
    streamController1?.enqueue(
      encoder.encode('event: done\ndata: {"messageId":"msg_old","conversationId":"conv_old"}\n\n'),
    );
    streamController1?.close();
    await flushAsync();

    expect(chatCall).toBe(2);
    expect(signals[1]?.aborted).toBe(false);

    const rawSaved = sessionStorage.getItem("solv-chat-open:pk_reconnect");
    expect(rawSaved).not.toBeNull();
    const saved = JSON.parse(String(rawSaved)) as {
      conversationId: string | null;
      turns: Array<{ role: string; text: string; messageId?: string }>;
    };
    expect(saved.conversationId).toBe("conv_re2");
    expect(saved.turns).toEqual([
      { role: "user", text: "First question" },
      {
        role: "assistant",
        text: "Partial ",
        error: "Response interrupted. Please try again.",
      },
      { role: "user", text: "Second question" },
      { role: "assistant", text: "Second answer", messageId: "msg_re2" },
    ]);
  });

  it("ignores Enter during IME composition and submits on ordinary Enter", async () => {
    const chatRequests: Array<{ message: string }> = [];

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/chat")) {
        chatRequests.push(JSON.parse(String(init?.body)) as { message: string });
        return new Response(
          sseStream([
            'event: token\ndata: {"text":"Submitted"}\n\n',
            'event: done\ndata: {"messageId":"msg_ime","conversationId":"conv_ime"}\n\n',
          ]),
          { status: 200 },
        );
      }
      return Response.json({});
    }) as typeof fetch;

    const el = mountWidget("pk_ime");
    await flushAsync();
    const root = shadow(el);

    mustQuery<HTMLButtonElement>(root, ".solv-launcher").click();
    const input = mustQuery<HTMLTextAreaElement>(root, "#solv-input");
    input.value = "nihao";

    // Enter with isComposing: true must not submit or clear the input.
    const composingEvent = new KeyboardEvent("keydown", {
      key: "Enter",
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(composingEvent);
    await flushAsync();

    expect(composingEvent.defaultPrevented).toBe(false);
    expect(input.value).toBe("nihao");
    expect(chatRequests).toHaveLength(0);

    // Enter between compositionstart and compositionend must not submit either.
    input.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    const trackedComposingEvent = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(trackedComposingEvent);
    await flushAsync();

    expect(trackedComposingEvent.defaultPrevented).toBe(false);
    expect(input.value).toBe("nihao");
    expect(chatRequests).toHaveLength(0);

    input.dispatchEvent(new Event("compositionend", { bubbles: true }));

    // Ordinary Enter after composition ends submits the message.
    const submitEvent = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(submitEvent);
    await flushAsync();

    expect(submitEvent.defaultPrevented).toBe(true);
    expect(input.value).toBe("");
    expect(chatRequests).toHaveLength(1);
    expect(chatRequests[0]).toMatchObject({
      protocol: CHAT_PROTOCOL_VERSION,
      assistant: "pk_ime",
      message: "nihao",
    });
    expect(root.textContent).toContain("Submitted");
  });

  it("enforces the 4,000-character message limit without clearing oversized drafts and allows 4,000 trimmed chars", async () => {
    const chatRequests: Array<{ message: string }> = [];
    const oversizedSuggestion = "q".repeat(MAX_CHAT_MESSAGE_LENGTH + 1);

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/assistants/pk_len")) {
        return Response.json({
          title: "Docs Helper",
          greeting: "Hi!",
          suggestedQuestions: [oversizedSuggestion],
        });
      }
      if (url.endsWith("/v1/chat")) {
        chatRequests.push(JSON.parse(String(init?.body)) as { message: string });
        return new Response(
          sseStream([
            'event: token\ndata: {"text":"Accepted"}\n\n',
            'event: done\ndata: {"messageId":"msg_len","conversationId":"conv_len"}\n\n',
          ]),
          { status: 200 },
        );
      }
      return Response.json({});
    }) as typeof fetch;

    const el = mountWidget("pk_len");
    await flushAsync();
    const root = shadow(el);

    mustQuery<HTMLButtonElement>(root, ".solv-launcher").click();
    const input = mustQuery<HTMLTextAreaElement>(root, "#solv-input");
    const form = mustQuery<HTMLFormElement>(root, ".solv-form");
    const errorEl = mustQuery<HTMLDivElement>(root, ".solv-input-error");

    // Oversized suggested question is also rejected before sending or modifying transcript.
    const chip = mustQuery<HTMLButtonElement>(root, ".solv-chip");
    chip.click();
    await flushAsync();
    expect(chatRequests).toHaveLength(0);
    expect(errorEl.hidden).toBe(false);
    expect(errorEl.textContent).toContain("4,000");
    expect(root.querySelectorAll(".solv-bubble--user")).toHaveLength(0);

    // Clear error by typing short text, then submit 4,001 non-whitespace characters.
    const oversizedDraft = "a".repeat(MAX_CHAT_MESSAGE_LENGTH + 1);
    input.value = oversizedDraft;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    form.requestSubmit();
    await flushAsync();

    expect(chatRequests).toHaveLength(0);
    expect(input.value).toBe(oversizedDraft);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(errorEl.hidden).toBe(false);
    expect(errorEl.textContent).toContain("4,000");
    expect(root.querySelectorAll(".solv-bubble--user")).toHaveLength(0);
    expect(sessionStorage.getItem("solv-chat-open:pk_len")).not.toContain(oversizedDraft);

    // Exactly 4,000 trimmed characters (with surrounding whitespace) succeeds and clears the error.
    const boundaryText = "b".repeat(MAX_CHAT_MESSAGE_LENGTH);
    input.value = `  ${boundaryText}  `;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(errorEl.hidden).toBe(true);
    expect(input.hasAttribute("aria-invalid")).toBe(false);

    form.requestSubmit();
    await flushAsync();

    expect(chatRequests).toHaveLength(1);
    expect(chatRequests[0]?.message).toBe(boundaryText);
    expect(input.value).toBe("");
    expect(errorEl.hidden).toBe(true);
    expect(root.textContent).toContain("Accepted");
  });

  it("preserves partial text, marks failure on mid-stream error event, and retains failure across reload", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/chat")) {
        return new Response(
          sseStream([
            'event: token\ndata: {"text":"Partial answer"}\n\n',
            'event: error\ndata: {"message":"Model quota exceeded"}\n\n',
          ]),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return Response.json({});
    }) as typeof fetch;

    const el = mountWidget("pk_err_event");
    await flushAsync();
    const root = shadow(el);

    mustQuery<HTMLButtonElement>(root, ".solv-launcher").click();
    mustQuery<HTMLTextAreaElement>(root, "#solv-input").value = "Question";
    mustQuery<HTMLFormElement>(root, ".solv-form").requestSubmit();
    await flushAsync();

    const sendBtn = mustQuery<HTMLButtonElement>(root, ".solv-send");
    expect(sendBtn.disabled).toBe(false);

    const assistantBubbles = root.querySelectorAll(".solv-bubble--assistant");
    const bubble = assistantBubbles[assistantBubbles.length - 1];
    expect(bubble?.classList.contains("solv-bubble--error")).toBe(true);
    expect(bubble?.querySelector(".solv-bubble-text")?.textContent).toBe("Partial answer");
    expect(bubble?.querySelector(".solv-bubble-error")?.textContent).toBe("Model quota exceeded");

    // Reloading the widget restores both the partial text and the error indicator.
    el.remove();
    const reloaded = mountWidget("pk_err_event");
    await flushAsync();
    const reloadedRoot = shadow(reloaded);
    const reloadedBubbles = reloadedRoot.querySelectorAll(".solv-bubble--assistant");
    const reloadedBubble = reloadedBubbles[reloadedBubbles.length - 1];
    expect(reloadedBubble?.classList.contains("solv-bubble--error")).toBe(true);
    expect(reloadedBubble?.querySelector(".solv-bubble-text")?.textContent).toBe("Partial answer");
    expect(reloadedBubble?.querySelector(".solv-bubble-error")?.textContent).toBe(
      "Model quota exceeded",
    );
  });

  it("preserves partial text, marks failure on mid-stream reader rejection, and retains failure across reload", async () => {
    const encoder = new TextEncoder();

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/chat")) {
        let sentFirst = false;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!sentFirst) {
              sentFirst = true;
              controller.enqueue(
                encoder.encode('event: token\ndata: {"text":"Streamed prefix"}\n\n'),
              );
              return;
            }
            controller.error(new Error("Connection reset"));
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return Response.json({});
    }) as typeof fetch;

    const el = mountWidget("pk_err_reject");
    await flushAsync();
    const root = shadow(el);

    mustQuery<HTMLButtonElement>(root, ".solv-launcher").click();
    mustQuery<HTMLTextAreaElement>(root, "#solv-input").value = "Question";
    mustQuery<HTMLFormElement>(root, ".solv-form").requestSubmit();
    await flushAsync();

    const sendBtn = mustQuery<HTMLButtonElement>(root, ".solv-send");
    expect(sendBtn.disabled).toBe(false);

    const assistantBubbles = root.querySelectorAll(".solv-bubble--assistant");
    const bubble = assistantBubbles[assistantBubbles.length - 1];
    expect(bubble?.classList.contains("solv-bubble--error")).toBe(true);
    expect(bubble?.querySelector(".solv-bubble-text")?.textContent).toBe("Streamed prefix");
    expect(bubble?.querySelector(".solv-bubble-error")?.textContent).toBe(
      "Response interrupted. Please try again.",
    );

    // Reloading the widget restores both the partial text and the error indicator.
    el.remove();
    const reloaded = mountWidget("pk_err_reject");
    await flushAsync();
    const reloadedRoot = shadow(reloaded);
    const reloadedBubbles = reloadedRoot.querySelectorAll(".solv-bubble--assistant");
    const reloadedBubble = reloadedBubbles[reloadedBubbles.length - 1];
    expect(reloadedBubble?.classList.contains("solv-bubble--error")).toBe(true);
    expect(reloadedBubble?.querySelector(".solv-bubble-text")?.textContent).toBe("Streamed prefix");
    expect(reloadedBubble?.querySelector(".solv-bubble-error")?.textContent).toBe(
      "Response interrupted. Please try again.",
    );
  });

  it("marks response as interrupted when stream reaches EOF without done or error", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/chat")) {
        return new Response(sseStream(['event: token\ndata: {"text":"Truncated answer"}\n\n']), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return Response.json({});
    }) as typeof fetch;

    const el = mountWidget("pk_eof");
    await flushAsync();
    const root = shadow(el);

    mustQuery<HTMLButtonElement>(root, ".solv-launcher").click();
    mustQuery<HTMLTextAreaElement>(root, "#solv-input").value = "Question";
    mustQuery<HTMLFormElement>(root, ".solv-form").requestSubmit();
    await flushAsync();

    const sendBtn = mustQuery<HTMLButtonElement>(root, ".solv-send");
    expect(sendBtn.disabled).toBe(false);

    const assistantBubbles = root.querySelectorAll(".solv-bubble--assistant");
    const bubble = assistantBubbles[assistantBubbles.length - 1];
    expect(bubble?.classList.contains("solv-bubble--error")).toBe(true);
    expect(bubble?.querySelector(".solv-bubble-text")?.textContent).toBe("Truncated answer");
    expect(bubble?.querySelector(".solv-bubble-error")?.textContent).toBe(
      "Response interrupted. Please try again.",
    );
    expect(bubble?.querySelector(".solv-feedback")).toBeNull();

    // Reloading preserves the partial text and interruption state.
    el.remove();
    const reloaded = mountWidget("pk_eof");
    await flushAsync();
    const reloadedRoot = shadow(reloaded);
    const reloadedBubbles = reloadedRoot.querySelectorAll(".solv-bubble--assistant");
    const reloadedBubble = reloadedBubbles[reloadedBubbles.length - 1];
    expect(reloadedBubble?.classList.contains("solv-bubble--error")).toBe(true);
    expect(reloadedBubble?.querySelector(".solv-bubble-text")?.textContent).toBe(
      "Truncated answer",
    );
    expect(reloadedBubble?.querySelector(".solv-bubble-error")?.textContent).toBe(
      "Response interrupted. Please try again.",
    );
  });

  it("persists streaming tokens and citations immediately and restores an unfinished turn as interrupted on replacement", async () => {
    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/chat")) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return Response.json({});
    }) as typeof fetch;

    const first = mountWidget("pk_nav_midstream");
    await flushAsync();
    const firstRoot = shadow(first);

    mustQuery<HTMLButtonElement>(firstRoot, ".solv-launcher").click();
    mustQuery<HTMLTextAreaElement>(firstRoot, "#solv-input").value = "Where do I start?";
    mustQuery<HTMLFormElement>(firstRoot, ".solv-form").requestSubmit();
    await flushAsync();

    expect(streamController).toBeDefined();
    streamController?.enqueue(encoder.encode('event: token\ndata: {"text":"Read the "}\n\n'));
    streamController?.enqueue(encoder.encode('event: token\ndata: {"text":"guide."}\n\n'));
    streamController?.enqueue(
      encoder.encode(
        'event: citation\ndata: {"url":"https://docs.example.com/start","title":"Getting Started"}\n\n',
      ),
    );
    await flushAsync();

    // Progress must already be in sessionStorage before any terminal event or finally.
    const rawSaved = sessionStorage.getItem("solv-chat-open:pk_nav_midstream");
    expect(rawSaved).not.toBeNull();
    const saved = JSON.parse(String(rawSaved)) as {
      open: boolean;
      turns: Array<{
        role: string;
        text: string;
        citations?: Array<{ url: string; title: string }>;
      }>;
    };
    expect(saved.open).toBe(true);
    expect(saved.turns).toEqual([
      { role: "user", text: "Where do I start?" },
      {
        role: "assistant",
        text: "Read the guide.",
        citations: [{ url: "https://docs.example.com/start", title: "Getting Started" }],
      },
    ]);

    // Simulate navigation/reload before stream completion by replacing the element.
    first.remove();
    const replacement = mountWidget("pk_nav_midstream");
    await flushAsync();
    const replacementRoot = shadow(replacement);

    expect(mustQuery<HTMLDivElement>(replacementRoot, ".solv-panel").hidden).toBe(false);
    expect(replacementRoot.textContent).toContain("Where do I start?");

    const assistantBubbles = replacementRoot.querySelectorAll(".solv-bubble--assistant");
    const bubble = assistantBubbles[assistantBubbles.length - 1];
    expect(bubble?.querySelector(".solv-bubble-text")?.textContent).toBe("Read the guide.");
    const citation = bubble?.querySelector<HTMLAnchorElement>(".solv-citation");
    expect(citation?.href).toBe("https://docs.example.com/start");
    expect(citation?.textContent).toBe("Getting Started");
    expect(bubble?.classList.contains("solv-bubble--error")).toBe(true);
    expect(bubble?.querySelector(".solv-bubble-error")?.textContent).toBe(
      "Response interrupted. Please try again.",
    );
    expect(bubble?.querySelector(".solv-feedback")).toBeNull();
  });

  it("prevents a replaced streaming widget from overwriting its successor's transcript and conversationId", async () => {
    const encoder = new TextEncoder();
    let streamControllerA: ReadableStreamDefaultController<Uint8Array> | undefined;
    const sentBodies: Array<{ message: string; conversationId?: string }> = [];

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/chat")) {
        const body = JSON.parse(String(init?.body)) as { message: string; conversationId?: string };
        sentBodies.push(body);
        if (sentBodies.length === 1) {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              streamControllerA = controller;
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response(
          sseStream([
            'event: token\ndata: {"text":"Follow-up answer"}\n\n',
            'event: done\ndata: {"messageId":"msg_b","conversationId":"conv_b"}\n\n',
          ]),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return Response.json({});
    }) as typeof fetch;

    const widgetA = mountWidget("pk_replace_stream");
    await flushAsync();
    const rootA = shadow(widgetA);

    mustQuery<HTMLButtonElement>(rootA, ".solv-launcher").click();
    mustQuery<HTMLTextAreaElement>(rootA, "#solv-input").value = "First question";
    mustQuery<HTMLFormElement>(rootA, ".solv-form").requestSubmit();
    await flushAsync();

    expect(streamControllerA).toBeDefined();
    streamControllerA?.enqueue(encoder.encode('event: token\ndata: {"text":"Partial "}\n\n'));
    await flushAsync();

    // Replace widget A mid-stream with widget B for the same assistant key.
    widgetA.remove();
    const widgetB = mountWidget("pk_replace_stream");
    await flushAsync();
    const rootB = shadow(widgetB);

    // Send a follow-up through B and let B complete.
    mustQuery<HTMLTextAreaElement>(rootB, "#solv-input").value = "Follow up";
    mustQuery<HTMLFormElement>(rootB, ".solv-form").requestSubmit();
    await flushAsync();

    // Finish A's old stream (token, citation, done, and stream close -> finally).
    streamControllerA?.enqueue(encoder.encode('event: token\ndata: {"text":"stale tail"}\n\n'));
    streamControllerA?.enqueue(
      encoder.encode(
        'event: citation\ndata: {"url":"https://stale.example.com/old","title":"Stale"}\n\n',
      ),
    );
    streamControllerA?.enqueue(
      encoder.encode('event: done\ndata: {"messageId":"msg_a","conversationId":"conv_a"}\n\n'),
    );
    streamControllerA?.close();
    await flushAsync();

    const rawSaved = sessionStorage.getItem("solv-chat-open:pk_replace_stream");
    expect(rawSaved).not.toBeNull();
    const saved = JSON.parse(String(rawSaved)) as {
      conversationId: string | null;
      open: boolean;
      turns: Array<{ role: string; text: string; messageId?: string; error?: string }>;
    };
    expect(saved.conversationId).toBe("conv_b");
    expect(saved.open).toBe(true);
    expect(saved.turns).toEqual([
      { role: "user", text: "First question" },
      {
        role: "assistant",
        text: "Partial ",
        error: "Response interrupted. Please try again.",
      },
      { role: "user", text: "Follow up" },
      { role: "assistant", text: "Follow-up answer", messageId: "msg_b" },
    ]);

    // Reloading restores B's conversation and continues with conv_b.
    widgetB.remove();
    const widgetC = mountWidget("pk_replace_stream");
    await flushAsync();
    const rootC = shadow(widgetC);
    mustQuery<HTMLTextAreaElement>(rootC, "#solv-input").value = "Third question";
    mustQuery<HTMLFormElement>(rootC, ".solv-form").requestSubmit();
    await flushAsync();

    expect(sentBodies[2]?.conversationId).toBe("conv_b");
  });

  it("prevents a replaced widget's in-flight feedback completion from overwriting its successor's state", async () => {
    let resolveFeedbackA: ((res: Response) => void) | undefined;
    let chatCall = 0;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/chat")) {
        chatCall += 1;
        if (chatCall === 1) {
          return new Response(
            sseStream([
              'event: token\ndata: {"text":"Answer A"}\n\n',
              'event: done\ndata: {"messageId":"msg_a","conversationId":"conv_a"}\n\n',
            ]),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response(
          sseStream([
            'event: token\ndata: {"text":"Answer B"}\n\n',
            'event: done\ndata: {"messageId":"msg_b","conversationId":"conv_b"}\n\n',
          ]),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      if (url.endsWith("/v1/feedback")) {
        return new Promise<Response>((resolve) => {
          resolveFeedbackA = resolve;
        });
      }
      return Response.json({});
    }) as typeof fetch;

    const widgetA = mountWidget("pk_replace_fb");
    await flushAsync();
    const rootA = shadow(widgetA);

    mustQuery<HTMLButtonElement>(rootA, ".solv-launcher").click();
    mustQuery<HTMLTextAreaElement>(rootA, "#solv-input").value = "Question A";
    mustQuery<HTMLFormElement>(rootA, ".solv-form").requestSubmit();
    await flushAsync();

    // Start feedback submission on A, leaving it in flight.
    mustQuery<HTMLButtonElement>(rootA, 'button[aria-label="Helpful"]').click();
    expect(resolveFeedbackA).toBeDefined();

    // Replace A with B and send a follow-up on B.
    widgetA.remove();
    const widgetB = mountWidget("pk_replace_fb");
    await flushAsync();
    const rootB = shadow(widgetB);

    mustQuery<HTMLTextAreaElement>(rootB, "#solv-input").value = "Question B";
    mustQuery<HTMLFormElement>(rootB, ".solv-form").requestSubmit();
    await flushAsync();

    // Complete A's pending feedback request after B has updated sessionStorage.
    resolveFeedbackA?.(Response.json({ ok: true }));
    await flushAsync();

    const rawSaved = sessionStorage.getItem("solv-chat-open:pk_replace_fb");
    expect(rawSaved).not.toBeNull();
    const saved = JSON.parse(String(rawSaved)) as {
      conversationId: string | null;
      turns: Array<{
        role: string;
        text: string;
        messageId?: string;
        feedback?: string;
      }>;
    };
    expect(saved.conversationId).toBe("conv_b");
    expect(saved.turns).toEqual([
      { role: "user", text: "Question A" },
      { role: "assistant", text: "Answer A", messageId: "msg_a" },
      { role: "user", text: "Question B" },
      { role: "assistant", text: "Answer B", messageId: "msg_b" },
    ]);
  });

  it("reloads sessionStorage on reconnect so a re-attached element reflects a newer conversation", async () => {
    const sentBodies: Array<{ message: string; conversationId?: string }> = [];
    let chatCall = 0;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/chat")) {
        chatCall += 1;
        sentBodies.push(
          JSON.parse(String(init?.body)) as { message: string; conversationId?: string },
        );
        if (chatCall === 1) {
          return new Response(
            sseStream([
              'event: token\ndata: {"text":"Answer A"}\n\n',
              'event: done\ndata: {"messageId":"msg_a","conversationId":"conv_a"}\n\n',
            ]),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }
        if (chatCall === 2) {
          return new Response(
            sseStream([
              'event: token\ndata: {"text":"Answer B"}\n\n',
              'event: done\ndata: {"messageId":"msg_b","conversationId":"conv_b"}\n\n',
            ]),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response(
          sseStream([
            'event: token\ndata: {"text":"Answer C"}\n\n',
            'event: done\ndata: {"messageId":"msg_c","conversationId":"conv_b"}\n\n',
          ]),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return Response.json({});
    }) as typeof fetch;

    const widgetA = mountWidget("pk_reattach");
    await flushAsync();
    const rootA = shadow(widgetA);

    mustQuery<HTMLButtonElement>(rootA, ".solv-launcher").click();
    mustQuery<HTMLTextAreaElement>(rootA, "#solv-input").value = "Question A";
    mustQuery<HTMLFormElement>(rootA, ".solv-form").requestSubmit();
    await flushAsync();
    widgetA.remove();

    const widgetB = mountWidget("pk_reattach");
    await flushAsync();
    const rootB = shadow(widgetB);
    expect(rootB.textContent).toContain("Question A");
    expect(rootB.textContent).toContain("Answer A");

    mustQuery<HTMLTextAreaElement>(rootB, "#solv-input").value = "Question B";
    mustQuery<HTMLFormElement>(rootB, ".solv-form").requestSubmit();
    await flushAsync();
    widgetB.remove();

    document.body.append(widgetA);
    await flushAsync();

    expect(rootA.textContent).toContain("Question A");
    expect(rootA.textContent).toContain("Answer A");
    expect(rootA.textContent).toContain("Question B");
    expect(rootA.textContent).toContain("Answer B");

    mustQuery<HTMLTextAreaElement>(rootA, "#solv-input").value = "Question C";
    mustQuery<HTMLFormElement>(rootA, ".solv-form").requestSubmit();
    await flushAsync();

    expect(sentBodies.map((b) => b.conversationId)).toEqual([undefined, "conv_a", "conv_b"]);

    const rawSaved = sessionStorage.getItem("solv-chat-open:pk_reattach");
    expect(rawSaved).not.toBeNull();
    const saved = JSON.parse(String(rawSaved)) as {
      conversationId: string | null;
      turns: Array<{ role: string; text: string; messageId?: string }>;
    };
    expect(saved.conversationId).toBe("conv_b");
    expect(saved.turns).toEqual([
      { role: "user", text: "Question A" },
      { role: "assistant", text: "Answer A", messageId: "msg_a" },
      { role: "user", text: "Question B" },
      { role: "assistant", text: "Answer B", messageId: "msg_b" },
      { role: "user", text: "Question C" },
      { role: "assistant", text: "Answer C", messageId: "msg_c" },
    ]);
  });
});
