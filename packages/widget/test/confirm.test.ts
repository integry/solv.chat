// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegistry, register, runAction } from "../src/actions.js";
import { askToConfirm, CONFIRM_TIMEOUT_MS } from "../src/confirm.js";
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

function mountWidget(assistant = "pk_confirm_test"): HTMLElement {
  const el = document.createElement("solv-chat");
  el.setAttribute("assistant", assistant);
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

interface MockActionEvent {
  callId: string;
  name: string;
  input: Record<string, unknown>;
  confirm: boolean;
}

function mockChatFetch(
  actions: MockActionEvent[],
  options: { builtins?: boolean; followUpText?: string } = {},
) {
  const chatBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/v1/assistants/")) {
      return Response.json({
        title: "Helper",
        actions: { builtins: options.builtins ?? false, allowedOrigins: [] },
      });
    }
    if (url.endsWith("/v1/chat")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      chatBodies.push(body);
      if (chatBodies.length === 1) {
        const events = actions.map((act) => `event: action\ndata: ${JSON.stringify(act)}\n\n`);
        events.push(
          `event: done\ndata: ${JSON.stringify({
            messageId: "msg_pause",
            conversationId: "conv_1",
            awaitingActions: actions.map((act) => act.callId),
          })}\n\n`,
        );
        return new Response(sseStream(events), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(
        sseStream([
          `event: token\ndata: ${JSON.stringify({ text: options.followUpText ?? "Done." })}\n\n`,
          'event: done\ndata: {"messageId":"msg_done","conversationId":"conv_1"}\n\n',
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }
    return new Response("Not found", { status: 404 });
  }) as typeof fetch;
  return chatBodies;
}

async function sendMessage(root: ShadowRoot, text = "Please help"): Promise<void> {
  mustQuery<HTMLButtonElement>(root, ".solv-launcher").click();
  mustQuery<HTMLTextAreaElement>(root, "#solv-input").value = text;
  mustQuery<HTMLFormElement>(root, ".solv-form").requestSubmit();
  await flushAsync();
}

describe("action confirmation", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearRegistry();
    localStorage.clear();
    sessionStorage.clear();
    document.body.replaceChildren();
  });

  afterEach(() => {
    clearRegistry();
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs confirm: false without a prompt while still announcing what ran in the transcript", async () => {
    const run = vi.fn(() => ({ opened: "inv_1" }));
    register({
      name: "open_invoice",
      description: "Open invoice",
      input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      confirm: false,
      run,
    });
    const chatBodies = mockChatFetch([
      { callId: "c1", name: "open_invoice", input: { id: "inv_1" }, confirm: false },
    ]);

    const el = mountWidget();
    await flushAsync();
    const root = shadow(el);

    await sendMessage(root);

    expect(root.querySelector(".solv-confirm")).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
    expect(chatBodies).toHaveLength(2);
    expect(chatBodies[1]?.actionResults).toEqual([
      { callId: "c1", ok: true, result: '{"opened":"inv_1"}' },
    ]);
    expect(root.querySelector(".solv-action-note")?.textContent).toBe(
      "Using open_invoice on this page.",
    );
  });

  it("does not call run before Allow, calls run once after Allow, and announces the action", async () => {
    const run = vi.fn(() => ({ deleted: true }));
    register({
      name: "delete_thing",
      description: "Delete the thing",
      input: { type: "object", properties: {}, required: [] },
      confirm: true,
      run,
    });
    const chatBodies = mockChatFetch([
      { callId: "c1", name: "delete_thing", input: {}, confirm: false },
    ]);

    const el = mountWidget();
    await flushAsync();
    const root = shadow(el);

    await sendMessage(root);

    expect(root.querySelector(".solv-confirm")).toBeTruthy();
    expect(root.querySelector(".solv-action-note")?.textContent).toBe(
      "Using delete_thing on this page.",
    );
    expect(run).not.toHaveBeenCalled();

    mustQuery<HTMLButtonElement>(root, ".solv-confirm .solv-send").click();
    await flushAsync();

    expect(root.querySelector(".solv-confirm")).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
    expect(chatBodies).toHaveLength(2);
    expect(chatBodies[1]?.actionResults).toEqual([
      { callId: "c1", ok: true, result: '{"deleted":true}' },
    ]);
  });

  it("prompts for fill and waits for Allow before modifying form fields", async () => {
    const field = document.createElement("input");
    field.setAttribute("data-solv-fill", "email");
    field.value = "";
    document.body.append(field);

    const chatBodies = mockChatFetch(
      [
        {
          callId: "c_fill",
          name: "fill",
          input: { fields: [{ name: "email", value: "ada@example.com" }] },
          confirm: false,
        },
      ],
      { builtins: true },
    );

    const el = mountWidget();
    await flushAsync();
    const root = shadow(el);

    await sendMessage(root, "Fill my email");

    expect(root.querySelector(".solv-confirm")).toBeTruthy();
    expect(root.querySelector(".solv-action-note")?.textContent).toBe(
      "Filling in the form for you.",
    );
    expect(field.value).toBe("");

    mustQuery<HTMLButtonElement>(root, ".solv-confirm .solv-send").click();
    await flushAsync();

    expect(field.value).toBe("ada@example.com");
    expect(chatBodies).toHaveLength(2);
    expect(chatBodies[1]?.actionResults).toEqual([
      expect.objectContaining({ callId: "c_fill", ok: true }),
    ]);
  });

  it("refuses on Not now, Escape, and panel close, and continues the answer with ok: false", async () => {
    for (const [label, act] of [
      [
        "Not now",
        (root: ShadowRoot) =>
          mustQuery<HTMLButtonElement>(root, ".solv-confirm .solv-fb-btn").click(),
      ],
      [
        "Escape",
        (root: ShadowRoot) =>
          mustQuery(root, ".solv-confirm").dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
          ),
      ],
      [
        "panel close",
        (root: ShadowRoot) => mustQuery<HTMLButtonElement>(root, ".solv-close").click(),
      ],
    ] as const) {
      clearRegistry();
      document.body.replaceChildren();
      const run = vi.fn(() => ({ ok: true }));
      register({
        name: "risky_action",
        description: "Do something risky",
        input: { type: "object", properties: {}, required: [] },
        confirm: false,
        run,
      });
      const chatBodies = mockChatFetch(
        [{ callId: "c1", name: "risky_action", input: {}, confirm: true }],
        { followUpText: `Continued after ${label}.` },
      );

      const el = mountWidget(`pk_${label.replace(/\s+/g, "_")}`);
      await flushAsync();
      const root = shadow(el);

      await sendMessage(root);
      expect(root.querySelector(".solv-confirm")).toBeTruthy();
      expect(run).not.toHaveBeenCalled();

      act(root);
      await flushAsync();

      expect(run).not.toHaveBeenCalled();
      expect(root.querySelector(".solv-confirm")).toBeNull();
      expect(chatBodies).toHaveLength(2);
      expect(chatBodies[1]?.actionResults).toEqual([
        { callId: "c1", ok: false, error: "The visitor did not confirm." },
      ]);
      expect(root.textContent).toContain(`Continued after ${label}.`);

      if (label === "Escape") {
        expect(mustQuery<HTMLDivElement>(root, ".solv-panel").hidden).toBe(false);
        expect(root.activeElement).toBe(mustQuery(root, "#solv-input"));
      }
    }
  });

  it("refuses and removes the prompt when the widget element is removed from the DOM", async () => {
    const run = vi.fn(() => ({ ok: true }));
    register({
      name: "risky_action",
      description: "Do something risky",
      input: { type: "object", properties: {}, required: [] },
      confirm: true,
      run,
    });
    mockChatFetch([{ callId: "c1", name: "risky_action", input: {}, confirm: true }]);

    const el = mountWidget("pk_remove_open");
    await flushAsync();
    const root = shadow(el);

    await sendMessage(root);
    expect(root.querySelector(".solv-confirm")).toBeTruthy();

    el.remove();
    await flushAsync();

    expect(run).not.toHaveBeenCalled();
    expect(root.querySelector(".solv-confirm")).toBeNull();
  });

  it("refuses after CONFIRM_TIMEOUT_MS without calling run", async () => {
    vi.useFakeTimers();
    const run = vi.fn(() => ({ ok: true }));
    register({
      name: "slow_confirm",
      description: "Confirm me",
      input: { type: "object", properties: {}, required: [] },
      confirm: true,
      run,
    });

    const container = document.createElement("div");
    document.body.append(container);
    const onFocusReturn = vi.fn();

    const pending = runAction(
      { callId: "c_to", name: "slow_confirm", input: {}, confirm: true },
      {
        confirm: (request, action) =>
          askToConfirm(container, request, action, onFocusReturn).answer,
      },
    );

    await vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS - 1);
    expect(container.querySelector(".solv-confirm")).toBeTruthy();

    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(run).not.toHaveBeenCalled();
    expect(result).toEqual({
      callId: "c_to",
      ok: false,
      error: "The visitor did not confirm.",
    });
    expect(container.querySelector(".solv-confirm")).toBeNull();
    expect(onFocusReturn).toHaveBeenCalledTimes(1);
  });

  it("has accessible role, aria-labelledby, aria-describedby, keyboard buttons, and restores focus", async () => {
    register({
      name: "custom_action",
      description: "Custom description",
      input: { type: "object", properties: { item: { type: "string" } }, required: ["item"] },
      confirm: true,
      run: () => ({ ok: true }),
    });
    mockChatFetch([
      { callId: "c1", name: "custom_action", input: { item: "widget" }, confirm: true },
    ]);

    const el = mountWidget("pk_a11y");
    await flushAsync();
    const root = shadow(el);

    await sendMessage(root);

    const prompt = mustQuery<HTMLDivElement>(root, ".solv-confirm");
    expect(prompt.getAttribute("role")).toBe("group");

    const labelledBy = prompt.getAttribute("aria-labelledby");
    const describedBy = prompt.getAttribute("aria-describedby");
    expect(labelledBy).toBeTruthy();
    expect(describedBy).toBeTruthy();

    const titleEl = root.getElementById(labelledBy ?? "");
    const detailEl = root.getElementById(describedBy ?? "");
    expect(titleEl?.textContent).toBe("Custom description");
    expect(detailEl?.textContent).toContain('{"item":"widget"}');

    const buttons = [...prompt.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Allow", "Not now"]);
    expect(buttons.every((b) => b.tabIndex >= 0)).toBe(true);
    // Initial focus lands on Not now so a stray Enter does not accept.
    expect(root.activeElement).toBe(buttons[1]);

    buttons[0]?.click();
    await flushAsync();
    expect(root.activeElement).toBe(mustQuery(root, "#solv-input"));
  });

  it("renders fill field names and values as text, so markup creates no elements", async () => {
    const emailField = document.createElement("input");
    emailField.setAttribute("data-solv-fill", "email");
    const noteField = document.createElement("textarea");
    noteField.setAttribute("data-solv-fill", "note");
    document.body.append(emailField, noteField);

    const payload = '<img src=x onerror="window.__pwned=1">';
    mockChatFetch(
      [
        {
          callId: "c_fill",
          name: "fill",
          input: {
            fields: [
              { name: "email", value: "ada@example.com" },
              { name: "note", value: payload },
            ],
          },
          confirm: true,
        },
      ],
      { builtins: true },
    );

    const el = mountWidget("pk_xss");
    await flushAsync();
    const root = shadow(el);

    await sendMessage(root);

    const detail = mustQuery(root, ".solv-confirm-detail");
    const items = [...detail.querySelectorAll("li")].map((li) => li.textContent);
    expect(items).toEqual([`email: ada@example.com`, `note: ${payload}`]);
    expect(detail.querySelector("img")).toBeNull();
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
  });

  it("prompts for navigate and highlight with plain-language details", () => {
    const container = document.createElement("div");
    document.body.append(container);

    const navHandle = askToConfirm(
      container,
      { name: "navigate", input: { url: "/billing", section: "plan" } },
      {
        name: "navigate",
        description: "Navigate",
        input: { type: "object" },
        confirm: true,
        run: () => ({}),
      },
      () => {},
    );
    expect(container.querySelector(".solv-confirm-title")?.textContent).toBe(
      "Open another page on this site?",
    );
    expect(
      [...container.querySelectorAll(".solv-confirm-detail li")].map((li) => li.textContent),
    ).toEqual(["/billing", "Section: plan"]);
    navHandle.dismiss();

    const hlHandle = askToConfirm(
      container,
      { name: "highlight", input: { target: "upgrade-button" } },
      {
        name: "highlight",
        description: "Highlight",
        input: { type: "object" },
        confirm: true,
        run: () => ({}),
      },
      () => {},
    );
    expect(container.querySelector(".solv-confirm-title")?.textContent).toBe(
      "Point at something on this page?",
    );
    expect(
      [...container.querySelectorAll(".solv-confirm-detail li")].map((li) => li.textContent),
    ).toEqual(["upgrade-button"]);
    hlHandle.dismiss();
  });

  it("prompts two actions in order with independent answers", async () => {
    const firstRun = vi.fn(() => ({ first: true }));
    const secondRun = vi.fn(() => ({ second: true }));
    register({
      name: "first_action",
      description: "First action",
      input: { type: "object", properties: {}, required: [] },
      confirm: true,
      run: firstRun,
    });
    register({
      name: "second_action",
      description: "Second action",
      input: { type: "object", properties: {}, required: [] },
      confirm: true,
      run: secondRun,
    });

    const chatBodies = mockChatFetch([
      { callId: "c1", name: "first_action", input: {}, confirm: true },
      { callId: "c2", name: "second_action", input: {}, confirm: true },
    ]);

    const el = mountWidget("pk_two_prompts");
    await flushAsync();
    const root = shadow(el);

    await sendMessage(root);

    // Only one prompt is shown at a time: first_action.
    expect(root.querySelectorAll(".solv-confirm")).toHaveLength(1);
    expect(root.querySelector(".solv-confirm-title")?.textContent).toBe("First action");

    // Refuse the first action.
    mustQuery<HTMLButtonElement>(root, ".solv-confirm .solv-fb-btn").click();
    await flushAsync();

    // Refusing the first still prompts for the second.
    expect(firstRun).not.toHaveBeenCalled();
    expect(root.querySelectorAll(".solv-confirm")).toHaveLength(1);
    expect(root.querySelector(".solv-confirm-title")?.textContent).toBe("Second action");

    // Allow the second action.
    mustQuery<HTMLButtonElement>(root, ".solv-confirm .solv-send").click();
    await flushAsync();

    expect(secondRun).toHaveBeenCalledTimes(1);
    expect(chatBodies).toHaveLength(2);
    expect(chatBodies[1]?.actionResults).toEqual([
      { callId: "c1", ok: false, error: "The visitor did not confirm." },
      { callId: "c2", ok: true, result: '{"second":true}' },
    ]);
  });
});
