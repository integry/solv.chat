import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/widget.js";

const happy = (
  window as unknown as {
    happyDOM: { setViewport(v: { width: number; height: number }): void };
  }
).happyDOM;

function mountWidget(assistant = "pk_expand"): HTMLElement {
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

function q<T extends Element>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element: ${selector}`);
  return el;
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function serveConfig(config: Record<string, unknown>): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/v1/assistants/")) return Response.json(config);
    return new Response("Not found", { status: 404 });
  }) as typeof fetch;
}

const root = () => document.documentElement;

describe("expanding to a side panel", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    document.body.replaceChildren();
    root().removeAttribute("style");
    happy.setViewport({ width: 1280, height: 800 });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    document.body.replaceChildren();
    root().removeAttribute("style");
  });

  it("expands beside the page, narrows the page by the column, and collapses back exactly", async () => {
    serveConfig({ title: "Docs" });
    const el = mountWidget();
    await flushAsync();
    const r = shadow(el);
    const expand = q<HTMLButtonElement>(r, ".solv-expand");
    const collapse = q<HTMLButtonElement>(r, ".solv-collapse");
    const launcher = q<HTMLButtonElement>(r, ".solv-launcher");

    launcher.click();
    expect(expand.hidden).toBe(false);
    expect(collapse.hidden).toBe(true);
    expect(expand.getAttribute("aria-label")).toBe("Expand to a side panel");
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expect(expand.getAttribute("aria-controls")).toBe("solv-panel");

    expand.click();
    expect(el.getAttribute("data-layout")).toBe("side");
    expect(root().style.getPropertyValue("margin-right")).toBe("460px");
    expect(root().style.getPropertyValue("--solv-chat-panel-width")).toBe("460px");
    expect(launcher.hidden).toBe(true);
    expect(expand.hidden).toBe(true);
    expect(collapse.hidden).toBe(false);
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    // Focus stays in the panel, on the control that undoes it.
    expect(r.activeElement).toBe(collapse);

    collapse.click();
    expect(el.hasAttribute("data-layout")).toBe(false);
    expect(root().getAttribute("style")).toBeNull();
    expect(launcher.hidden).toBe(false);
    expect(r.activeElement).toBe(expand);
  });

  it("reserves room on the left for a left widget", async () => {
    serveConfig({ widget: { position: "left" } });
    const el = mountWidget();
    await flushAsync();
    const r = shadow(el);
    q<HTMLButtonElement>(r, ".solv-launcher").click();
    q<HTMLButtonElement>(r, ".solv-expand").click();
    expect(root().style.getPropertyValue("margin-left")).toBe("460px");
    expect(root().style.getPropertyValue("margin-right")).toBe("");
  });

  it("keeps the host's own inline margin and puts its style back byte for byte", async () => {
    const hostStyle = "margin-right: 12px; color: red; --solv-chat-panel-width: 1px";
    root().setAttribute("style", hostStyle);
    serveConfig({});
    const el = mountWidget();
    await flushAsync();
    const r = shadow(el);
    q<HTMLButtonElement>(r, ".solv-launcher").click();
    q<HTMLButtonElement>(r, ".solv-expand").click();
    expect(root().style.getPropertyValue("margin-right")).toBe("calc(12px + 460px)");
    expect(root().style.getPropertyValue("--solv-chat-panel-width")).toBe("460px");
    expect(root().style.getPropertyValue("color")).toBe("red");

    q<HTMLButtonElement>(r, ".solv-collapse").click();
    expect(root().getAttribute("style")).toBe(hostStyle);

    // Removing the element while expanded restores it too.
    q<HTMLButtonElement>(r, ".solv-expand").click();
    expect(root().style.getPropertyValue("margin-right")).toBe("calc(12px + 460px)");
    el.remove();
    expect(root().getAttribute("style")).toBe(hostStyle);
  });

  it("limits the root's width beside the column, within the host's own maximum, and puts it back", async () => {
    const hostStyle = "max-width: 900px; width: 100%";
    root().setAttribute("style", hostStyle);
    serveConfig({});
    const el = mountWidget();
    await flushAsync();
    const r = shadow(el);
    q<HTMLButtonElement>(r, ".solv-launcher").click();
    q<HTMLButtonElement>(r, ".solv-expand").click();
    const limit = root().style.getPropertyValue("max-width");
    expect(limit).toMatch(/^min\(900px, calc\(100% - [\d.]+px\)\)$/);
    expect(limit).toContain("460");
    expect(root().style.getPropertyPriority("max-width")).toBe("important");
    expect(root().style.getPropertyValue("width")).toBe("100%");

    q<HTMLButtonElement>(r, ".solv-collapse").click();
    expect(root().getAttribute("style")).toBe(hostStyle);
  });

  for (const [side, important] of [
    ["right", false],
    ["right", true],
    ["left", true],
  ] as const) {
    it(`gives back the host's own inline margin-${side} and max-width${important ? " (!important)" : ""} on collapse and on removal`, async () => {
      const bang = important ? " !important" : "";
      const hostStyle = `margin-${side}: 8px${bang}; max-width: 1100px${bang}; background: rgb(250, 250, 250)`;
      root().setAttribute("style", hostStyle);
      serveConfig({ widget: { position: side } });
      const el = mountWidget();
      await flushAsync();
      const r = shadow(el);
      q<HTMLButtonElement>(r, ".solv-launcher").click();
      q<HTMLButtonElement>(r, ".solv-expand").click();
      const style = root().style;
      expect(style.getPropertyValue(`margin-${side}`)).toBe("calc(8px + 460px)");
      expect(style.getPropertyPriority(`margin-${side}`)).toBe("important");
      expect(style.getPropertyValue("max-width")).toMatch(
        /^min\(1100px, calc\(100% - [\d.]+px\)\)$/,
      );
      expect(style.getPropertyPriority("max-width")).toBe("important");

      q<HTMLButtonElement>(r, ".solv-collapse").click();
      expect(root().getAttribute("style")).toBe(hostStyle);

      q<HTMLButtonElement>(r, ".solv-expand").click();
      el.remove();
      expect(root().getAttribute("style")).toBe(hostStyle);
    });
  }

  it("puts the host's own margin and max-width back, with their priority, when the host changed something else meanwhile", async () => {
    root().setAttribute("style", "margin-right: 8px !important; max-width: 1100px");
    serveConfig({});
    const el = mountWidget();
    await flushAsync();
    const r = shadow(el);
    q<HTMLButtonElement>(r, ".solv-launcher").click();
    q<HTMLButtonElement>(r, ".solv-expand").click();
    // The host's own script sets something while the column is open.
    root().style.setProperty("color", "red");
    el.remove();
    const style = root().style;
    expect(style.getPropertyValue("margin-right")).toBe("8px");
    expect(style.getPropertyPriority("margin-right")).toBe("important");
    expect(style.getPropertyValue("max-width")).toBe("1100px");
    expect(style.getPropertyPriority("max-width")).toBe("");
    expect(style.getPropertyValue("--solv-chat-panel-width")).toBe("");
    expect(style.getPropertyValue("color")).toBe("red");
  });

  it("closing from the expanded state, by the close button or Escape, restores the page width", async () => {
    serveConfig({});
    const el = mountWidget();
    await flushAsync();
    const r = shadow(el);
    const launcher = q<HTMLButtonElement>(r, ".solv-launcher");
    launcher.click();
    q<HTMLButtonElement>(r, ".solv-expand").click();
    q<HTMLButtonElement>(r, ".solv-close").click();
    expect(root().getAttribute("style")).toBeNull();
    expect(launcher.hidden).toBe(false);
    expect(r.activeElement).toBe(launcher);

    // Reopened, it is still the side panel the visitor chose.
    launcher.click();
    expect(el.getAttribute("data-layout")).toBe("side");
    q<HTMLDivElement>(r, ".solv-panel").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(q<HTMLDivElement>(r, ".solv-panel").hidden).toBe(true);
    expect(root().getAttribute("style")).toBeNull();
  });

  it("opens full screen below 900px wide, without narrowing the page, and switches as the viewport changes", async () => {
    happy.setViewport({ width: 899, height: 800 });
    serveConfig({});
    const el = mountWidget();
    await flushAsync();
    const r = shadow(el);
    q<HTMLButtonElement>(r, ".solv-launcher").click();
    q<HTMLButtonElement>(r, ".solv-expand").click();
    expect(el.getAttribute("data-layout")).toBe("full");
    expect(root().getAttribute("style")).toBeNull();

    happy.setViewport({ width: 900, height: 800 });
    await flushAsync();
    expect(el.getAttribute("data-layout")).toBe("side");
    expect(root().style.getPropertyValue("margin-right")).toBe("460px");

    happy.setViewport({ width: 380, height: 700 });
    await flushAsync();
    expect(el.getAttribute("data-layout")).toBe("full");
    expect(root().getAttribute("style")).toBeNull();
  });

  it("stores nothing before the visitor opens the assistant, and remembers expanded across a page change", async () => {
    serveConfig({});
    const el = mountWidget();
    await flushAsync();
    const r = shadow(el);
    // Before the first open: the expand control cannot act, and a viewport
    // change runs the layout, yet nothing at all is written.
    q<HTMLButtonElement>(r, ".solv-expand").click();
    happy.setViewport({ width: 899, height: 800 });
    happy.setViewport({ width: 1280, height: 800 });
    await flushAsync();
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
    expect(el.hasAttribute("data-layout")).toBe(false);
    expect(root().getAttribute("style")).toBeNull();

    q<HTMLButtonElement>(r, ".solv-launcher").click();
    const saved = () => JSON.parse(sessionStorage.getItem("solv-chat-open:pk_expand") ?? "{}");
    expect(saved().expanded).toBeUndefined();
    q<HTMLButtonElement>(r, ".solv-expand").click();
    expect(saved()).toMatchObject({ open: true, expanded: true });

    // The next page in the same tab.
    el.remove();
    expect(root().getAttribute("style")).toBeNull();
    const next = mountWidget();
    await flushAsync();
    expect(next.getAttribute("data-layout")).toBe("side");
    expect(root().style.getPropertyValue("margin-right")).toBe("460px");
    expect(q<HTMLButtonElement>(shadow(next), ".solv-launcher").hidden).toBe(true);

    q<HTMLButtonElement>(shadow(next), ".solv-collapse").click();
    expect(saved().expanded).toBeUndefined();
  });

  it("does not render the control when the owner turns it off, and collapses a remembered side panel", async () => {
    sessionStorage.setItem(
      "solv-chat-open:pk_expand",
      JSON.stringify({ conversationId: null, open: true, expanded: true, turns: [] }),
    );
    serveConfig({ widget: { allowExpand: false } });
    const el = mountWidget();
    await flushAsync();
    const r = shadow(el);
    // Not rendered at all: no hidden button left for a screen reader or Tab.
    expect(r.querySelector(".solv-expand")).toBeNull();
    expect(r.querySelector(".solv-collapse")).toBeNull();
    expect([...r.querySelectorAll(".solv-header button")].map((b) => b.className)).toEqual([
      "solv-close",
    ]);
    expect(el.hasAttribute("data-layout")).toBe(false);
    expect(root().getAttribute("style")).toBeNull();
    expect(q<HTMLButtonElement>(r, ".solv-launcher").hidden).toBe(false);
  });

  it("keeps the floating layout from an older tab when the owner switches to side panel", async () => {
    sessionStorage.setItem(
      "solv-chat-open:pk_expand",
      JSON.stringify({ conversationId: null, open: false, turns: [] }),
    );
    serveConfig({ widget: { opensAs: "side" } });
    const el = mountWidget();
    await flushAsync();

    q<HTMLButtonElement>(shadow(el), ".solv-launcher").click();
    expect(q<HTMLDivElement>(shadow(el), ".solv-panel").hidden).toBe(false);
    expect(el.hasAttribute("data-layout")).toBe(false);
  });

  it("preview() hides the control when the setting is off", () => {
    const el = document.createElement("solv-chat") as HTMLElement & {
      preview(config: unknown): void;
    };
    document.body.append(el);
    el.preview({ widget: { title: "Docs", allowExpand: false } });
    expect(shadow(el).querySelector(".solv-expand")).toBeNull();
    expect(shadow(el).querySelector(".solv-collapse")).toBeNull();
    el.preview({ widget: { title: "Docs", allowExpand: true } });
    expect(q<HTMLButtonElement>(shadow(el), ".solv-expand").hidden).toBe(false);
    // Back in the header, before the close button.
    expect([...shadow(el).querySelectorAll(".solv-header button")].map((b) => b.className)).toEqual(
      ["solv-expand", "solv-collapse", "solv-close"],
    );
  });
});
