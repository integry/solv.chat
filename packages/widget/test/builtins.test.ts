import { MAX_PAGE_ACTIONS } from "@solvchat/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegistry, listForRequest, lookup, register, runAction } from "../src/actions.js";
import { HIGHLIGHT_DURATION_MS, installBuiltins } from "../src/builtins.js";
import "../src/widget.js";

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

    it("navigates to a listed allowed origin", async () => {
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
});
