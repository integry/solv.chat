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
    expect(sessionStorage.length).toBe(0);

    const r = shadow(el);
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
    expect(q<HTMLButtonElement>(r, ".solv-expand").hidden).toBe(true);
    expect(q<HTMLButtonElement>(r, ".solv-collapse").hidden).toBe(true);
    expect(el.hasAttribute("data-layout")).toBe(false);
    expect(root().getAttribute("style")).toBeNull();
    expect(q<HTMLButtonElement>(r, ".solv-launcher").hidden).toBe(false);
  });

  it("preview() hides the control when the setting is off", () => {
    const el = document.createElement("solv-chat") as HTMLElement & {
      preview(config: unknown): void;
    };
    document.body.append(el);
    el.preview({ widget: { title: "Docs", allowExpand: false } });
    expect(q<HTMLButtonElement>(shadow(el), ".solv-expand").hidden).toBe(true);
    el.preview({ widget: { title: "Docs", allowExpand: true } });
    expect(q<HTMLButtonElement>(shadow(el), ".solv-expand").hidden).toBe(false);
  });
});
