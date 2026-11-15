import {
  MAX_ACTION_RESULT_BYTES,
  MAX_ACTION_SCHEMA_BYTES,
  MAX_PAGE_ACTIONS,
  parseChatRequest,
} from "@solvchat/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegistry, listForRequest, lookup, register, runAction } from "../src/actions.js";
import { HIGHLIGHT_DURATION_MS, installBuiltins } from "../src/builtins.js";
import { NAVIGATION_RECOVERY_MS, parsePublicConfig } from "../src/element.js";
import "../src/widget.js";

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function spyValueReads(field: HTMLInputElement): ReturnType<typeof vi.fn> {
  const reads = vi.fn();
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  Object.defineProperty(field, "value", {
    configurable: true,
    get() {
      reads();
      return descriptor?.get?.call(this);
    },
    set(next) {
      descriptor?.set?.call(this, next);
    },
  });
  return reads;
}

describe("built-in page actions", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearRegistry();
    document.body.replaceChildren();
    localStorage.clear();
    sessionStorage.clear();
    window.name = "";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("config gating", () => {
    it("leaves built-ins off by default when config omits actions or disables them", async () => {
      globalThis.fetch = vi.fn(async () =>
        Response.json({ title: "Helper", greeting: "Hi" }),
      ) as typeof fetch;

      const el = document.createElement("solv-chat");
      el.setAttribute("assistant", "pk_test");
      document.body.append(el);
      await flushAsync();

      const names = listForRequest().map((a) => a.name);
      expect(names).not.toContain("navigate");
      expect(names).not.toContain("highlight");
      expect(names).not.toContain("fill");
    });

    it("registers built-ins when enabled in public config and removes them when disabled", async () => {
      let enabled = true;
      globalThis.fetch = vi.fn(async () =>
        Response.json({
          title: "Helper",
          actions: { builtins: enabled, allowedOrigins: ["https://shop.example.com"] },
        }),
      ) as typeof fetch;

      const el = document.createElement("solv-chat");
      el.setAttribute("assistant", "pk_test");
      document.body.append(el);
      await flushAsync();

      expect(listForRequest().map((a) => a.name)).toEqual(["fill", "highlight", "navigate"]);

      enabled = false;
      el.remove();
      document.body.append(el);
      await flushAsync();

      expect(listForRequest()).toEqual([]);
    });

    it("counts built-ins against MAX_PAGE_ACTIONS", () => {
      for (let i = 0; i < MAX_PAGE_ACTIONS - 1; i++) {
        register({
          name: `custom_${i}`,
          description: `Custom action ${i}`,
          input: { type: "object", properties: {} },
          confirm: false,
          run: () => ({ ok: true }),
        });
      }
      installBuiltins({ enabled: true, allowedOrigins: [] });
      expect(listForRequest()).toHaveLength(MAX_PAGE_ACTIONS);
    });
  });

  describe("navigate", () => {
    it("navigates to a same-origin path", async () => {
      const assign = vi.spyOn(location, "assign").mockImplementation(() => {});
      installBuiltins({ enabled: true, allowedOrigins: [] });

      const result = await runAction({
        callId: "c1",
        name: "navigate",
        input: { url: "/pricing" },
        confirm: false,
      });

      expect(result.ok).toBe(true);
      expect(assign).toHaveBeenCalledWith(new URL("/pricing", location.href).href);
    });

    it("navigates to a configured allowed origin", async () => {
      const assign = vi.spyOn(location, "assign").mockImplementation(() => {});
      installBuiltins({ enabled: true, allowedOrigins: ["https://shop.example.com"] });

      const result = await runAction({
        callId: "c1",
        name: "navigate",
        input: { url: "https://shop.example.com/cart" },
        confirm: false,
      });

      expect(result.ok).toBe(true);
      expect(assign).toHaveBeenCalledWith("https://shop.example.com/cart");
    });

    it.each([
      ["//evil.example.com/path", "protocol-relative URL"],
      ["javascript:alert(1)", "javascript URL"],
      ["data:text/html,<script>", "data URL"],
      ["https://evil.example.com/", "unlisted origin"],
    ])("refuses navigate to %s (%s)", async (url) => {
      const assign = vi.spyOn(location, "assign").mockImplementation(() => {});
      installBuiltins({ enabled: true, allowedOrigins: ["https://shop.example.com"] });

      const result = await runAction({
        callId: "c1",
        name: "navigate",
        input: { url },
        confirm: false,
      });

      expect(result.ok).toBe(false);
      expect(assign).not.toHaveBeenCalled();
    });

    it("scrolls to a same-page section without reloading", async () => {
      document.body.innerHTML = `<section id="pricing">Pricing</section>`;
      const section = document.getElementById("pricing") as HTMLElement;
      const scroll = vi.spyOn(section, "scrollIntoView").mockImplementation(() => {});
      const assign = vi.spyOn(location, "assign").mockImplementation(() => {});

      installBuiltins({ enabled: true, allowedOrigins: [] });
      const result = await runAction({
        callId: "c1",
        name: "navigate",
        input: { url: location.pathname, section: "pricing" },
        confirm: false,
      });

      expect(result.ok).toBe(true);
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(assign).not.toHaveBeenCalled();
    });

    it("removes a same-page fragment locally without calling location.assign", async () => {
      const prevUrl = location.href;
      history.replaceState(null, "", "/pricing#details");
      const assign = vi.spyOn(location, "assign").mockImplementation(() => {});
      const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});

      try {
        installBuiltins({ enabled: true, allowedOrigins: [] });
        const result = await runAction({
          callId: "c1",
          name: "navigate",
          input: { url: "/pricing" },
          confirm: false,
        });

        expect(result.ok).toBe(true);
        expect(assign).not.toHaveBeenCalled();
        expect(location.pathname).toBe("/pricing");
        expect(location.hash).toBe("");
        expect(scrollTo).toHaveBeenCalledTimes(1);
      } finally {
        history.replaceState(null, "", prevUrl);
      }
    });
  });

  describe("highlight", () => {
    it("scrolls, outlines, shows a note, and restores the element's inline style afterwards", async () => {
      vi.useFakeTimers();
      document.body.innerHTML = `
        <button id="btn" data-solv-target="upgrade" style="color: red; padding: 4px;">Upgrade</button>
      `;
      const btn = document.getElementById("btn") as HTMLButtonElement;
      const scroll = vi.spyOn(btn, "scrollIntoView").mockImplementation(() => {});

      installBuiltins({ enabled: true, allowedOrigins: [] });
      const result = await runAction({
        callId: "c1",
        name: "highlight",
        input: { target: "upgrade", note: "Click here to change your plan." },
        confirm: false,
      });

      expect(result.ok).toBe(true);
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(btn.style.outline).not.toBe("");
      expect(document.body.textContent).toContain("Click here to change your plan.");

      vi.advanceTimersByTime(HIGHLIGHT_DURATION_MS);

      expect(btn.getAttribute("style")).toBe("color: red; padding: 4px;");
      expect(document.body.textContent).not.toContain("Click here to change your plan.");
    });

    it("removes the style attribute completely when the element had none", async () => {
      vi.useFakeTimers();
      document.body.innerHTML = `<button id="btn" data-solv-target="upgrade">Upgrade</button>`;
      const btn = document.getElementById("btn") as HTMLButtonElement;
      vi.spyOn(btn, "scrollIntoView").mockImplementation(() => {});

      installBuiltins({ enabled: true, allowedOrigins: [] });
      await runAction({
        callId: "c1",
        name: "highlight",
        input: { target: "upgrade" },
        confirm: false,
      });

      expect(btn.hasAttribute("style")).toBe(true);
      vi.advanceTimersByTime(HIGHLIGHT_DURATION_MS);
      expect(btn.hasAttribute("style")).toBe(false);
    });

    it("refuses an unknown target name", async () => {
      installBuiltins({ enabled: true, allowedOrigins: [] });
      const result = await runAction({
        callId: "c1",
        name: "highlight",
        input: { target: "does_not_exist" },
        confirm: false,
      });
      expect(result.ok).toBe(false);
    });
  });

  describe("fill", () => {
    it("requires confirmation via the runAction confirmation hook", async () => {
      document.body.innerHTML = `<input data-solv-fill="email" />`;
      installBuiltins({ enabled: true, allowedOrigins: [] });

      const result = await runAction({
        callId: "c1",
        name: "fill",
        input: { fields: [{ name: "email", value: "a@b.example" }] },
        confirm: false,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("confirmation");
    });

    it("fills marked fields, dispatches input and change once each, and never submits", async () => {
      const submitHandler = vi.fn((event: Event) => event.preventDefault());
      document.body.innerHTML = `
        <form id="f">
          <input data-solv-fill="email" name="email" />
          <input data-solv-fill="company" name="company" />
          <button type="submit">Go</button>
        </form>
      `;
      const form = document.getElementById("f") as HTMLFormElement;
      const email = form.querySelector('[data-solv-fill="email"]') as HTMLInputElement;
      const company = form.querySelector('[data-solv-fill="company"]') as HTMLInputElement;

      const emailInput = vi.fn();
      const emailChange = vi.fn();
      email.addEventListener("input", emailInput);
      email.addEventListener("change", emailChange);

      form.addEventListener("submit", submitHandler);
      const clickSpy = vi.spyOn(HTMLButtonElement.prototype, "click");
      const formSubmitSpy = vi.spyOn(HTMLFormElement.prototype, "submit");

      installBuiltins({ enabled: true, allowedOrigins: [] });
      const result = await runAction(
        {
          callId: "c1",
          name: "fill",
          input: {
            fields: [
              { name: "email", value: "visitor@example.com" },
              { name: "company", value: "Acme" },
            ],
          },
          confirm: false,
        },
        { confirm: async () => true },
      );

      expect(result.ok).toBe(true);
      expect(JSON.parse(result.result ?? "{}")).toEqual({
        filled: ["email", "company"],
        refused: [],
        submitted: false,
      });
      expect(email.value).toBe("visitor@example.com");
      expect(company.value).toBe("Acme");
      expect(emailInput).toHaveBeenCalledTimes(1);
      expect(emailChange).toHaveBeenCalledTimes(1);
      expect(submitHandler).not.toHaveBeenCalled();
      expect(formSubmitSpy).not.toHaveBeenCalled();
      expect(clickSpy).not.toHaveBeenCalled();
    });

    it("refuses an unmarked field without reading its value", async () => {
      document.body.innerHTML = `<input id="unmarked" name="secret" value="keep" />`;
      const field = document.getElementById("unmarked") as HTMLInputElement;
      const reads = spyValueReads(field);

      installBuiltins({ enabled: true, allowedOrigins: [] });
      const result = await runAction(
        {
          callId: "c1",
          name: "fill",
          input: { fields: [{ name: "secret", value: "new" }] },
          confirm: false,
        },
        { confirm: async () => true },
      );

      expect(reads).not.toHaveBeenCalled();
      expect(result.ok).toBe(true);
      expect(JSON.parse(result.result ?? "{}")).toEqual({
        filled: [],
        refused: [{ name: "secret", why: "that field is not fillable" }],
        submitted: false,
      });
      expect(field.getAttribute("value")).toBe("keep");
    });

    it.each([
      ["password", `<input id="f" data-solv-fill="x" type="password" value="secret" />`],
      ["cc-number", `<input id="f" data-solv-fill="x" autocomplete="cc-number" value="4111" />`],
      [
        "one-time-code",
        `<input id="f" data-solv-fill="x" autocomplete="one-time-code" value="123456" />`,
      ],
      ["hidden", `<input id="f" data-solv-fill="x" type="hidden" value="tok" />`],
      ["file", `<input id="f" data-solv-fill="x" type="file" />`],
      [
        "data-solv-no-fill ancestor",
        `<form data-solv-no-fill><input id="f" data-solv-fill="x" value="keep" /></form>`,
      ],
    ])("refuses %s field without reading or changing its value", async (_label, html) => {
      document.body.innerHTML = html;
      const field = document.getElementById("f") as HTMLInputElement;
      const before = field.getAttribute("value");
      const reads = spyValueReads(field);

      installBuiltins({ enabled: true, allowedOrigins: [] });
      const result = await runAction(
        {
          callId: "c1",
          name: "fill",
          input: { fields: [{ name: "x", value: "override" }] },
          confirm: false,
        },
        { confirm: async () => true },
      );

      expect(reads).not.toHaveBeenCalled();
      expect(result.ok).toBe(true);
      const parsed = JSON.parse(result.result ?? "{}") as {
        filled: string[];
        refused: Array<{ name: string; why: string }>;
      };
      expect(parsed.filled).toEqual([]);
      expect(parsed.refused).toHaveLength(1);
      expect(field.getAttribute("value")).toBe(before);
    });

    it.each([
      ["checkbox", `<input id="f" data-solv-fill="agree" type="checkbox" value="yes" />`],
      ["radio", `<input id="f" data-solv-fill="plan" type="radio" value="pro" />`],
    ])(
      "excludes and refuses %s selection control without changing checked or value",
      async (_label, html) => {
        document.body.innerHTML = `${html}<input id="email" data-solv-fill="email" type="email" />`;
        const control = document.getElementById("f") as HTMLInputElement;
        const name = control.getAttribute("data-solv-fill") ?? "";
        const initialValue = control.value;
        const onInput = vi.fn();
        const onChange = vi.fn();
        control.addEventListener("input", onInput);
        control.addEventListener("change", onChange);

        installBuiltins({ enabled: true, allowedOrigins: [] });
        const fillAction = listForRequest().find((a) => a.name === "fill");
        const items = (
          fillAction?.inputSchema.properties as {
            fields?: { items?: { properties?: { name?: { enum?: string[] } } } };
          }
        )?.fields?.items?.properties?.name?.enum;
        expect(items).toEqual(["email"]);

        // Also verify execution-time refusal when fill.run is reached directly.
        document.getElementById("email")?.remove();
        installBuiltins({ enabled: true, allowedOrigins: [] });

        const result = await runAction(
          {
            callId: "c1",
            name: "fill",
            input: { fields: [{ name, value: "true" }] },
            confirm: false,
          },
          { confirm: async () => true },
        );

        expect(result.ok).toBe(true);
        expect(JSON.parse(result.result ?? "{}")).toEqual({
          filled: [],
          refused: [{ name, why: "that kind of field is never filled" }],
          submitted: false,
        });
        expect(control.checked).toBe(false);
        expect(control.value).toBe(initialValue);
        expect(onInput).not.toHaveBeenCalled();
        expect(onChange).not.toHaveBeenCalled();
      },
    );
  });

  it("lets a page's own action of the same name win over a built-in", () => {
    const customRun = vi.fn(() => ({ custom: true }));
    register({
      name: "navigate",
      description: "Custom SPA router",
      input: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      confirm: false,
      run: customRun,
    });

    installBuiltins({ enabled: true, allowedOrigins: [] });
    expect(lookup("navigate")?.description).toBe("Custom SPA router");

    installBuiltins({ enabled: false, allowedOrigins: [] });
    expect(lookup("navigate")?.description).toBe("Custom SPA router");
  });

  describe("F1: public config parser compatibility", () => {
    it("parses the exact publicConfigRoute response shape with enabled and disabled defaults", () => {
      const enabled = parsePublicConfig({
        title: "Docs Helper",
        accentColor: "#112233",
        position: "left",
        greeting: "Hello!",
        suggestedQuestions: ["How do I start?"],
        actions: { builtins: true, allowedOrigins: ["https://shop.example.com"] },
      });
      expect(enabled.actions).toEqual({
        enabled: true,
        allowedOrigins: ["https://shop.example.com"],
      });

      const disabledByDefault = parsePublicConfig({
        title: "Docs Helper",
        accentColor: "#112233",
        position: "right",
        greeting: "Hello!",
        suggestedQuestions: [],
      });
      expect(disabledByDefault.actions).toEqual({
        enabled: false,
        allowedOrigins: [],
      });
    });
  });

  describe("F2: cross-page navigation continuation", () => {
    it("persists continuation before leaving and resumes on destination without replaying navigate", async () => {
      const chatBodies: Array<Record<string, unknown>> = [];
      let assignCalls = 0;
      const assign = vi.spyOn(location, "assign").mockImplementation(() => {
        assignCalls++;
        // Verify pendingResume is already persisted before document replacement.
        const raw = sessionStorage.getItem("solv-chat-open:pk_nav_resume");
        expect(raw).not.toBeNull();
        const saved = JSON.parse(raw ?? "{}") as { pendingResume?: { resumeMessageId: string } };
        expect(saved.pendingResume?.resumeMessageId).toBe("msg_pause");
      });

      let chatStep = 0;
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/v1/assistants/pk_nav_resume")) {
          return Response.json({
            title: "Helper",
            accentColor: "#2563eb",
            position: "right",
            greeting: "Hi!",
            suggestedQuestions: [],
            actions: { builtins: true, allowedOrigins: [] },
          });
        }
        if (url.endsWith("/v1/chat")) {
          chatStep++;
          chatBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
          if (chatStep === 1) {
            return new Response(
              sseStream([
                'event: token\ndata: {"text":"Taking you there"}\n\n',
                'event: action\ndata: {"callId":"call_nav","name":"navigate","input":{"url":"/pricing"},"confirm":false}\n\n',
                'event: done\ndata: {"messageId":"msg_pause","conversationId":"conv_nav","awaitingActions":["call_nav"]}\n\n',
              ]),
              { status: 200, headers: { "content-type": "text/event-stream" } },
            );
          }
          return new Response(
            sseStream([
              'event: token\ndata: {"text":" — here is the pricing page."}\n\n',
              'event: done\ndata: {"messageId":"msg_final","conversationId":"conv_nav"}\n\n',
            ]),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response("Not found", { status: 404 });
      }) as typeof fetch;

      const el1 = document.createElement("solv-chat");
      el1.setAttribute("assistant", "pk_nav_resume");
      document.body.append(el1);
      await flushAsync();

      const root1 = el1.shadowRoot as ShadowRoot;
      (root1.querySelector(".solv-launcher") as HTMLButtonElement).click();
      (root1.querySelector("#solv-input") as HTMLTextAreaElement).value = "Take me to pricing";
      (root1.querySelector(".solv-form") as HTMLFormElement).requestSubmit();
      await flushAsync();

      expect(assign).toHaveBeenCalledTimes(1);
      // Old page must not send a competing follow-up chat request.
      expect(chatBodies).toHaveLength(1);

      // Simulate destination page load with a fresh widget instance.
      el1.remove();
      clearRegistry();
      const el2 = document.createElement("solv-chat");
      el2.setAttribute("assistant", "pk_nav_resume");
      document.body.append(el2);
      await flushAsync();

      expect(assignCalls).toBe(1);
      expect(chatBodies).toHaveLength(2);
      expect(chatBodies[1]?.resumeMessageId).toBe("msg_pause");
      expect(chatBodies[1]?.conversationId).toBe("conv_nav");
      expect(chatBodies[1]?.actionResults).toEqual([
        {
          callId: "call_nav",
          ok: true,
          result: JSON.stringify({ opened: new URL("/pricing", location.href).href }),
        },
      ]);

      const root2 = el2.shadowRoot as ShadowRoot;
      const bubbles = root2.querySelectorAll(".solv-bubble--assistant");
      const resumed = bubbles[1];
      expect(resumed?.querySelector(".solv-bubble-text")?.textContent).toBe(
        "Taking you there — here is the pricing page.",
      );
      expect(resumed?.querySelector(".solv-bubble-error")).toBeNull();
      expect(resumed?.querySelector(".solv-feedback")).not.toBeNull();
    });

    it("caps persisted navigation result at MAX_ACTION_RESULT_BYTES so long URLs pass request validation", async () => {
      const longPath = `/pricing?q=${"a".repeat(MAX_ACTION_RESULT_BYTES + 500)}`;
      const chatBodies: Array<Record<string, unknown>> = [];
      vi.spyOn(location, "assign").mockImplementation(() => {});

      let chatStep = 0;
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/v1/assistants/pk_nav_long")) {
          return Response.json({
            title: "Helper",
            accentColor: "#2563eb",
            position: "right",
            greeting: "Hi!",
            suggestedQuestions: [],
            actions: { builtins: true, allowedOrigins: [] },
          });
        }
        if (url.endsWith("/v1/chat")) {
          chatStep++;
          chatBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
          if (chatStep === 1) {
            return new Response(
              sseStream([
                'event: token\ndata: {"text":"Opening"}\n\n',
                `event: action\ndata: ${JSON.stringify({ callId: "call_long", name: "navigate", input: { url: longPath }, confirm: false })}\n\n`,
                'event: done\ndata: {"messageId":"msg_long1","conversationId":"conv_long","awaitingActions":["call_long"]}\n\n',
              ]),
              { status: 200, headers: { "content-type": "text/event-stream" } },
            );
          }
          return new Response(
            sseStream([
              'event: token\ndata: {"text":" — opened."}\n\n',
              'event: done\ndata: {"messageId":"msg_long2","conversationId":"conv_long"}\n\n',
            ]),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response("Not found", { status: 404 });
      }) as typeof fetch;

      const el1 = document.createElement("solv-chat");
      el1.setAttribute("assistant", "pk_nav_long");
      document.body.append(el1);
      await flushAsync();

      const root1 = el1.shadowRoot as ShadowRoot;
      (root1.querySelector(".solv-launcher") as HTMLButtonElement).click();
      (root1.querySelector("#solv-input") as HTMLTextAreaElement).value = "Open long URL";
      (root1.querySelector(".solv-form") as HTMLFormElement).requestSubmit();
      await flushAsync();

      el1.remove();
      clearRegistry();
      const el2 = document.createElement("solv-chat");
      el2.setAttribute("assistant", "pk_nav_long");
      document.body.append(el2);
      await flushAsync();

      expect(chatBodies).toHaveLength(2);
      const resumeBody = chatBodies[1] as {
        actionResults?: Array<{ callId: string; ok: boolean; result?: string }>;
      };
      const navResult = resumeBody.actionResults?.[0];
      expect(navResult?.ok).toBe(true);
      expect(new TextEncoder().encode(navResult?.result ?? "").byteLength).toBeLessThanOrEqual(
        MAX_ACTION_RESULT_BYTES,
      );
      expect(navResult?.result).toMatch(/\n\[truncated\]$/);
      expect(parseChatRequest(chatBodies[1]).ok).toBe(true);
    });
  });

  describe("F3: marker inventory in advertised schemas", () => {
    it("advertises eligible target and fill names, excludes refused fields without reading values, and refreshes on request", () => {
      document.body.innerHTML = `
        <button data-solv-target="upgrade_control_42">Upgrade</button>
        <input id="email" data-solv-fill="work_email" type="email" value="a@b.com" />
        <input id="pw" data-solv-fill="secret_pw" type="password" value="hunter2" />
        <form data-solv-no-fill>
          <input id="card" data-solv-fill="card_nick" value="visa" />
        </form>
      `;
      const pwReads = spyValueReads(document.getElementById("pw") as HTMLInputElement);
      const cardReads = spyValueReads(document.getElementById("card") as HTMLInputElement);

      installBuiltins({ enabled: true, allowedOrigins: [] });
      const initial = listForRequest();
      const highlight = initial.find((a) => a.name === "highlight");
      const fill = initial.find((a) => a.name === "fill");

      const highlightProps = (highlight?.inputSchema.properties ?? {}) as Record<
        string,
        { enum?: string[] }
      >;
      expect(highlightProps.target?.enum).toEqual(["upgrade_control_42"]);
      const fillProps = (fill?.inputSchema.properties ?? {}) as Record<
        string,
        { items?: { properties?: Record<string, { enum?: string[] }> } }
      >;
      expect(fillProps.fields?.items?.properties?.name?.enum).toEqual(["work_email"]);
      expect(pwReads).not.toHaveBeenCalled();
      expect(cardReads).not.toHaveBeenCalled();

      // DOM changes before next chat request are reflected in listForRequest().
      const extra = document.createElement("a");
      extra.setAttribute("data-solv-target", "billing_link");
      document.body.append(extra);
      const refreshed = listForRequest();
      const refreshedHighlight = refreshed.find((a) => a.name === "highlight");
      const refreshedProps = (refreshedHighlight?.inputSchema.properties ?? {}) as Record<
        string,
        { enum?: string[] }
      >;
      expect(refreshedProps.target?.enum).toEqual(["upgrade_control_42", "billing_link"]);
    });
  });

  describe("F4: encoded section IDs", () => {
    it("resolves Unicode section IDs from percent-encoded URLs and section names, and handles malformed escapes", async () => {
      const scrollIntoView = vi.fn();
      document.body.innerHTML = `<section id="café">Menu</section>`;
      const section = document.getElementById("café") as HTMLElement;
      section.scrollIntoView = scrollIntoView;

      installBuiltins({ enabled: true, allowedOrigins: [] });

      const fromEncodedUrl = await runAction({
        callId: "c1",
        name: "navigate",
        input: { url: `${location.pathname}#caf%C3%A9` },
        confirm: false,
      });
      expect(fromEncodedUrl.ok).toBe(true);
      expect(JSON.parse(fromEncodedUrl.result ?? "{}")).toEqual({ scrolledTo: "café" });

      const fromSectionParam = await runAction({
        callId: "c2",
        name: "navigate",
        input: { url: location.pathname, section: "café" },
        confirm: false,
      });
      expect(fromSectionParam.ok).toBe(true);
      expect(scrollIntoView).toHaveBeenCalledTimes(2);

      const malformed = await runAction({
        callId: "c3",
        name: "navigate",
        input: { url: `${location.pathname}#bad%ZZ` },
        confirm: false,
      });
      expect(malformed.ok).toBe(false);
      expect(malformed.error).toBe("That action did not finish.");
    });
  });

  describe("F5: highlight note repositioning and viewport clamping", () => {
    it("repositions the note on scroll, clamps to viewport, and cleans up listeners", async () => {
      vi.useFakeTimers();
      Object.defineProperty(window, "innerWidth", { value: 400, configurable: true });
      Object.defineProperty(window, "innerHeight", { value: 300, configurable: true });

      document.body.innerHTML = `<button data-solv-target="btn">Save</button>`;
      const btn = document.querySelector("[data-solv-target='btn']") as HTMLElement;
      let currentRect = { top: 900, bottom: 940, left: 350, right: 420, width: 70, height: 40 };
      btn.getBoundingClientRect = () => currentRect as DOMRect;
      btn.scrollIntoView = () => {};

      installBuiltins({ enabled: true, allowedOrigins: [] });
      await runAction({
        callId: "c1",
        name: "highlight",
        input: { target: "btn", note: "Click here to save" },
        confirm: false,
      });

      const note = document.querySelector(".solv-highlight-note") as HTMLElement;
      expect(note).not.toBeNull();
      // Initially clamped within viewport (300px height).
      expect(Number.parseInt(note.style.top, 10)).toBeLessThanOrEqual(300 - 40 - 8);
      expect(Number.parseInt(note.style.left, 10)).toBeLessThanOrEqual(400 - 260 - 8);

      // Simulate smooth scroll bringing button into view.
      currentRect = { top: 100, bottom: 140, left: 40, right: 110, width: 70, height: 40 };
      window.dispatchEvent(new Event("scroll"));
      expect(note.style.top).toBe("148px");
      expect(note.style.left).toBe("40px");

      // After highlight expires, listeners are removed and note is gone.
      vi.advanceTimersByTime(HIGHLIGHT_DURATION_MS);
      expect(document.querySelector(".solv-highlight-note")).toBeNull();
      currentRect = { top: 20, bottom: 60, left: 10, right: 80, width: 70, height: 40 };
      window.dispatchEvent(new Event("scroll"));
      expect(note.style.top).toBe("148px");
    });
  });

  describe("F12: cross-origin navigation and continuation for configured origins", () => {
    it("navigates to an allowed origin, hands off conversation via URL fragment, and resumes on arrival even when window.name is cleared", async () => {
      const originalUrl = location.href;
      window.name = "host-window";
      let assignedUrl = "";
      const assign = vi.spyOn(location, "assign").mockImplementation((url: string | URL) => {
        assignedUrl = String(url);
      });
      const chatBodies: Array<Record<string, unknown>> = [];
      let chatStep = 0;

      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/v1/assistants/pk_cross_origin")) {
          return Response.json({
            title: "Helper",
            accentColor: "#2563eb",
            position: "right",
            greeting: "Hi!",
            suggestedQuestions: [],
            actions: { builtins: true, allowedOrigins: ["https://shop.example.com"] },
          });
        }
        if (url.endsWith("/v1/chat")) {
          chatStep++;
          chatBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
          if (chatStep === 1) {
            return new Response(
              sseStream([
                'event: token\ndata: {"text":"Opening your cart"}\n\n',
                'event: action\ndata: {"callId":"call_x","name":"navigate","input":{"url":"https://shop.example.com/cart"},"confirm":false}\n\n',
                'event: done\ndata: {"messageId":"msg_x1","conversationId":"conv_x","awaitingActions":["call_x"]}\n\n',
              ]),
              { status: 200, headers: { "content-type": "text/event-stream" } },
            );
          }
          return new Response(
            sseStream([
              'event: token\ndata: {"text":" — here is your cart."}\n\n',
              'event: done\ndata: {"messageId":"msg_x2","conversationId":"conv_x"}\n\n',
            ]),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response("Not found", { status: 404 });
      }) as typeof fetch;

      try {
        const el1 = document.createElement("solv-chat");
        el1.setAttribute("assistant", "pk_cross_origin");
        el1.setAttribute("endpoint", "https://bot.example.com");
        document.body.append(el1);
        await flushAsync();

        const root1 = el1.shadowRoot as ShadowRoot;
        (root1.querySelector(".solv-launcher") as HTMLButtonElement).click();
        (root1.querySelector("#solv-input") as HTMLTextAreaElement).value = "Open shop";
        (root1.querySelector(".solv-form") as HTMLFormElement).requestSubmit();
        await flushAsync();

        expect(assign).toHaveBeenCalledTimes(1);
        expect(assignedUrl).toMatch(/^https:\/\/shop\.example\.com\/cart#solv_handoff=/);
        expect(chatBodies).toHaveLength(1);
        expect(window.name).toBe("host-window");

        window.dispatchEvent(new Event("pagehide"));
        await flushAsync();
        el1.remove();
        clearRegistry();

        // Simulate real cross-site navigation: browser clears window.name and isolates storage.
        window.name = "";
        sessionStorage.clear();
        localStorage.clear();
        const happyWindow = window as unknown as { happyDOM?: { setURL: (url: string) => void } };
        happyWindow.happyDOM?.setURL(assignedUrl);

        const el2 = document.createElement("solv-chat");
        el2.setAttribute("assistant", "pk_cross_origin");
        el2.setAttribute("endpoint", "https://bot.example.com");
        document.body.append(el2);
        await flushAsync();

        expect(location.href).toBe("https://shop.example.com/cart");
        expect(chatBodies).toHaveLength(2);
        expect(chatBodies[1]?.conversationId).toBe("conv_x");
        expect(chatBodies[1]?.resumeMessageId).toBe("msg_x1");
        expect(chatBodies[1]?.visitorId).toBe(chatBodies[0]?.visitorId);
        expect(chatBodies[1]?.actionResults).toEqual([
          {
            callId: "call_x",
            ok: true,
            result: JSON.stringify({ opened: "https://shop.example.com/cart" }),
          },
        ]);

        const bubbles = (el2.shadowRoot as ShadowRoot).querySelectorAll(".solv-bubble--assistant");
        expect(bubbles[1]?.querySelector(".solv-bubble-text")?.textContent).toBe(
          "Opening your cart — here is your cart.",
        );
        expect(bubbles[1]?.querySelector(".solv-feedback")).not.toBeNull();
      } finally {
        const happyWindow = window as unknown as { happyDOM?: { setURL: (url: string) => void } };
        happyWindow.happyDOM?.setURL(originalUrl);
      }
    });

    it("preserves destination #section hash and rejects mismatched assistant or origin handoffs", async () => {
      const originalUrl = location.href;
      const saved = {
        conversationId: "conv_sec",
        open: true,
        turns: [{ role: "user" as const, text: "Go to payment" }],
      };
      const happyWindow = window as unknown as { happyDOM?: { setURL: (url: string) => void } };

      try {
        const { stageCrossOriginHandoff, consumeCrossOriginHandoff } = await import(
          "../src/storage.js"
        );
        const handoffUrl = stageCrossOriginHandoff(
          "pk_scope",
          "https://shop.example.com/checkout#payment",
          saved,
        );
        expect(handoffUrl).toMatch(/^https:\/\/shop\.example\.com\/checkout#payment&solv_handoff=/);

        // Wrong origin must not consume or adopt the handoff.
        happyWindow.happyDOM?.setURL(
          handoffUrl.replace("https://shop.example.com", "https://evil.example.com"),
        );
        expect(consumeCrossOriginHandoff("pk_scope")).toBeNull();

        // Wrong assistant on the target origin must not consume the handoff.
        happyWindow.happyDOM?.setURL(handoffUrl);
        expect(consumeCrossOriginHandoff("pk_other")).toBeNull();

        // Matching assistant and origin consumes it and restores #payment.
        const consumed = consumeCrossOriginHandoff("pk_scope");
        expect(consumed?.conversationId).toBe("conv_sec");
        expect(location.href).toBe("https://shop.example.com/checkout#payment");
      } finally {
        happyWindow.happyDOM?.setURL(originalUrl);
      }
    });

    it("stops navigation and resumes locally when cross-origin navigation is canceled", async () => {
      vi.useFakeTimers();
      window.name = "host-window";
      const stopSpy = vi.spyOn(window, "stop").mockImplementation(() => {});
      const assign = vi.spyOn(location, "assign").mockImplementation(() => {});
      const chatBodies: Array<Record<string, unknown>> = [];
      let chatStep = 0;

      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/v1/assistants/pk_cross_cancel")) {
          return Response.json({
            title: "Helper",
            accentColor: "#2563eb",
            position: "right",
            greeting: "Hi!",
            suggestedQuestions: [],
            actions: { builtins: true, allowedOrigins: ["https://shop.example.com"] },
          });
        }
        if (url.endsWith("/v1/chat")) {
          chatStep++;
          chatBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
          if (chatStep === 1) {
            return new Response(
              sseStream([
                'event: token\ndata: {"text":"Opening shop"}\n\n',
                'event: action\ndata: {"callId":"call_xc","name":"navigate","input":{"url":"https://shop.example.com/cart"},"confirm":false}\n\n',
                'event: done\ndata: {"messageId":"msg_xc1","conversationId":"conv_xc","awaitingActions":["call_xc"]}\n\n',
              ]),
              { status: 200, headers: { "content-type": "text/event-stream" } },
            );
          }
          return new Response(
            sseStream([
              'event: token\ndata: {"text":" — stayed here."}\n\n',
              'event: done\ndata: {"messageId":"msg_xc2","conversationId":"conv_xc"}\n\n',
            ]),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response("Not found", { status: 404 });
      }) as typeof fetch;

      const el = document.createElement("solv-chat");
      el.setAttribute("assistant", "pk_cross_cancel");
      document.body.append(el);
      await vi.advanceTimersByTimeAsync(0);

      const root = el.shadowRoot as ShadowRoot;
      (root.querySelector(".solv-launcher") as HTMLButtonElement).click();
      (root.querySelector("#solv-input") as HTMLTextAreaElement).value = "Open shop";
      (root.querySelector(".solv-form") as HTMLFormElement).requestSubmit();
      await vi.advanceTimersByTimeAsync(0);

      expect(assign).toHaveBeenCalledTimes(1);
      expect(String(assign.mock.calls[0]?.[0])).toMatch(
        /^https:\/\/shop\.example\.com\/cart#solv_handoff=/,
      );
      await vi.advanceTimersByTimeAsync(NAVIGATION_RECOVERY_MS);
      const recoverBtn = root.querySelector(".solv-nav-recover") as HTMLButtonElement | null;
      expect(recoverBtn).not.toBeNull();
      recoverBtn?.click();
      await vi.advanceTimersByTimeAsync(0);

      expect(stopSpy).toHaveBeenCalledTimes(1);
      expect(window.name).toBe("host-window");
      expect(chatBodies).toHaveLength(2);
      expect(chatBodies[1]?.actionResults).toEqual([
        {
          callId: "call_xc",
          ok: false,
          error: "Navigation was canceled.",
        },
      ]);
    });
  });

  describe("F13: same-page fragment removal in widget flow", () => {
    it("continues the answer without waiting for pagehide when removing a fragment", async () => {
      vi.useFakeTimers();
      const prevUrl = location.href;
      history.replaceState(null, "", "/pricing#details");
      const assign = vi.spyOn(location, "assign").mockImplementation(() => {});
      vi.spyOn(window, "scrollTo").mockImplementation(() => {});
      const chatBodies: Array<Record<string, unknown>> = [];
      let chatStep = 0;

      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/v1/assistants/pk_frag_clear")) {
          return Response.json({
            title: "Helper",
            accentColor: "#2563eb",
            position: "right",
            greeting: "Hi!",
            suggestedQuestions: [],
            actions: { builtins: true, allowedOrigins: [] },
          });
        }
        if (url.endsWith("/v1/chat")) {
          chatStep++;
          chatBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
          if (chatStep === 1) {
            return new Response(
              sseStream([
                'event: token\ndata: {"text":"Returning to top"}\n\n',
                'event: action\ndata: {"callId":"call_frag","name":"navigate","input":{"url":"/pricing"},"confirm":false}\n\n',
                'event: done\ndata: {"messageId":"msg_f1","conversationId":"conv_f","awaitingActions":["call_frag"]}\n\n',
              ]),
              { status: 200, headers: { "content-type": "text/event-stream" } },
            );
          }
          return new Response(
            sseStream([
              'event: token\ndata: {"text":" — back at pricing overview."}\n\n',
              'event: done\ndata: {"messageId":"msg_f2","conversationId":"conv_f"}\n\n',
            ]),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response("Not found", { status: 404 });
      }) as typeof fetch;

      try {
        const el = document.createElement("solv-chat");
        el.setAttribute("assistant", "pk_frag_clear");
        document.body.append(el);
        await vi.advanceTimersByTimeAsync(0);

        const root = el.shadowRoot as ShadowRoot;
        (root.querySelector(".solv-launcher") as HTMLButtonElement).click();
        (root.querySelector("#solv-input") as HTMLTextAreaElement).value = "Back to pricing";
        (root.querySelector(".solv-form") as HTMLFormElement).requestSubmit();
        await vi.advanceTimersByTimeAsync(0);

        expect(assign).not.toHaveBeenCalled();
        expect(location.pathname).toBe("/pricing");
        expect(location.hash).toBe("");
        expect(root.querySelector(".solv-nav-recover")).toBeNull();
        expect(chatBodies).toHaveLength(2);
        expect(chatBodies[1]?.actionResults).toEqual([
          {
            callId: "call_frag",
            ok: true,
            result: JSON.stringify({ opened: new URL("/pricing", location.href).href }),
          },
        ]);

        const bubbles = root.querySelectorAll(".solv-bubble--assistant");
        expect(bubbles[1]?.querySelector(".solv-bubble-text")?.textContent).toBe(
          "Returning to top — back at pricing overview.",
        );
        expect(bubbles[1]?.querySelector(".solv-action")?.textContent).toBe("Ran navigate");
        expect(bubbles[1]?.querySelector(".solv-feedback")).not.toBeNull();
      } finally {
        history.replaceState(null, "", prevUrl);
      }
    });
  });

  describe("F7: serialized schema byte budgeting with JSON escaping", () => {
    it("excludes escaped markers that would exceed MAX_ACTION_SCHEMA_BYTES on install and refresh", () => {
      const encoder = new TextEncoder();
      // 9,000 backslashes are 9,000 UTF-8 bytes raw, but 18,002 bytes JSON-serialized.
      const escapedHeavy = "\\".repeat(9000);

      document.body.innerHTML = `
        <button data-solv-target="${escapedHeavy}">Heavy</button>
        <button data-solv-target="save_btn">Save</button>
      `;

      installBuiltins({ enabled: true, allowedOrigins: [] });
      const onInstall = listForRequest().find((a) => a.name === "highlight");
      expect(onInstall).toBeDefined();
      expect(encoder.encode(JSON.stringify(onInstall?.inputSchema)).byteLength).toBeLessThanOrEqual(
        MAX_ACTION_SCHEMA_BYTES,
      );
      const installProps = (onInstall?.inputSchema.properties ?? {}) as Record<
        string,
        { enum?: string[] }
      >;
      expect(installProps.target?.enum).toEqual(["save_btn"]);

      // Now add another escaped-heavy marker after install and refresh via listForRequest().
      const extra = document.createElement("input");
      extra.setAttribute("data-solv-fill", "\\".repeat(9000));
      document.body.append(extra);
      const validInput = document.createElement("input");
      validInput.setAttribute("data-solv-fill", "work_email");
      document.body.append(validInput);

      const refreshed = listForRequest();
      const fillAction = refreshed.find((a) => a.name === "fill");
      expect(fillAction).toBeDefined();
      expect(
        encoder.encode(JSON.stringify(fillAction?.inputSchema)).byteLength,
      ).toBeLessThanOrEqual(MAX_ACTION_SCHEMA_BYTES);
      const fillProps = (fillAction?.inputSchema.properties ?? {}) as Record<
        string,
        { items?: { properties?: Record<string, { enum?: string[] }> } }
      >;
      expect(fillProps.fields?.items?.properties?.name?.enum).toEqual(["work_email"]);
    });

    it("caps cumulative serialized schema size including structural overhead", () => {
      const encoder = new TextEncoder();
      // Five 4,000-byte markers = 20,000+ bytes total; only a subset can fit within 16 KiB.
      for (let i = 0; i < 5; i++) {
        const el = document.createElement("button");
        el.setAttribute("data-solv-target", `${i}_${"a".repeat(3998)}`);
        document.body.append(el);
      }

      installBuiltins({ enabled: true, allowedOrigins: [] });
      const highlight = listForRequest().find((a) => a.name === "highlight");
      const bytes = encoder.encode(JSON.stringify(highlight?.inputSchema)).byteLength;
      expect(bytes).toBeLessThanOrEqual(MAX_ACTION_SCHEMA_BYTES);
      const props = (highlight?.inputSchema.properties ?? {}) as Record<
        string,
        { enum?: string[] }
      >;
      expect((props.target?.enum ?? []).length).toBe(4);
    });
  });

  describe("F8: canceled or failed navigation recovery", () => {
    it("clears pendingResume and continues the answer when document remains active after canceled navigation", async () => {
      vi.useFakeTimers();
      const assign = vi.spyOn(location, "assign").mockImplementation(() => {
        // Simulate beforeunload confirmation canceled by visitor: document stays mounted, no pagehide.
      });
      const chatBodies: Array<Record<string, unknown>> = [];
      let chatStep = 0;

      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/v1/assistants/pk_nav_cancel")) {
          return Response.json({
            title: "Helper",
            accentColor: "#2563eb",
            position: "right",
            greeting: "Hi!",
            suggestedQuestions: [],
            actions: { builtins: true, allowedOrigins: [] },
          });
        }
        if (url.endsWith("/v1/chat")) {
          chatStep++;
          chatBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
          if (chatStep === 1) {
            return new Response(
              sseStream([
                'event: token\ndata: {"text":"Opening pricing"}\n\n',
                'event: action\ndata: {"callId":"call_cancel","name":"navigate","input":{"url":"/pricing"},"confirm":false}\n\n',
                'event: done\ndata: {"messageId":"msg_c1","conversationId":"conv_c","awaitingActions":["call_cancel"]}\n\n',
              ]),
              { status: 200, headers: { "content-type": "text/event-stream" } },
            );
          }
          return new Response(
            sseStream([
              'event: token\ndata: {"text":" — stayed on this page."}\n\n',
              'event: done\ndata: {"messageId":"msg_c2","conversationId":"conv_c"}\n\n',
            ]),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response("Not found", { status: 404 });
      }) as typeof fetch;

      const el = document.createElement("solv-chat");
      el.setAttribute("assistant", "pk_nav_cancel");
      document.body.append(el);
      await vi.advanceTimersByTimeAsync(0);

      const root = el.shadowRoot as ShadowRoot;
      (root.querySelector(".solv-launcher") as HTMLButtonElement).click();
      (root.querySelector("#solv-input") as HTMLTextAreaElement).value = "Go to pricing";
      (root.querySelector(".solv-form") as HTMLFormElement).requestSubmit();
      await vi.advanceTimersByTimeAsync(0);

      expect(assign).toHaveBeenCalledTimes(1);
      // Pre-navigation persistence occurred.
      const preSaved = JSON.parse(
        sessionStorage.getItem("solv-chat-open:pk_nav_cancel") ?? "{}",
      ) as { pendingResume?: { resumeMessageId: string } };
      expect(preSaved.pendingResume?.resumeMessageId).toBe("msg_c1");

      // Document remains active past recovery window: widget preserves handoff and offers recovery.
      await vi.advanceTimersByTimeAsync(NAVIGATION_RECOVERY_MS);

      expect(assign).toHaveBeenCalledTimes(1);
      expect(chatBodies).toHaveLength(1);
      const stillSaved = JSON.parse(
        sessionStorage.getItem("solv-chat-open:pk_nav_cancel") ?? "{}",
      ) as { pendingResume?: { resumeMessageId: string } };
      expect(stillSaved.pendingResume?.resumeMessageId).toBe("msg_c1");

      const recoverBtn = root.querySelector(".solv-nav-recover") as HTMLButtonElement | null;
      expect(recoverBtn).not.toBeNull();
      recoverBtn?.click();
      await vi.advanceTimersByTimeAsync(0);

      expect(root.querySelector(".solv-nav-recover")).toBeNull();
      expect(chatBodies).toHaveLength(2);
      expect(chatBodies[1]?.resumeMessageId).toBe("msg_c1");
      expect(chatBodies[1]?.actionResults).toEqual([
        {
          callId: "call_cancel",
          ok: false,
          error: "Navigation was canceled.",
        },
      ]);

      const postSaved = JSON.parse(
        sessionStorage.getItem("solv-chat-open:pk_nav_cancel") ?? "{}",
      ) as { pendingResume?: unknown };
      expect(postSaved.pendingResume).toBeUndefined();

      const bubbles = root.querySelectorAll(".solv-bubble--assistant");
      const activeBubble = bubbles[1];
      expect(activeBubble?.querySelector(".solv-bubble-text")?.textContent).toBe(
        "Opening pricing — stayed on this page.",
      );
      expect(activeBubble?.querySelector(".solv-action")?.textContent).toBe(
        "Could not run navigate",
      );
      expect(activeBubble?.querySelector(".solv-feedback")).not.toBeNull();
    });

    it("preserves pendingResume when a slow navigation departs after NAVIGATION_RECOVERY_MS", async () => {
      vi.useFakeTimers();
      vi.spyOn(location, "assign").mockImplementation(() => {});
      const chatBodies: Array<Record<string, unknown>> = [];
      let chatStep = 0;

      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/v1/assistants/pk_nav_slow")) {
          return Response.json({
            title: "Helper",
            accentColor: "#2563eb",
            position: "right",
            greeting: "Hi!",
            suggestedQuestions: [],
            actions: { builtins: true, allowedOrigins: [] },
          });
        }
        if (url.endsWith("/v1/chat")) {
          chatStep++;
          chatBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
          if (chatStep === 1) {
            return new Response(
              sseStream([
                'event: token\ndata: {"text":"Opening pricing"}\n\n',
                'event: action\ndata: {"callId":"call_slow","name":"navigate","input":{"url":"/pricing"},"confirm":false}\n\n',
                'event: done\ndata: {"messageId":"msg_s1","conversationId":"conv_s","awaitingActions":["call_slow"]}\n\n',
              ]),
              { status: 200, headers: { "content-type": "text/event-stream" } },
            );
          }
          return new Response(
            sseStream([
              'event: token\ndata: {"text":" — welcome to pricing."}\n\n',
              'event: done\ndata: {"messageId":"msg_s2","conversationId":"conv_s"}\n\n',
            ]),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response("Not found", { status: 404 });
      }) as typeof fetch;

      const el1 = document.createElement("solv-chat");
      el1.setAttribute("assistant", "pk_nav_slow");
      document.body.append(el1);
      await vi.advanceTimersByTimeAsync(0);

      const root1 = el1.shadowRoot as ShadowRoot;
      (root1.querySelector(".solv-launcher") as HTMLButtonElement).click();
      (root1.querySelector("#solv-input") as HTMLTextAreaElement).value = "Go to pricing";
      (root1.querySelector(".solv-form") as HTMLFormElement).requestSubmit();
      await vi.advanceTimersByTimeAsync(0);

      // Slow destination takes longer than NAVIGATION_RECOVERY_MS.
      await vi.advanceTimersByTimeAsync(NAVIGATION_RECOVERY_MS * 3);
      expect(chatBodies).toHaveLength(1);
      expect(root1.querySelector(".solv-nav-recover")).not.toBeNull();
      const midSaved = JSON.parse(sessionStorage.getItem("solv-chat-open:pk_nav_slow") ?? "{}") as {
        pendingResume?: { resumeMessageId: string };
      };
      expect(midSaved.pendingResume?.resumeMessageId).toBe("msg_s1");

      // Destination finally responds and replaces the document.
      window.dispatchEvent(new Event("pagehide"));
      await vi.advanceTimersByTimeAsync(0);
      expect(chatBodies).toHaveLength(1);
      expect(root1.querySelector(".solv-nav-recover")).toBeNull();

      el1.remove();
      clearRegistry();
      const el2 = document.createElement("solv-chat");
      el2.setAttribute("assistant", "pk_nav_slow");
      document.body.append(el2);
      await vi.advanceTimersByTimeAsync(0);

      expect(chatBodies).toHaveLength(2);
      expect(chatBodies[1]?.resumeMessageId).toBe("msg_s1");
      expect(chatBodies[1]?.actionResults).toEqual([
        {
          callId: "call_slow",
          ok: true,
          result: JSON.stringify({ opened: new URL("/pricing", location.href).href }),
        },
      ]);
      const bubbles = (el2.shadowRoot as ShadowRoot).querySelectorAll(".solv-bubble--assistant");
      expect(bubbles[1]?.querySelector(".solv-bubble-text")?.textContent).toBe(
        "Opening pricing — welcome to pricing.",
      );
    });

    it("recovers immediately when location.assign throws synchronously", async () => {
      const assign = vi.spyOn(location, "assign").mockImplementation(() => {
        throw new Error("Navigation blocked");
      });
      const chatBodies: Array<Record<string, unknown>> = [];
      let chatStep = 0;

      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/v1/assistants/pk_nav_throw")) {
          return Response.json({
            title: "Helper",
            accentColor: "#2563eb",
            position: "right",
            greeting: "Hi!",
            suggestedQuestions: [],
            actions: { builtins: true, allowedOrigins: [] },
          });
        }
        if (url.endsWith("/v1/chat")) {
          chatStep++;
          chatBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
          if (chatStep === 1) {
            return new Response(
              sseStream([
                'event: token\ndata: {"text":"Trying"}\n\n',
                'event: action\ndata: {"callId":"call_throw","name":"navigate","input":{"url":"/pricing"},"confirm":false}\n\n',
                'event: done\ndata: {"messageId":"msg_t1","conversationId":"conv_t","awaitingActions":["call_throw"]}\n\n',
              ]),
              { status: 200, headers: { "content-type": "text/event-stream" } },
            );
          }
          return new Response(
            sseStream([
              'event: token\ndata: {"text":" — could not open."}\n\n',
              'event: done\ndata: {"messageId":"msg_t2","conversationId":"conv_t"}\n\n',
            ]),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response("Not found", { status: 404 });
      }) as typeof fetch;

      const el = document.createElement("solv-chat");
      el.setAttribute("assistant", "pk_nav_throw");
      document.body.append(el);
      await flushAsync();

      const root = el.shadowRoot as ShadowRoot;
      (root.querySelector(".solv-launcher") as HTMLButtonElement).click();
      (root.querySelector("#solv-input") as HTMLTextAreaElement).value = "Go to pricing";
      (root.querySelector(".solv-form") as HTMLFormElement).requestSubmit();
      await flushAsync();

      expect(assign).toHaveBeenCalledTimes(1);
      expect(chatBodies).toHaveLength(2);
      expect(chatBodies[1]?.actionResults).toEqual([
        {
          callId: "call_throw",
          ok: false,
          error: "That action did not finish.",
        },
      ]);
      const postSaved = JSON.parse(
        sessionStorage.getItem("solv-chat-open:pk_nav_throw") ?? "{}",
      ) as { pendingResume?: unknown };
      expect(postSaved.pendingResume).toBeUndefined();
      const bubbles = root.querySelectorAll(".solv-bubble--assistant");
      expect(bubbles[1]?.querySelector(".solv-action")?.textContent).toBe("Could not run navigate");
      expect(bubbles[1]?.querySelector(".solv-feedback")).not.toBeNull();
    });
  });

  describe("F15: recovery stops pending navigation and respects departure", () => {
    it("stops a delayed pending navigation before clearing pendingResume and resuming locally", async () => {
      vi.useFakeTimers();
      let pendingNavTimer: ReturnType<typeof setTimeout> | null = null;
      let departed = false;
      const events: string[] = [];

      vi.spyOn(location, "assign").mockImplementation(() => {
        pendingNavTimer = setTimeout(() => {
          departed = true;
          window.dispatchEvent(new Event("pagehide"));
        }, NAVIGATION_RECOVERY_MS * 2);
      });
      const stopSpy = vi.spyOn(window, "stop").mockImplementation(() => {
        events.push("window.stop");
        if (pendingNavTimer !== null) {
          clearTimeout(pendingNavTimer);
          pendingNavTimer = null;
        }
      });

      const chatBodies: Array<Record<string, unknown>> = [];
      let chatStep = 0;

      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/v1/assistants/pk_nav_delay")) {
          return Response.json({
            title: "Helper",
            accentColor: "#2563eb",
            position: "right",
            greeting: "Hi!",
            suggestedQuestions: [],
            actions: { builtins: true, allowedOrigins: ["https://shop.example.com"] },
          });
        }
        if (url.endsWith("/v1/chat")) {
          chatStep++;
          if (chatStep === 2) events.push("resume.fetch");
          chatBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
          if (chatStep === 1) {
            return new Response(
              sseStream([
                'event: token\ndata: {"text":"Opening shop"}\n\n',
                'event: action\ndata: {"callId":"call_delay","name":"navigate","input":{"url":"https://shop.example.com/cart"},"confirm":false}\n\n',
                'event: done\ndata: {"messageId":"msg_d1","conversationId":"conv_d","awaitingActions":["call_delay"]}\n\n',
              ]),
              { status: 200, headers: { "content-type": "text/event-stream" } },
            );
          }
          return new Response(
            sseStream([
              'event: token\ndata: {"text":" — canceled and continued here."}\n\n',
              'event: done\ndata: {"messageId":"msg_d2","conversationId":"conv_d"}\n\n',
            ]),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response("Not found", { status: 404 });
      }) as typeof fetch;

      const el = document.createElement("solv-chat");
      el.setAttribute("assistant", "pk_nav_delay");
      document.body.append(el);
      await vi.advanceTimersByTimeAsync(0);

      const root = el.shadowRoot as ShadowRoot;
      (root.querySelector(".solv-launcher") as HTMLButtonElement).click();
      (root.querySelector("#solv-input") as HTMLTextAreaElement).value = "Open shop";
      (root.querySelector(".solv-form") as HTMLFormElement).requestSubmit();
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(NAVIGATION_RECOVERY_MS);
      const recoverBtn = root.querySelector(".solv-nav-recover") as HTMLButtonElement | null;
      expect(recoverBtn).not.toBeNull();
      recoverBtn?.click();
      await vi.advanceTimersByTimeAsync(0);

      expect(stopSpy).toHaveBeenCalledTimes(1);
      expect(events).toEqual(["window.stop", "resume.fetch"]);

      // Even after the original delayed navigation window elapses, departure never occurs.
      await vi.advanceTimersByTimeAsync(NAVIGATION_RECOVERY_MS * 3);
      expect(departed).toBe(false);
      expect(chatBodies).toHaveLength(2);
      const postSaved = JSON.parse(
        sessionStorage.getItem("solv-chat-open:pk_nav_delay") ?? "{}",
      ) as { pendingResume?: unknown };
      expect(postSaved.pendingResume).toBeUndefined();
    });

    it("retains continuation state when departure has already begun during recovery", async () => {
      vi.useFakeTimers();
      vi.spyOn(location, "assign").mockImplementation(() => {});
      vi.spyOn(window, "stop").mockImplementation(() => {
        // Simulate a navigation that already committed just as recovery was clicked.
        window.dispatchEvent(new Event("pagehide"));
      });
      const chatBodies: Array<Record<string, unknown>> = [];

      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/v1/assistants/pk_nav_departing")) {
          return Response.json({
            title: "Helper",
            accentColor: "#2563eb",
            position: "right",
            greeting: "Hi!",
            suggestedQuestions: [],
            actions: { builtins: true, allowedOrigins: [] },
          });
        }
        if (url.endsWith("/v1/chat")) {
          chatBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
          return new Response(
            sseStream([
              'event: token\ndata: {"text":"Opening pricing"}\n\n',
              'event: action\ndata: {"callId":"call_dep","name":"navigate","input":{"url":"/pricing"},"confirm":false}\n\n',
              'event: done\ndata: {"messageId":"msg_dep1","conversationId":"conv_dep","awaitingActions":["call_dep"]}\n\n',
            ]),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response("Not found", { status: 404 });
      }) as typeof fetch;

      const el = document.createElement("solv-chat");
      el.setAttribute("assistant", "pk_nav_departing");
      document.body.append(el);
      await vi.advanceTimersByTimeAsync(0);

      const root = el.shadowRoot as ShadowRoot;
      (root.querySelector(".solv-launcher") as HTMLButtonElement).click();
      (root.querySelector("#solv-input") as HTMLTextAreaElement).value = "Go to pricing";
      (root.querySelector(".solv-form") as HTMLFormElement).requestSubmit();
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(NAVIGATION_RECOVERY_MS);
      const recoverBtn = root.querySelector(".solv-nav-recover") as HTMLButtonElement | null;
      expect(recoverBtn).not.toBeNull();
      recoverBtn?.click();
      await vi.advanceTimersByTimeAsync(0);

      // Local resume must NOT run, and pendingResume must remain intact for the destination.
      expect(chatBodies).toHaveLength(1);
      const saved = JSON.parse(
        sessionStorage.getItem("solv-chat-open:pk_nav_departing") ?? "{}",
      ) as { pendingResume?: { resumeMessageId: string } };
      expect(saved.pendingResume?.resumeMessageId).toBe("msg_dep1");
    });
  });
});
