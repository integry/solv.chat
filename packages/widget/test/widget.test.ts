import { CHAT_PROTOCOL_VERSION } from "@solvchat/core";
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
});
