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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

  const engineOrigin = () => `http://127.0.0.1:${enginePort}`;
  const hostOrigin = () => `http://127.0.0.1:${hostPort}`;

  const page = (
    hostStyle: string,
  ) => `<!doctype html><html${hostStyle ? ` style="${hostStyle}"` : ""}>
<head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body { margin: 0; font: 16px sans-serif; } #content { padding: 16px; }</style></head>
<body><main id="content"><h1>Owner's page</h1><p>${"Some documentation text. ".repeat(40)}</p></main>
<script src="${engineOrigin()}/widget.js"></script>
<solv-chat assistant="pk_layout"></solv-chat></body></html>`;

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
      if (url.pathname === "/" || url.pathname === "/other") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(page(url.searchParams.get("style") ?? ""));
        return;
      }
      res.writeHead(404).end();
    });
    const engine = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://x");
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
        res.end(JSON.stringify({ title: "Docs", greeting: "Hi", suggestedQuestions: [] }));
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

  afterAll(() => {
    browser?.close();
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

  async function open(path = "/", fresh = true): Promise<void> {
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
});
