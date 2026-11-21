/**
 * The visitor check's frame is never loaded here (happy-dom does not navigate
 * child frames), so the check stays running for as long as a test needs.
 * @vitest-environment-options {"settings": {"navigation": {"disableChildFrameNavigation": true}}}
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/widget.js";

function shadow(el: HTMLElement): ShadowRoot {
  const root = el.shadowRoot;
  if (!root) throw new Error("Expected shadowRoot");
  return root;
}

function q<T extends Element>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element: ${selector}`);
  return el;
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Waits past the next animation frame, when queued paints run. */
async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await flushAsync();
}

/** An SSE body the test writes to event by event. */
function controlledStream() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    body,
    send(name: string, data: unknown) {
      controller.enqueue(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`));
    },
    close() {
      controller.close();
    },
  };
}

function serve(config: Record<string, unknown>, chat?: () => Response): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/v1/assistants/")) return Response.json(config);
    if (url.endsWith("/v1/chat") && chat) return chat();
    return new Response("Not found", { status: 404 });
  }) as typeof fetch;
}

async function openAndSend(text: string): Promise<{ el: HTMLElement; r: ShadowRoot }> {
  const el = document.createElement("solv-chat");
  el.setAttribute("assistant", "pk_progress");
  document.body.append(el);
  await flushAsync();
  const r = shadow(el);
  q<HTMLButtonElement>(r, ".solv-launcher").click();
  q<HTMLTextAreaElement>(r, "#solv-input").value = text;
  q<HTMLFormElement>(r, ".solv-form").requestSubmit();
  return { el, r };
}

const lastAnswer = (r: ShadowRoot) => {
  const all = r.querySelectorAll<HTMLDivElement>(".solv-bubble--assistant");
  return all[all.length - 1] as HTMLDivElement;
};

/** How often the live region would read "Writing an answer". */
const announcements = (r: ShadowRoot) =>
  [...r.querySelectorAll(".solv-messages .sr-only")].filter(
    (n) => n.textContent === "Writing an answer",
  ).length;

describe("progress while an answer is written", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    document.body.replaceChildren();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("shows the typing indicator from send until the first text, and announces it once", async () => {
    const stream = controlledStream();
    serve(
      {},
      () => new Response(stream.body, { headers: { "content-type": "text/event-stream" } }),
    );
    const { r } = await openAndSend("How do I reset it?");

    // Straight away, before any request has answered.
    const bubble = lastAnswer(r);
    expect(bubble.querySelector(".solv-typing")).not.toBeNull();
    expect(bubble.querySelectorAll(".solv-typing-dot")).toHaveLength(3);
    for (const dot of bubble.querySelectorAll(".solv-typing-dot")) {
      expect(dot.getAttribute("aria-hidden")).toBe("true");
    }
    expect(announcements(r)).toBe(1);
    // Inside the role="log" live region, so it is read out.
    expect(bubble.closest("[aria-live]")).not.toBeNull();

    await flushAsync();
    expect(lastAnswer(r).querySelector(".solv-typing")).not.toBeNull();

    // A tool working: still writing, said once.
    stream.send("tool", { name: "search_docs", state: "running" });
    await flushAsync();
    expect(bubble.querySelector(".solv-typing")).not.toBeNull();
    expect(announcements(r)).toBe(1);

    stream.send("token", { text: "Open " });
    await nextFrame();
    expect(bubble.querySelector(".solv-typing")).toBeNull();
    expect(q(bubble, ".solv-bubble-text").textContent).toBe("Open ");

    // A second tool round after text: the dots come back, not the announcement.
    stream.send("tool", { name: "search_docs", state: "running" });
    await flushAsync();
    expect(bubble.querySelector(".solv-typing")).not.toBeNull();
    expect(announcements(r)).toBe(0);
    stream.send("token", { text: "Settings." });
    await nextFrame();
    expect(bubble.querySelector(".solv-typing")).toBeNull();

    stream.send("done", { messageId: "msg_1", conversationId: "cnv_1" });
    stream.close();
    await flushAsync();
    expect(bubble.querySelector(".solv-typing")).toBeNull();
    expect(q(bubble, ".solv-bubble-text").textContent).toBe("Open Settings.");
  });

  it("shows the typing indicator while the visitor check runs", async () => {
    serve({ visitorCheck: true }, () => {
      throw new Error("no chat request may be sent before the check");
    });
    const { r } = await openAndSend("Hello");
    await flushAsync();
    // The check frame is waiting on Turnstile, which never answers here.
    expect(r.querySelector(".solv-check iframe")).not.toBeNull();
    expect(lastAnswer(r).querySelector(".solv-typing")).not.toBeNull();
    expect(announcements(r)).toBe(1);
  });

  it("removes the indicator when the answer fails", async () => {
    serve({}, () => new Response("nope", { status: 500 }));
    const { r } = await openAndSend("Hello");
    await flushAsync();
    expect(lastAnswer(r).querySelector(".solv-typing")).toBeNull();
    expect(lastAnswer(r).querySelector(".solv-bubble-error")).not.toBeNull();
  });

  it("paints once a frame, holds a half-written link back, and shows it after a short bound", async () => {
    // Frames run when the test says, so what one frame paints can be seen.
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const runFrames = async () => {
      for (const cb of frames.splice(0)) cb(performance.now());
      await flushAsync();
    };
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const stream = controlledStream();
      serve(
        {},
        () => new Response(stream.body, { headers: { "content-type": "text/event-stream" } }),
      );
      const { r } = await openAndSend("Where is the guide?");
      await flushAsync();
      const text = () => q(lastAnswer(r), ".solv-bubble-text");

      // Several tokens before a frame make one paint, in that frame.
      stream.send("token", { text: "Read " });
      stream.send("token", { text: "the " });
      stream.send("token", { text: "[guide](https://docs.exa" });
      await flushAsync();
      expect(text().textContent).toBe("");
      expect(frames).toHaveLength(1);
      await runFrames();
      expect(text().textContent).toBe("Read the ");
      expect(text().querySelector("a")).toBeNull();
      expect(lastAnswer(r).querySelector(".solv-typing")).toBeNull();

      // Still unfinished after the bound: shown as it stands.
      now += 700;
      await new Promise((resolve) => setTimeout(resolve, 650));
      await runFrames();
      expect(text().textContent).toBe("Read the [guide](https://docs.exa");

      stream.send("token", { text: "mple.com/guide) first." });
      await flushAsync();
      await runFrames();
      expect(q<HTMLAnchorElement>(text(), "a").href).toBe("https://docs.example.com/guide");
      expect(text().textContent).toBe("Read the guide first.");

      // The end of the stream paints at once, without waiting for a frame.
      stream.send("token", { text: " And **this" });
      stream.send("done", { messageId: "msg_1", conversationId: "cnv_1" });
      stream.close();
      await flushAsync();
      expect(text().textContent).toBe("Read the guide first. And **this");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the view at the newest text only while the visitor has not scrolled up", async () => {
    const stream = controlledStream();
    serve(
      {},
      () => new Response(stream.body, { headers: { "content-type": "text/event-stream" } }),
    );
    const { r } = await openAndSend("Tell me more");
    const messages = q<HTMLDivElement>(r, ".solv-messages");
    let height = 1000;
    Object.defineProperty(messages, "scrollHeight", { configurable: true, get: () => height });
    Object.defineProperty(messages, "clientHeight", { configurable: true, get: () => 200 });
    await flushAsync();

    stream.send("token", { text: "One. " });
    await nextFrame();
    expect(messages.scrollTop).toBe(1000);

    // The visitor scrolls up to read.
    messages.scrollTop = 300;
    messages.dispatchEvent(new Event("scroll"));
    height = 1400;
    stream.send("token", { text: "Two. " });
    await nextFrame();
    expect(messages.scrollTop).toBe(300);

    // Back at the bottom: pinned again.
    messages.scrollTop = 1200;
    messages.dispatchEvent(new Event("scroll"));
    height = 1600;
    stream.send("token", { text: "Three." });
    await nextFrame();
    expect(messages.scrollTop).toBe(1600);
    stream.send("done", { messageId: "msg_1", conversationId: "cnv_1" });
    stream.close();
    await flushAsync();
  });
});
