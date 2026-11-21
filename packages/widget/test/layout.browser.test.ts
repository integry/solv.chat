// @vitest-environment node
/**
 * The panel's size, the side panel and the streamed answer in a real browser.
 * A local server plays two origins, the owner's pages and the engine (widget
 * script, config and a chat stream that writes one token at a time). Nothing
 * is intercepted: the page fetches the engine across origins, CORS preflight
 * included, as it does on a live site.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Browser, findChrome, launch, waitFor } from "./support/chromium.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chrome = findChrome();

const CODE_LINE = "const result = await client.documents.search({ query, limit: 5 });";
const ANSWER_TOKENS = [
  "To search ",
  "your docs:\n\n",
  "1. Create ",
  "a client.\n",
  "2. Call ",
  "[search](https://docs.example.com/search).\n",
  "3. Read ",
  "the **results**.\n\n",
  "```js\n",
  `${CODE_LINE}\n`,
  "```\n",
  "That is all.",
];

function listen(server: Server): Promise<number> {
  return new Promise((ok) =>
    server.listen(0, "127.0.0.1", () => ok((server.address() as AddressInfo).port)),
  );
}

describe.skipIf(chrome === null)("panel layout and streaming in Chromium", () => {
  let widgetJs = "";
  const servers: Server[] = [];
  let hostPort = 0;
  let enginePort = 0;
  let browser: Browser;
  let preflights = 0;
  /** Where the engine's config puts the widget for the next page load. */
  let position: "left" | "right" = "right";
  /** The next answer starts with a tool round (searching) before its text. */
  let toolFirst = false;
  let widgetOptions: Record<string, unknown> = {};
  let visitorCheck = false;
  let configGate: Promise<void> | null = null;
  const engineRequests: string[] = [];

  const engineOrigin = () => `http://127.0.0.1:${enginePort}`;
  const hostOrigin = () => `http://127.0.0.1:${hostPort}`;

  const page = (
    hostStyle: string,
    hostCss = "",
  ) => `<!doctype html><html${hostStyle ? ` style="${hostStyle}"` : ""}>
<head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body { margin: 0; font: 16px sans-serif; } #content { padding: 16px; } ${hostCss}</style></head>
<body><header id="bar" style="position: fixed; top: 0; left: 0; right: var(--solv-chat-panel-width, 0px); height: 8px"></header><main id="content"><h1>Owner's page</h1><p>${"Some documentation text. ".repeat(40)}</p></main>
<script src="${engineOrigin()}/widget.js"></script>
<solv-chat assistant="pk_layout"></solv-chat></body></html>`;

  const hostControls = () => `<!doctype html>
<html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fieldnotes API documentation</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.65 system-ui, sans-serif; color: #17253b; background: #f8fafc; }
  header { background: #fff; border-bottom: 1px solid #dce4ef; }
  header > div, main { width: min(100% - 48px, 680px); margin: auto; }
  header > div { padding: 16px 0; display: flex; align-items: center; justify-content: space-between; }
  main { padding: 40px 0; }
  h1 { font-size: clamp(1.75rem, 4vw, 2.5rem); line-height: 1.15; margin: 0 0 12px; }
  h2 { margin: 30px 0 0; font-size: 1.15rem; }
  p { margin: 8px 0 16px; color: #415471; }
  pre { background: #eaf0f8; border-radius: 8px; padding: 14px; overflow: auto; }
  button, input { font: inherit; color: inherit; border: 1px solid #bacbe0; background: #fff; border-radius: 6px; padding: 5px 12px; }
</style>
</head><body>
<header><div><strong>Fieldnotes API</strong><button id="host-ask" type="button">Ask</button></div></header>
<main>
  <h1>Search your documents</h1>
  <p>Use the Search API to find matching documents across a workspace.</p>
  <label for="host-input">Search the docs</label>
  <input id="host-input" type="search">
  <h2>Make a request</h2>
  <p>Send the query as a URL parameter. Use the cursor from the response to load the next page.</p>
  <pre>GET /v1/documents/search?q=release+notes</pre>
  <h2>Read the results</h2>
  <p>Each match includes the document title, its URL and a short excerpt.</p>
</main>
<script src="${engineOrigin()}/widget.js"></script>
<solv-chat assistant="pk_layout"></solv-chat>
</body></html>`;

  beforeAll(async () => {
    const bundle = await build({
      entryPoints: [resolve(ROOT, "src/widget.ts")],
      bundle: true,
      format: "iife",
      write: false,
      target: ["es2022"],
    });
    widgetJs = bundle.outputFiles[0]?.text ?? "";

    const host = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/host-controls") {
        res.writeHead(200, { "content-type": "text/html" }).end(hostControls());
        return;
      }
      if (url.pathname === "/" || url.pathname === "/other") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(page(url.searchParams.get("style") ?? "", url.searchParams.get("css") ?? ""));
        return;
      }
      res.writeHead(404).end();
    });
    const engine = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://x");
      engineRequests.push(url.pathname);
      const cors = {
        "access-control-allow-origin": hostOrigin(),
        "access-control-allow-headers": "content-type",
        "access-control-allow-methods": "GET, POST, OPTIONS",
      };
      if (req.method === "OPTIONS") {
        preflights++;
        res.writeHead(204, cors).end();
        return;
      }
      if (url.pathname === "/widget.js") {
        res.writeHead(200, { "content-type": "application/javascript" });
        res.end(widgetJs);
        return;
      }
      if (url.pathname === "/v1/assistants/pk_layout") {
        res.writeHead(200, { "content-type": "application/json", ...cors });
        const config = JSON.stringify({
          widget: { title: "Docs", position, ...widgetOptions },
          behaviour: { greeting: "Hi", suggestedQuestions: [] },
          visitorCheck,
        });
        if (configGate) void configGate.then(() => res.end(config));
        else res.end(config);
        return;
      }
      if (url.pathname === "/v1/chat" && req.method === "POST") {
        req.resume();
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          ...cors,
        });
        // The model thinks for a moment, then writes a token every 70 ms.
        if (toolFirst) {
          res.write('event: tool\ndata: {"name":"search_docs","state":"running"}\n\n');
          setTimeout(
            () => res.write('event: tool\ndata: {"name":"search_docs","state":"done"}\n\n'),
            200,
          );
        }
        let i = 0;
        const next = () => {
          const token = ANSWER_TOKENS[i++];
          if (token === undefined) {
            res.end('event: done\ndata: {"messageId":"msg_1","conversationId":"cnv_1"}\n\n');
            return;
          }
          res.write(`event: token\ndata: ${JSON.stringify({ text: token })}\n\n`);
          setTimeout(next, 70);
        };
        setTimeout(next, 400);
        return;
      }
      res.writeHead(404).end();
    });
    servers.push(host, engine);
    hostPort = await listen(host);
    enginePort = await listen(engine);
    browser = await launch(chrome as string);
  }, 90_000);

  afterEach(() => {
    widgetOptions = {};
    visitorCheck = false;
  });

  afterAll(async () => {
    await browser?.close();
    for (const server of servers) server.close();
  });

  const q = <T>(expr: string) =>
    browser.cdp.evaluate<T>(
      `(() => { const el = document.querySelector("solv-chat"); const r = el.shadowRoot; return ${expr}; })()`,
    );

  async function viewport(width: number, height: number): Promise<void> {
    await browser.cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  async function open(path = "/", fresh = true, waitForConfig = true): Promise<void> {
    await browser.cdp.evaluate(
      `(() => { window.__leaving = true; ${fresh ? "try { sessionStorage.clear(); } catch {}" : ""} })()`,
    );
    await browser.cdp.send("Page.navigate", { url: `${hostOrigin()}${path}` });
    // The new document, not the one being left.
    await waitFor(
      () =>
        browser.cdp.evaluate<boolean>(
          `(() => { const el = document.querySelector("solv-chat"); return !window.__leaving && !!el && !!el.shadowRoot && document.readyState === "complete"; })()`,
        ),
      "widget",
    );
    // The config has arrived when the title shows it.
    if (!waitForConfig) return;
    await waitFor(
      async () => (await q<string>(`r.querySelector(".solv-title").textContent`)) === "Docs",
      "config",
    );
  }

  const rect = (selector: string) =>
    q<{ left: number; right: number; top: number; bottom: number; width: number; height: number }>(
      `(() => { const b = r.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; })()`,
    );
  const page_ = <T>(expr: string) => browser.cdp.evaluate<T>(`(() => ${expr})()`);
  const noSidewaysScroll = () =>
    page_<boolean>("document.documentElement.scrollWidth <= document.documentElement.clientWidth");

  const panelHidden = () => q<boolean>('r.querySelector(".solv-panel").hidden');
  const layout = () => q<string | null>('el.getAttribute("data-layout")');
  const focus = () => q<string | null>("r.activeElement?.id ?? null");

  async function click(selector: string, shadow = false) {
    const bounds = shadow
      ? await rect(selector)
      : await page_<{ left: number; top: number; width: number; height: number }>(
          `document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`,
        );
    const x = bounds.left + bounds.width / 2;
    const y = bounds.top + bounds.height / 2;
    await browser.cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      x,
      y,
      clickCount: 1,
    });
    await browser.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      x,
      y,
      clickCount: 1,
    });
  }

  async function keypress(key: string, code: string, modifiers = 0) {
    await browser.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers });
    await browser.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
  }

  for (const mode of ["panel", "side"] as const) {
    it(`stays closed on first load in ${mode} mode, including a tab with copied storage`, async () => {
      widgetOptions = { opensAs: mode };
      visitorCheck = true;
      engineRequests.length = 0;
      await viewport(1280, 800);
      await open("/host-controls");
      expect(await panelHidden()).toBe(true);
      expect(await page_<number>("sessionStorage.length + localStorage.length")).toBe(0);
      expect(engineRequests).toEqual(["/widget.js", "/v1/assistants/pk_layout"]);

      // Runtime.evaluate does not grant activation. Opening via the API or
      // clicking a declarative trigger programmatically cannot write anything.
      expect(
        await q<boolean>(`(async () => {
          const ask = document.querySelector("#host-ask");
          ask.dataset.solvChatOpen = "side";
          ask.click();
          await el.open({ mode: "side" });
          await el.close();
          await el.toggle();
          return r.querySelector(".solv-panel").hidden;
        })()`),
      ).toBe(true);
      expect(await page_<number>("sessionStorage.length + localStorage.length")).toBe(0);
      expect(engineRequests).toHaveLength(2);

      await click(".solv-launcher", true);
      expect(await panelHidden()).toBe(false);
      expect(await layout()).toBe(mode === "side" ? "side" : null);
      await open("/host-controls?next", false);
      expect(await panelHidden()).toBe(false);

      const popupState = () =>
        browser.cdp.evaluate<{
          hidden: boolean;
          storage: Record<string, unknown>;
        } | null>(`(() => {
        const popup = window.widgetPopup;
        const widget = popup?.document.querySelector("solv-chat");
        if (widget?.shadowRoot.querySelector(".solv-title").textContent !== "Docs") return null;
        return {
          hidden: widget.shadowRoot.querySelector(".solv-panel").hidden,
          storage: JSON.parse(popup.sessionStorage.getItem("solv-chat-open:pk_layout")),
        };
      })()`);
      try {
        await page_(`(() => {
          const ask = document.querySelector("#host-ask");
          ask.style.cssText = "position:fixed;left:20px;top:16px";
          ask.onclick = () => {
            window.widgetPopup = window.open("${hostOrigin()}/host-controls");
          };
        })()`);
        await click("#host-ask");
        const copied = await waitFor(popupState, "assistant in a new tab");
        expect(copied.hidden).toBe(true);
        expect(copied.storage).toMatchObject({ open: true });
        expect(copied.storage).toEqual(
          await page_('JSON.parse(sessionStorage.getItem("solv-chat-open:pk_layout"))'),
        );
      } finally {
        await page_("window.widgetPopup?.close()");
        await browser.cdp.send("Page.bringToFront");
      }
      await click(".solv-close", true);
      await open("/host-controls", false);
      expect(await panelHidden()).toBe(true);
    }, 15_000);
  }

  it("opens the configured side panel on desktop and remembers a collapse across navigation", async () => {
    widgetOptions = { opensAs: "side" };
    await viewport(1280, 800);
    await open("/host-controls");
    await click(".solv-launcher", true);
    expect(await layout()).toBe("side");
    await click(".solv-collapse", true);
    expect(await layout()).toBeNull();
    await click(".solv-close", true);
    await open("/other", false);
    await click(".solv-launcher", true);
    expect(await panelHidden()).toBe(false);
    expect(await layout()).toBeNull();

    await viewport(380, 700);
    await open("/host-controls");
    await click(".solv-launcher", true);
    expect(await panelHidden()).toBe(false);
    expect(await layout()).toBeNull();

    widgetOptions.allowExpand = false;
    await viewport(1280, 800);
    await open("/host-controls");
    await click(".solv-launcher", true);
    expect(await panelHidden()).toBe(false);
    expect(await layout()).toBeNull();
    expect(await q<boolean>('r.querySelector(".solv-expand") === null')).toBe(true);
  });

  it("opens from a real host click after config, supports API options and emits composed events", async () => {
    widgetOptions = { opensAs: "side", launcherLabel: "Ask the docs", keyboardShortcut: "mod-k" };
    await viewport(1280, 800);
    await open("/host-controls");
    await browser.cdp.evaluate(`(() => {
      const widget = document.querySelector("solv-chat");
      window.widgetEvents = [];
      for (const action of ["open", "close", "expand", "collapse"]) {
        document.addEventListener("solv-chat:" + action, e => {
          window.widgetEvents.push([action, e.bubbles, e.composed, e.detail ?? null, e.target === widget]);
        });
      }

      // A host control added after the page and widget have loaded.
      const trigger = document.querySelector("#host-ask").cloneNode();
      trigger.id = "late-ask";
      trigger.setAttribute("data-solv-chat-open", "");
      trigger.innerHTML = "<span>Ask</span>";
      document.querySelector("#host-ask").replaceWith(trigger);
    })()`);
    await click("#late-ask span");
    expect(await layout()).toBe("side");
    expect(await focus()).toBe("solv-input");
    await click(".solv-collapse", true);
    await q("el.close()");
    expect(await panelHidden()).toBe(true);

    await q(`(() => {
      const trigger = document.querySelector("#late-ask");
      trigger.removeAttribute("data-solv-chat-open");
      trigger.onclick = () => { window.widgetAction = el.open({ mode: "side", focus: false }); };
    })()`);
    await click("#late-ask");
    await page_("window.widgetAction");
    expect(await layout()).toBe("side");
    expect(await focus()).toBeNull();
    await q("el.toggle()");
    expect(await panelHidden()).toBe(true);
    await q(
      `(document.querySelector("#late-ask").onclick = () => { window.widgetAction = el.toggle(); }, true)`,
    );
    await click("#late-ask");
    await page_("window.widgetAction");
    expect(await panelHidden()).toBe(false);
    expect(await layout()).toBeNull();
    await q("el.close()");
    await q(`(() => {
      const trigger = document.querySelector("#late-ask");
      trigger.onclick = null;
      trigger.setAttribute("data-solv-chat-open", "side");
    })()`);
    await click("#late-ask");
    expect(await layout()).toBe("side");
    await page_('(document.querySelector("#late-ask").dataset.solvChatOpen = "panel")');
    await click("#late-ask");
    expect(await layout()).toBeNull();
    expect(await panelHidden()).toBe(false);
    expect(await page_("window.widgetEvents")).toEqual(
      [
        "open",
        "expand",
        "collapse",
        "close",
        "open",
        "expand",
        "close",
        "open",
        "close",
        "open",
        "expand",
        "collapse",
      ].map((action) => [action, true, true, null, true]),
    );
  });

  it("accepts a host click before the config arrives and uses the published opening mode", async () => {
    widgetOptions = { opensAs: "side" };
    let release = () => {};
    configGate = new Promise<void>((resolveConfig) => {
      release = resolveConfig;
    });
    try {
      await viewport(1280, 800);
      await open("/host-controls", true, false);
      await q(`(document.querySelector("#host-ask").onclick = () => {
        window.widgetAction = el.open();
      })`);
      await click("#host-ask");
      expect(await panelHidden()).toBe(true);
      expect(await page_<number>("sessionStorage.length")).toBe(0);
      release();
      await page_("window.widgetAction");
      expect(await layout()).toBe("side");
    } finally {
      release();
      configGate = null;
    }
  });

  it("respects host text fields and handled shortcuts, and runs the visitor check on the first accepted key", async () => {
    await viewport(1280, 800);
    await open("/host-controls");
    await keypress("/", "Slash");
    expect(await panelHidden()).toBe(true);

    visitorCheck = true;
    widgetOptions = { keyboardShortcut: "/" };
    await open("/host-controls");
    await browser.cdp.evaluate(`(() => {
      window.handled = [];
      document.addEventListener("keydown", (event) => {
        if (window.hostHandlesKey) event.preventDefault();
      });
      window.addEventListener("keydown", (event) => window.handled.push(event.defaultPrevented));
      document.querySelector("main").insertAdjacentHTML("beforeend",
        '<textarea></textarea><select><option>A</option></select><div contenteditable><span>Write here</span></div>');
    })()`);
    for (const selector of ["#host-input", "textarea", "select", "[contenteditable]"]) {
      await page_(`document.querySelector(${JSON.stringify(selector)}).focus()`);
      await keypress("/", "Slash");
      expect(await panelHidden()).toBe(true);
    }
    expect(await page_("window.handled")).toEqual([false, false, false, false]);

    await page_("(document.activeElement.blur(), window.hostHandlesKey = true)");
    await keypress("/", "Slash");
    expect(await panelHidden()).toBe(true);
    expect(await q<boolean>('r.querySelector("iframe") === null')).toBe(true);

    await page_("window.hostHandlesKey = false");
    await keypress("/", "Slash");
    expect(await page_("window.handled.at(-1)")).toBe(true);
    expect(await panelHidden()).toBe(false);
    expect(await focus()).toBe("solv-input");
    expect(await q<boolean>(`!!r.querySelector('iframe[src*="/v1/check/frame"]')`)).toBe(true);

    visitorCheck = false;
    widgetOptions = { keyboardShortcut: "mod-k" };
    await open("/host-controls");
    await keypress("k", "KeyK");
    expect(await panelHidden()).toBe(true);
    await keypress("k", "KeyK", 2); // Ctrl
    expect(await panelHidden()).toBe(false);
    expect(await focus()).toBe("solv-input");
    await q("el.close()");
    await page_("document.activeElement.blur()");
    await keypress("k", "KeyK", 4); // Meta
    expect(await panelHidden()).toBe(false);
    expect(await focus()).toBe("solv-input");
  });

  it("fits one and 24 characters at 320px and hides the shortcut badge on touch-only devices", async () => {
    await viewport(320, 700);
    for (const label of ["A", "W".repeat(24), "<b>Ask</b>"]) {
      widgetOptions = { launcherLabel: label, keyboardShortcut: "mod-k" };
      await open("/host-controls");
      const bounds = await rect(".solv-launcher");
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(320);
      expect(await noSidewaysScroll()).toBe(true);
      expect(await q('r.querySelector(".solv-launcher-label").textContent')).toBe(label);
      expect(await q('r.querySelector(".solv-launcher-label").childElementCount')).toBe(0);
      expect(await q('r.querySelector(".solv-launcher").getAttribute("aria-label")')).toBe(
        `${label} — Docs`,
      );
    }
    expect(await q('getComputedStyle(r.querySelector(".solv-shortcut")).display')).not.toBe("none");
    try {
      await browser.cdp.send("Emulation.setTouchEmulationEnabled", {
        enabled: true,
        maxTouchPoints: 1,
      });
      expect(await page_('matchMedia("(any-pointer: coarse)").matches')).toBe(true);
      expect(await page_('matchMedia("(any-pointer: fine)").matches')).toBe(false);
      expect(await q('getComputedStyle(r.querySelector(".solv-shortcut")).display')).toBe("none");
    } finally {
      await browser.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    }
  });

  for (const [width, height, panelWidth, side] of [
    [1280, 800, 460, true],
    [900, 800, 460, true],
    [380, 700, 348, false],
  ] as const) {
    it(`at ${width}px wide: the panel, expanded, and back`, async () => {
      await viewport(width, height);
      await open();
      await q(`(r.querySelector(".solv-launcher").click(), true)`);
      // The viewport less a classic scrollbar, which fixed elements sit beside.
      const inner = await page_<number>("document.documentElement.clientWidth");
      const panel = await rect(".solv-panel");
      expect(panel.width).toBe(panelWidth);
      expect(panel.height).toBe(Math.min(width >= 640 ? 720 : 560, height - 96));
      expect(panel.right).toBe(inner - 20);
      expect(await noSidewaysScroll()).toBe(true);

      await q(`(r.querySelector(".solv-expand").click(), true)`);
      const expanded = await rect(".solv-panel");
      expect(await q("el.getAttribute('data-layout')")).toBe(side ? "side" : "full");
      expect(expanded.top).toBe(0);
      expect(expanded.height).toBe(height);
      expect(expanded.right).toBe(inner);
      expect(await q(`r.activeElement === r.querySelector(".solv-collapse")`)).toBe(true);
      expect(await q(`getComputedStyle(r.querySelector(".solv-launcher")).display`)).toBe("none");
      if (side) {
        expect(expanded.width).toBe(460);
        // The page is narrowed by the column, not covered by it.
        const content = await page_<{ right: number }>(
          "document.getElementById('content').getBoundingClientRect().toJSON()",
        );
        expect(content.right).toBeLessThanOrEqual(inner - 460);
        expect(await page_("getComputedStyle(document.documentElement).marginRight")).toBe("460px");
        expect(
          await page_(
            "getComputedStyle(document.documentElement).getPropertyValue('--solv-chat-panel-width')",
          ),
        ).toBe("460px");
      } else {
        expect(expanded.left).toBe(0);
        expect(expanded.width).toBeGreaterThanOrEqual(inner);
        expect(await page_("document.documentElement.getAttribute('style')")).toBeNull();
      }
      expect(await noSidewaysScroll()).toBe(true);

      await q(`(r.querySelector(".solv-collapse").click(), true)`);
      expect(await page_("document.documentElement.getAttribute('style')")).toBeNull();
      expect((await rect(".solv-panel")).width).toBe(panelWidth);
    }, 60_000);
  }

  it("just below 900px wide, expand opens the panel full screen", async () => {
    await viewport(899, 800);
    await open();
    await q(
      `(r.querySelector(".solv-launcher").click(), r.querySelector(".solv-expand").click(), true)`,
    );
    expect(await q("el.getAttribute('data-layout')")).toBe("full");
    expect((await rect(".solv-panel")).width).toBe(899);
    expect(await page_("document.documentElement.getAttribute('style')")).toBeNull();
  }, 60_000);

  it("a left widget, expanded below 900px, fills the whole screen", async () => {
    position = "left";
    try {
      await viewport(899, 800);
      await open();
      await q(
        `(r.querySelector(".solv-launcher").click(), r.querySelector(".solv-expand").click(), true)`,
      );
      expect(await q("el.getAttribute('data-layout')")).toBe("full");
      const inner = await page_<number>("document.documentElement.clientWidth");
      const host = await q<{ left: number; right: number }>("el.getBoundingClientRect().toJSON()");
      expect(host.left).toBe(0);
      expect(host.right).toBe(inner);
      const panel = await rect(".solv-panel");
      expect(panel.left).toBe(0);
      expect(panel.width).toBe(inner);
      expect(panel.height).toBe(800);
      expect(await page_("document.documentElement.getAttribute('style')")).toBeNull();
    } finally {
      position = "right";
    }
  }, 60_000);

  for (const side of ["right", "left"] as const) {
    it(`a ${side} column narrows a page whose root is sized to 100%`, async () => {
      position = side;
      try {
        await viewport(1280, 800);
        await open(`/?css=${encodeURIComponent("html { width: 100%; }")}`);
        await q(
          `(r.querySelector(".solv-launcher").click(), r.querySelector(".solv-expand").click(), true)`,
        );
        expect(await q("el.getAttribute('data-layout')")).toBe("side");
        const inner = await page_<number>("document.documentElement.clientWidth");
        const content = await page_<{ left: number; right: number }>(
          "document.getElementById('content').getBoundingClientRect().toJSON()",
        );
        const panel = await rect(".solv-panel");
        if (side === "right") {
          expect(panel.left).toBe(inner - 460);
          expect(content.right).toBeLessThanOrEqual(panel.left);
        } else {
          expect(panel.right).toBe(460);
          expect(content.left).toBeGreaterThanOrEqual(panel.right);
          expect(content.right).toBeLessThanOrEqual(inner);
        }
        expect(await noSidewaysScroll()).toBe(true);
        await q(`(r.querySelector(".solv-collapse").click(), true)`);
        expect(await page_("document.documentElement.getAttribute('style')")).toBeNull();
        expect(
          await page_<number>("document.getElementById('content').getBoundingClientRect().width"),
        ).toBe(inner);
      } finally {
        position = "right";
      }
    }, 60_000);
  }

  it("puts the host's own root style back exactly after collapse and after removal", async () => {
    await viewport(1280, 800);
    const hostStyle = "margin-right: 8px; background: rgb(250, 250, 250)";
    await open(`/?style=${encodeURIComponent(hostStyle)}`);
    await q(
      `(r.querySelector(".solv-launcher").click(), r.querySelector(".solv-expand").click(), true)`,
    );
    expect(await page_("getComputedStyle(document.documentElement).marginRight")).toBe("468px");
    expect(await noSidewaysScroll()).toBe(true);
    await q(`(r.querySelector(".solv-collapse").click(), true)`);
    expect(await page_("document.documentElement.getAttribute('style')")).toBe(hostStyle);

    await q(`(r.querySelector(".solv-expand").click(), true)`);
    await page_(`(document.querySelector("solv-chat").remove(), true)`);
    expect(await page_("document.documentElement.getAttribute('style')")).toBe(hostStyle);
  }, 60_000);

  it("stays expanded on the next page in the same tab", async () => {
    await viewport(1280, 800);
    await open();
    await q(
      `(r.querySelector(".solv-launcher").click(), r.querySelector(".solv-expand").click(), true)`,
    );
    await open("/other", false);
    expect(await q("el.getAttribute('data-layout')")).toBe("side");
    expect(await page_("getComputedStyle(document.documentElement).marginRight")).toBe("460px");
    expect((await rect(".solv-panel")).height).toBe(800);
  }, 60_000);

  it("writes the answer progressively, with the indicator first, and code scrolls sideways no more than at 380px", async () => {
    await viewport(1280, 800);
    await open();
    preflights = 0;
    await q(`(r.querySelector(".solv-launcher").click(), true)`);
    // Record what each painted frame shows of the answer.
    await q(`(() => {
      window.__frames = [];
      const sample = () => {
        const bubbles = r.querySelectorAll(".solv-bubble--assistant");
        const last = bubbles[bubbles.length - 1];
        if (bubbles.length > 1) {
          window.__frames.push({
            text: last.querySelector(".solv-bubble-text").textContent,
            typing: !!last.querySelector(".solv-typing"),
          });
        }
        if (!window.__stop) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      const input = r.querySelector("#solv-input");
      input.value = "How do I search?";
      r.querySelector(".solv-form").requestSubmit();
      return true;
    })()`);
    await waitFor(
      async () => (await q<boolean>(`!!r.querySelector(".solv-feedback")`)) === true,
      "answer done",
    );
    const frames = await page_<Array<{ text: string; typing: boolean }>>(
      "(window.__stop = true, window.__frames)",
    );
    expect(preflights).toBeGreaterThan(0);
    // The indicator shows while the model is thinking, before any text.
    const firstText = frames.findIndex((f) => f.text !== "");
    expect(firstText).toBeGreaterThan(0);
    expect(frames.slice(0, firstText).every((f) => f.typing)).toBe(true);
    // More than one paint with text in it, each a step further.
    const distinct = [...new Set(frames.map((f) => f.text).filter((t) => t !== ""))];
    expect(distinct.length).toBeGreaterThan(3);
    // Never a half-written link: its brackets or address never show.
    expect(distinct.some((t) => t.includes("[search") || t.includes("docs.example.com"))).toBe(
      false,
    );
    expect(await q(`r.querySelector(".solv-md-link").href`)).toBe(
      "https://docs.example.com/search",
    );

    // The same code block, now and at the old 380px size.
    const overflow = () =>
      q<number>(
        `(() => { const pre = r.querySelector(".solv-code-pre"); return pre.scrollWidth - pre.clientWidth; })()`,
      );
    const now = await overflow();
    await q(`(r.querySelector(".solv-panel").style.width = "380px", true)`);
    const before = await overflow();
    await q(`(r.querySelector(".solv-panel").style.width = "", true)`);
    expect(before).toBeGreaterThan(0);
    expect(now).toBeLessThan(before);
    await q(`(r.querySelector(".solv-expand").click(), true)`);
    expect(await overflow()).toBeLessThanOrEqual(now);
  }, 60_000);
  it("gives back the host's own inline margin and max-width, !important included, after collapse and removal", async () => {
    await viewport(1280, 800);
    const hostStyle =
      "margin-right: 8px !important; max-width: 1100px !important; background: rgb(250, 250, 250)";
    await open(`/?style=${encodeURIComponent(hostStyle)}`);
    await q(
      `(r.querySelector(".solv-launcher").click(), r.querySelector(".solv-expand").click(), true)`,
    );
    const inner = await page_<number>("document.documentElement.clientWidth");
    expect(await page_("getComputedStyle(document.documentElement).marginRight")).toBe("468px");
    const content = await page_<{ right: number }>(
      "document.getElementById('content').getBoundingClientRect().toJSON()",
    );
    expect(content.right).toBeLessThanOrEqual(inner - 460);
    expect(await noSidewaysScroll()).toBe(true);
    await q(`(r.querySelector(".solv-collapse").click(), true)`);
    expect(await page_("document.documentElement.getAttribute('style')")).toBe(hostStyle);
    expect(await page_("getComputedStyle(document.documentElement).maxWidth")).toBe("1100px");

    await q(`(r.querySelector(".solv-expand").click(), true)`);
    await page_(`(document.querySelector("solv-chat").remove(), true)`);
    expect(await page_("document.documentElement.getAttribute('style')")).toBe(hostStyle);
    expect(await page_("getComputedStyle(document.documentElement).marginRight")).toBe("8px");
  }, 60_000);

  for (const [name, css] of [
    ["a margin from the host's stylesheet", "html { margin-right: 24px; }"],
    ["a centred root", "html { max-width: 1000px; margin: 0 auto; }"],
  ] as const) {
    it(`a column beside ${name}: the page sits beside it and comes back as it was`, async () => {
      await viewport(1280, 800);
      await open(`/?css=${encodeURIComponent(css)}`);
      const before = await page_<{ left: number; right: number }>(
        "document.documentElement.getBoundingClientRect().toJSON()",
      );
      await q(
        `(r.querySelector(".solv-launcher").click(), r.querySelector(".solv-expand").click(), true)`,
      );
      const panel = await rect(".solv-panel");
      const content = await page_<{ left: number; right: number }>(
        "document.getElementById('content').getBoundingClientRect().toJSON()",
      );
      expect(content.left).toBeGreaterThanOrEqual(0);
      expect(content.right).toBeLessThanOrEqual(panel.left);
      expect(await noSidewaysScroll()).toBe(true);
      await q(`(r.querySelector(".solv-collapse").click(), true)`);
      expect(await page_("document.documentElement.getAttribute('style')")).toBeNull();
      expect(
        await page_<{ left: number; right: number }>(
          "document.documentElement.getBoundingClientRect().toJSON()",
        ),
      ).toEqual(before);
    }, 60_000);
  }

  it("a bar the host fixed to the edge moves clear using --solv-chat-panel-width", async () => {
    await viewport(1280, 800);
    await open();
    const inner = await page_<number>("document.documentElement.clientWidth");
    const bar = () =>
      page_<{ right: number }>("document.getElementById('bar').getBoundingClientRect().toJSON()");
    expect((await bar()).right).toBe(inner);
    await q(
      `(r.querySelector(".solv-launcher").click(), r.querySelector(".solv-expand").click(), true)`,
    );
    expect((await bar()).right).toBe((await rect(".solv-panel")).left);
    await q(`(r.querySelector(".solv-collapse").click(), true)`);
    expect((await bar()).right).toBe(inner);
  }, 60_000);

  it("the expand and collapse controls: named buttons with their state, by keyboard, focus kept, reduced motion", async () => {
    await viewport(1280, 800);
    await open();
    await q(`(r.querySelector(".solv-launcher").click(), true)`);
    await browser.cdp.send("Accessibility.enable");
    const buttons = async () => {
      const { nodes } = await browser.cdp.send<{
        nodes: Array<{
          ignored: boolean;
          role?: { value?: string };
          name?: { value?: string };
          properties?: Array<{ name: string; value: { value?: unknown } }>;
        }>;
      }>("Accessibility.getFullAXTree");
      return nodes
        .filter((n) => !n.ignored && n.role?.value === "button")
        .map((n) => ({
          name: n.name?.value ?? "",
          expanded: n.properties?.find((p) => p.name === "expanded")?.value.value,
        }));
    };
    const key = async (key: string, code: string, keyCode: number, modifiers = 0) => {
      const text = key === "Enter" ? "\r" : key === " " ? " " : undefined;
      for (const type of ["keyDown", "keyUp"] as const) {
        await browser.cdp.send("Input.dispatchKeyEvent", {
          type,
          key,
          code,
          windowsVirtualKeyCode: keyCode,
          modifiers,
          ...(type === "keyDown" && text ? { text } : {}),
        });
      }
    };
    const focused = () => q<string>(`r.activeElement ? r.activeElement.className : ""`);

    // Only the expand control is in the tree; the collapse one is hidden.
    expect(await buttons()).toEqual(
      expect.arrayContaining([{ name: "Expand to a side panel", expanded: false }]),
    );
    expect((await buttons()).some((b) => b.name === "Collapse to a small window")).toBe(false);

    // Reached by keyboard: back from the close button.
    await q(`(r.querySelector(".solv-close").focus(), true)`);
    await key("Tab", "Tab", 9, 8);
    expect(await focused()).toBe("solv-expand");
    await key("Enter", "Enter", 13);
    expect(await q("el.getAttribute('data-layout')")).toBe("side");
    expect(await focused()).toBe("solv-collapse");
    const expanded = await buttons();
    expect(expanded).toEqual(
      expect.arrayContaining([{ name: "Collapse to a small window", expanded: true }]),
    );
    expect(expanded.some((b) => b.name === "Expand to a side panel")).toBe(false);
    // Tab from the collapse control stays in the panel.
    await key("Tab", "Tab", 9);
    expect(await focused()).toBe("solv-close");
    await key("Tab", "Tab", 9, 8);
    await key(" ", "Space", 32);
    expect(await q("el.hasAttribute('data-layout')")).toBe(false);
    expect(await focused()).toBe("solv-expand");

    // Escape still closes the panel and gives focus to the launcher.
    await key("Enter", "Enter", 13);
    await key("Escape", "Escape", 27);
    expect(await q(`r.querySelector(".solv-panel").hidden`)).toBe(true);
    expect(await focused()).toBe("solv-launcher");
    expect(await page_("document.documentElement.getAttribute('style')")).toBeNull();

    // Reduced motion: the side panel appears without its animation.
    await browser.cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    try {
      await q(`(r.querySelector(".solv-launcher").click(), true)`);
      expect(await q(`getComputedStyle(r.querySelector(".solv-panel")).animationName`)).toBe(
        "none",
      );
      expect(await q(`getComputedStyle(r.querySelector(".solv-panel")).transitionDuration`)).toBe(
        "0s",
      );
    } finally {
      await browser.cdp.send("Emulation.setEmulatedMedia", { features: [] });
    }
    await browser.cdp.send("Accessibility.disable");
  }, 60_000);

  it('says "Writing an answer" once in the live region, through a tool round, and never again', async () => {
    await viewport(1280, 800);
    await open();
    toolFirst = true;
    try {
      await q(`(r.querySelector(".solv-launcher").click(), true)`);
      await q(`(() => {
        window.__said = [];
        const log = r.querySelector(".solv-messages");
        new MutationObserver((records) => {
          // One batch can report a bubble and the indicator inside it, both
          // added in the same task: each label counts once per batch, and a
          // later batch adding it again (a re-insertion) counts again.
          const labels = new Set();
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (node.nodeType !== 1) continue;
              const found = [node, ...node.querySelectorAll("*")].filter(
                (n) => n.childElementCount === 0 && n.textContent === "Writing an answer",
              );
              for (const label of found) labels.add(label);
            }
          }
          for (const label of labels) window.__said.push(!!label.closest("[aria-live]"));
        }).observe(log, { childList: true, subtree: true });
        r.querySelector("#solv-input").value = "How do I search?";
        r.querySelector(".solv-form").requestSubmit();
        return true;
      })()`);
      await waitFor(
        async () => (await q<boolean>(`!!r.querySelector(".solv-feedback")`)) === true,
        "answer done",
      );
      // Added once (in the answer's bubble, inside the role="log" live region).
      expect(await page_("window.__said")).toEqual([true]);
      expect(await q(`r.querySelector(".solv-messages").getAttribute("aria-live")`)).toBe("polite");
      expect(await q(`r.querySelectorAll("[aria-live]").length`)).toBeGreaterThanOrEqual(1);
      expect(await q(`!!r.querySelector(".solv-typing")`)).toBe(false);
    } finally {
      toolFirst = false;
    }
  }, 60_000);
});
