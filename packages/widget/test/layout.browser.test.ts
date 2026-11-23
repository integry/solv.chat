// @vitest-environment node
/**
 * The panel's size, the side panel and the streamed answer in a real browser.
 * A local server plays two origins, the owner's pages and the engine (widget
 * script, config and a chat stream that writes one token at a time). Nothing
 * is intercepted: the page fetches the engine across origins, CORS preflight
 * included, as it does on a live site.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Browser, findChrome, launch, waitFor } from "./support/chromium.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chrome = findChrome();
const TEST_SESSION = "vs1.layout-test-session";

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
  let bootJs = "";
  const servers: Server[] = [];
  let hostPort = 0;
  let enginePort = 0;
  let browser: Browser;
  let preflights = 0;
  /** Where the engine's config puts the widget for the next page load. */
  let position: "left" | "right" = "right";
  /** The next answer starts with a tool round (searching) before its text. */
  let toolFirst = false;
  let holdChatStream = false;
  let widgetOptions: Record<string, unknown> = {};
  let visitorCheck = false;
  let pageActions = false;
  let configGate: Promise<void> | null = null;
  let stallConfigHeaders = false;
  let gatedConfigResponse: ServerResponse | undefined;
  const engineRequests: string[] = [];
  const submissions: Array<{ path: string; body: Record<string, unknown> }> = [];

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

  const bootPage = (url: URL) => {
    const variant = url.searchParams.get("boot");
    const delay = process.env.SOLV_DOCK_PREVIEWS ? 2300 : 650;
    const key = "pk_layout";
    const title = url.pathname === "/other" ? "API keys" : "Authentication";
    const css = `html{width:100%;transition:margin 300ms}
body{margin:0;background:#f8fafc;color:#17253b;font:16px/1.6 system-ui}
main{box-sizing:border-box;padding:42px clamp(24px,6vw,90px)}
nav{padding:18px clamp(24px,6vw,90px);background:var(--host-nav-background,white);border-bottom:1px solid #dce4ef}
a{color:#235ba3;margin-right:16px}h1{font-size:36px;line-height:1.15}
p{max-width:90ch}pre{max-width:54ch;overflow:auto;padding:16px;border-radius:8px;background:#eaf0f8}`;
    const hash = (value: string) => createHash("sha256").update(value).digest("base64");
    const rootStyle =
      variant === "blocked-shorthand"
        ? "margin:var(--host-margin,0 8px 0 0);background:#f8fafc"
        : "margin-right:8px;background:#f8fafc;--host-nav-background:white";
    const policy = `script-src 'sha256-${hash(bootJs)}' ${variant?.startsWith("blocked") ? "" : engineOrigin()}; style-src 'unsafe-hashes' 'sha256-${hash(rootStyle)}' 'sha256-${hash(css)}'; connect-src ${engineOrigin()}`;
    const html = `<!doctype html><html style="${rootStyle}"><head>
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} | Fieldnotes API</title>
<style>${css}</style>
${variant === "no" ? "" : `<script data-key="${key}">${bootJs}</script>`}
${variant === "storage" ? "" : `<script src="${engineOrigin()}/widget.js?delay=${delay}" defer></script>`}
</head><body><nav><strong>Fieldnotes API</strong> &nbsp; <a href="/?boot=yes">Authentication</a><a href="/other?boot=yes">API keys</a></nav>
<main id="content"><h1>${title}</h1><p>Use a workspace API key to authenticate requests to the Fieldnotes API. Include it in the Authorization header with each request.</p>
<h2>Make an authenticated request</h2><pre>GET /v1/documents
Authorization: Bearer YOUR_API_KEY</pre>
<h2>Rotate a key</h2><p>Create a new key in your workspace settings, then update your application. Revoke the previous key after you confirm the new key works.</p></main>
<solv-chat assistant="pk_layout" launcher-shortcut="none"></solv-chat></body></html>`;
    return { html, policy: variant === "storage" ? `sandbox allow-scripts; ${policy}` : policy };
  };

  beforeAll(async () => {
    const boot = await build({
      entryPoints: [resolve(ROOT, "src/boot.ts")],
      bundle: true,
      format: "iife",
      minify: true,
      write: false,
      target: ["es2022"],
      tsconfigRaw: { compilerOptions: { alwaysStrict: false } },
    });
    bootJs = boot.outputFiles[0]?.text.trimEnd() ?? "";
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
      if (url.searchParams.has("boot")) {
        const { html, policy } = bootPage(url);
        res
          .writeHead(200, { "content-type": "text/html", "content-security-policy": policy })
          .end(html);
        return;
      }
      if (url.pathname === "/" || url.pathname === "/other") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(page(url.searchParams.get("style") ?? "", url.searchParams.get("css") ?? ""));
        return;
      }
      res.writeHead(404).end();
    });
    const engine = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://x");
      engineRequests.push(url.pathname);
      const cors = {
        "access-control-allow-origin": hostOrigin(),
        "access-control-allow-headers": "content-type",
        "access-control-allow-methods": "GET, POST, OPTIONS",
      };
      if (req.method === "OPTIONS") {
        preflights++;
        // Each test can observe its own preflight.
        res.writeHead(204, { ...cors, "access-control-max-age": "0" }).end();
        return;
      }
      if (url.pathname === "/widget.js") {
        res.writeHead(200, { "content-type": "application/javascript" });
        const delay = Number(url.searchParams.get("delay"));
        if (delay) setTimeout(() => res.end(widgetJs), delay);
        else res.end(widgetJs);
        return;
      }
      if (url.pathname === "/v1/assistants/pk_layout") {
        res.writeHead(200, { "content-type": "application/json", ...cors });
        const config = JSON.stringify({
          widget: { title: "Docs", position, ...widgetOptions },
          behaviour: { greeting: "Hi", suggestedQuestions: [] },
          visitorCheck,
          actions: { builtins: pageActions, allowedOrigins: [hostOrigin()] },
        });
        if (configGate) {
          gatedConfigResponse = res;
          if (!stallConfigHeaders) res.flushHeaders();
          void configGate.then(() => res.end(config));
        } else res.end(config);
        return;
      }
      if (url.pathname === "/v1/check/frame" && visitorCheck) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><body style="margin:0;height:65px;display:grid;place-items:center">
<button>Verify</button><script>
const origin = ${JSON.stringify(hostOrigin())};
parent.postMessage({ solvCheck: 1, type: "interactive" }, origin);
document.querySelector("button").onclick = () => {
  parent.postMessage({ solvCheck: 1, type: "token", token: "test-token" }, origin);
};
</script></body>`);
        return;
      }
      if (url.pathname === "/v1/session" && req.method === "POST") {
        req.resume();
        res
          .writeHead(200, { "content-type": "application/json", ...cors })
          .end(JSON.stringify({ session: TEST_SESSION, expiresAt: Date.now() + 3_600_000 }));
        return;
      }
      if (req.method === "POST" && ["/v1/chat", "/v1/feedback"].includes(url.pathname)) {
        let raw = "";
        for await (const chunk of req.setEncoding("utf8")) raw += chunk;
        const body = JSON.parse(raw) as Record<string, unknown>;
        submissions.push({ path: url.pathname, body });
        const refused = visitorCheck && body.session !== TEST_SESSION;
        if (url.pathname === "/v1/feedback") {
          res
            .writeHead(refused ? 403 : 200, { "content-type": "application/json", ...cors })
            .end(JSON.stringify(refused ? { code: "check_required" } : { ok: true }));
          return;
        }
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          ...cors,
        });
        if (refused) {
          res.end(
            'event: error\ndata: {"message":"Complete the security check.","code":"check_required"}\n\n',
          );
          return;
        }
        if (body.message === "Open the API keys page") {
          res.end(
            'event: action\ndata: {"callId":"call_nav","name":"navigate","input":{"url":"/other?boot=yes"},"confirm":false}\n\n' +
              'event: done\ndata: {"messageId":"msg_nav","conversationId":"cnv_nav","awaitingActions":["call_nav"]}\n\n',
          );
          return;
        }
        if (holdChatStream) {
          // Navigation will close the stream after the first token is visible.
          res.write(`event: token\ndata: ${JSON.stringify({ text: ANSWER_TOKENS[0] })}\n\n`);
          return;
        }
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
    browser = await launch(chrome as string, ["--disable-popup-blocking"]);
  }, 90_000);

  afterEach(() => {
    widgetOptions = {};
    visitorCheck = false;
    pageActions = false;
    holdChatStream = false;
    stallConfigHeaders = false;
    gatedConfigResponse = undefined;
    submissions.length = 0;
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
    await q('(r.querySelector(".solv-launcher").dispatchEvent(new Event("pointerenter")), true)');
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
  const panelLoading = () =>
    q<boolean>('r.querySelector(".solv-panel").hasAttribute("data-loading")');
  const fallbackVisible = async () => !(await panelHidden()) && !(await panelLoading());
  const layout = () => q<string | null>('el.getAttribute("data-layout")');
  const focus = () => q<string | null>("r.activeElement?.id ?? null");
  const pendingResume = () =>
    page_<unknown>(`JSON.parse(sessionStorage.getItem("solv-chat-open:pk_layout")).pendingResume`);

  function delayConfig(): () => void {
    let release = () => {};
    configGate = new Promise<void>((resolveConfig) => {
      release = resolveConfig;
    });
    return () => {
      configGate = null;
      release();
    };
  }

  async function savePausedAnswer() {
    await page_(`sessionStorage.setItem("solv-chat-open:pk_layout", JSON.stringify({
      conversationId: "cnv_1",
      open: true,
      turns: [{ role: "assistant", text: "", messageId: "msg_1", awaiting: ["call_1"] }],
      pendingResume: {
        conversationId: "cnv_1",
        resumeMessageId: "msg_1",
        actionResults: [{ callId: "call_1", ok: true, result: "{}" }],
        depth: 1,
        createdAt: Date.now(),
      },
    }))`);
  }

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

  async function waitForVisitorCheck() {
    await waitFor(
      () =>
        q<boolean>("r.querySelector('.solv-check[data-state=\"interactive\"] iframe') !== null"),
      "interactive visitor check",
    );
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
          storage: string | null;
        } | null>(`(() => {
        const popup = window.widgetPopup;
        if (!popup || popup.__reloading) return null;
        const widget = popup.document.querySelector("solv-chat");
        if (widget?.shadowRoot?.querySelector(".solv-title").textContent !== "Docs") return null;
        return {
          hidden: widget.shadowRoot.querySelector(".solv-panel").hidden,
          storage: popup.sessionStorage.getItem("solv-chat-open:pk_layout"),
        };
      })()`);
      const storageKey = "solv-chat-open:pk_layout";
      const original = await page_<string>(`sessionStorage.getItem("${storageKey}")`);
      expect(JSON.parse(original)).toMatchObject({ open: true });
      try {
        await page_(`(() => {
          const ask = document.querySelector("#host-ask");
          ask.style.cssText = "position:fixed;left:20px;top:16px";
          ask.onclick = () => {
            // Keep this test's driver alive when the popup's opener closes.
            window.widgetOpener = window.open("about:blank");
            window.widgetPopup = window.widgetOpener.eval('window.open("about:blank")');
          };
        })()`);
        await click("#host-ask");
        expect(await page_("window.widgetPopup.opener === window.widgetOpener")).toBe(true);
        expect(await page_(`window.widgetPopup.sessionStorage.getItem("${storageKey}")`)).toBe(
          original,
        );
        await page_(`(window.widgetPopup.location.href = "${hostOrigin()}/host-controls")`);
        expect((await waitFor(popupState, "assistant in a new tab")).hidden).toBe(true);
        expect(await page_(`window.widgetOpener.sessionStorage.getItem("${storageKey}")`)).toBe(
          original,
        );

        await page_("window.widgetOpener.close()");
        await waitFor(() => page_<boolean>("window.widgetOpener.closed"), "opener to close");
        await page_(
          "((window.widgetPopup.__reloading = true), window.widgetPopup.location.reload())",
        );
        expect(await waitFor(popupState, "assistant after reload")).toEqual({
          hidden: true,
          storage: null,
        });
      } finally {
        await page_("(window.widgetPopup?.close(), window.widgetOpener?.close())");
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
      expect(await panelHidden()).toBe(false);
      expect(await panelLoading()).toBe(true);
      expect(await page_<number>("sessionStorage.length")).toBe(0);
      release();
      await page_("window.widgetAction");
      expect(await layout()).toBe("side");
    } finally {
      release();
      configGate = null;
    }
  });

  it.each([
    ["launcher", "body"],
    ["host button", "headers"],
    ["toggle API", "body"],
  ])("opens from the %s when config stalls at the %s", async (trigger, stalledAt) => {
    widgetOptions = { opensAs: "side", title: "Late settings" };
    stallConfigHeaders = stalledAt === "headers";
    let release = () => {};
    configGate = new Promise<void>((resolveConfig) => {
      release = resolveConfig;
    });
    try {
      await viewport(1280, 800);
      await open("/host-controls", true, false);
      const response = await waitFor(async () => gatedConfigResponse, "stalled config request");
      if (trigger === "launcher") {
        await click(".solv-launcher", true);
      } else {
        await q(
          trigger === "host button"
            ? 'document.querySelector("#host-ask").setAttribute("data-solv-chat-open", "")'
            : '(document.querySelector("#host-ask").onclick = () => { void el.toggle(); }, true)',
        );
        await click("#host-ask");
      }
      expect(await panelHidden()).toBe(false);
      expect(await panelLoading()).toBe(true);
      await waitFor(fallbackVisible, "fallback panel", 4_000);
      expect(await layout()).toBeNull();
      expect(await focus()).toBe("solv-input");
      expect(await q('r.querySelector(".solv-title").textContent')).toBe("Ask a question");
      expect(response.destroyed).toBe(false);
      release();
      await waitFor(
        async () => (await q('r.querySelector(".solv-title").textContent')) === "Late settings",
        "late settings",
      );
      expect(await layout()).toBeNull();
    } finally {
      release();
      configGate = null;
    }
  });

  it("discards a pending config load and queued open when the widget reconnects", async () => {
    widgetOptions = { title: "Old settings" };
    let release = () => {};
    configGate = new Promise<void>((resolveConfig) => {
      release = resolveConfig;
    });
    try {
      await viewport(1280, 800);
      await open("/host-controls", true, false);
      const response = await waitFor(async () => gatedConfigResponse, "stalled config request");
      await click(".solv-launcher", true);
      expect(await panelLoading()).toBe(true);

      configGate = null;
      widgetOptions = { opensAs: "side" };
      await q("(el.remove(), document.body.append(el))");
      await waitFor(async () => response.destroyed, "disconnected config cancellation", 1_000);
      release();
      await waitFor(
        async () => (await q('r.querySelector(".solv-title").textContent')) === "Docs",
        "reconnected config",
      );
      expect(await panelHidden()).toBe(true);
      await click(".solv-launcher", true);
      expect(await layout()).toBe("side");
    } finally {
      release();
      configGate = null;
    }
  });

  it("recovers the first message submitted from the fallback panel with the visitor check on", async () => {
    visitorCheck = true;
    widgetOptions = { title: "Fieldnotes assistant", opensAs: "side" };
    const release = delayConfig();
    try {
      await viewport(1280, 800);
      await open("/host-controls", true, false);
      await q('document.querySelector("#host-ask").setAttribute("data-solv-chat-open", "")');
      await click("#host-ask");
      await waitFor(fallbackVisible, "fallback panel", 4_000);
      expect(await q('r.querySelector(".solv-title").textContent')).toBe("Ask a question");
      expect(await layout()).toBeNull();
      await q(`(() => {
        r.querySelector("#solv-input").value = "How do I search my documents?";
        r.querySelector(".solv-form").requestSubmit();
      })()`);
      await waitFor(async () => submissions.length === 1, "chat refusal");
      expect(submissions[0]?.body).not.toHaveProperty("session");
      expect(await q('r.querySelector(".solv-check iframe") === null')).toBe(true);

      release();
      await waitForVisitorCheck();
      expect(await q('r.querySelector(".solv-title").textContent')).toBe("Fieldnotes assistant");
      expect(await layout()).toBeNull();
      expect(submissions).toHaveLength(1);
      await click(".solv-check iframe", true);
      await waitFor(async () => submissions.length === 2, "chat with a session");
      expect(submissions[1]?.body).toEqual({ ...submissions[0]?.body, session: TEST_SESSION });
      await waitFor(() => q<boolean>('r.querySelector(".solv-feedback") !== null'), "answer");
      expect(await q('r.querySelectorAll(".solv-bubble--user").length')).toBe(1);
      expect(await q('r.querySelector(".solv-bubble-error") === null')).toBe(true);
    } finally {
      release();
    }
  }, 12_000);

  it("continues a restored answer when the config response body stalls", async () => {
    await viewport(1280, 800);
    await open("/host-controls");
    await savePausedAnswer();
    // Leave the response incomplete until the restored turn has finished.
    configGate = new Promise<void>(() => {});
    try {
      await open("/host-controls?resume", false, false);
      expect(await q('r.querySelector(".solv-send").disabled')).toBe(true);
      await waitFor(
        () => q<boolean>('r.querySelector(".solv-panel").textContent.includes("That is all.")'),
        "restored answer",
        4_500,
      );
      await waitFor(() => q<boolean>('!r.querySelector(".solv-send").disabled'), "send enabled");
    } finally {
      gatedConfigResponse?.destroy();
      configGate = null;
    }
  });

  it("keeps a restored answer pending across reconnect until it can send its visitor session", async () => {
    await viewport(1280, 800);
    await open("/host-controls");
    await savePausedAnswer();
    visitorCheck = true;
    stallConfigHeaders = true;
    const release = delayConfig();
    try {
      await open("/host-controls?protected-resume", false, false);
      const response = await waitFor(async () => gatedConfigResponse, "first config request");
      await waitFor(async () => submissions.length === 1, "first resume refusal");
      expect(await pendingResume()).toMatchObject({ resumeMessageId: "msg_1" });

      await q("(el.remove(), document.body.append(el))");
      await waitFor(async () => response.destroyed, "disconnected config cancellation");
      await waitFor(async () => submissions.length === 2, "second resume refusal");
      expect(await pendingResume()).toMatchObject({ resumeMessageId: "msg_1" });

      release();
      await waitForVisitorCheck();
      expect(await pendingResume()).toMatchObject({ resumeMessageId: "msg_1" });
      await click(".solv-check iframe", true);
      await waitFor(async () => submissions.length === 3, "resume with a session");
      expect(submissions.map(({ body }) => body.session)).toEqual([
        undefined,
        undefined,
        TEST_SESSION,
      ]);
      expect(submissions[2]?.body).toEqual({ ...submissions[0]?.body, session: TEST_SESSION });
      await waitFor(
        () => q<boolean>('r.querySelector(".solv-feedback") !== null'),
        "restored answer",
      );
      expect(await pendingResume()).toBeUndefined();
    } finally {
      release();
    }
  }, 15_000);

  it("recovers feedback on a restored answer when the visitor-check config arrives late", async () => {
    await open("/host-controls");
    await page_(`sessionStorage.setItem("solv-chat-open:pk_layout", JSON.stringify({
      conversationId: "cnv_1",
      turns: [{ role: "assistant", text: "Search your docs", messageId: "msg_1" }],
    }))`);
    visitorCheck = true;
    const release = delayConfig();
    try {
      await open("/host-controls?protected-feedback", false, false);
      await click(".solv-launcher", true);
      await waitFor(fallbackVisible, "fallback panel", 4_000);
      await click('.solv-fb-btn[aria-label="Helpful"]', true);
      await waitFor(async () => submissions.length === 1, "feedback refusal");
      expect(submissions[0]).toMatchObject({ path: "/v1/feedback", body: { value: "up" } });
      expect(submissions[0]?.body).not.toHaveProperty("session");

      release();
      await waitForVisitorCheck();
      await click(".solv-check iframe", true);
      await waitFor(async () => submissions.length === 2, "feedback with a session");
      expect(submissions[1]?.body).toEqual({ ...submissions[0]?.body, session: TEST_SESSION });
      await waitFor(
        async () =>
          (await q('r.querySelector(".solv-fb-ack").textContent')) === "Thanks for the feedback.",
        "feedback acknowledgement",
      );
    } finally {
      release();
    }
  }, 12_000);

  it("shows the chat refusal and allows a new submission while config is still stalled", async () => {
    visitorCheck = true;
    widgetOptions = { title: "Fieldnotes assistant" };
    const release = delayConfig();
    const submit = () =>
      q(`(() => {
        r.querySelector("#solv-input").value = "How do I search my documents?";
        r.querySelector(".solv-form").requestSubmit();
      })()`);
    try {
      await viewport(1280, 800);
      await open("/host-controls?stalled-chat-config", true, false);
      await click(".solv-launcher", true);
      await waitFor(fallbackVisible, "fallback panel", 4_000);
      await submit();
      await waitFor(async () => submissions.length === 1, "chat refusal");
      expect(submissions[0]?.body).not.toHaveProperty("session");

      await waitFor(
        () => q<boolean>('r.querySelector(".solv-bubble-error") !== null'),
        "visible chat refusal with config still stalled",
        4_000,
      );
      expect(await q('r.querySelector(".solv-bubble-error").textContent')).toBe(
        "Complete the security check.",
      );
      expect(await q('r.querySelector(".solv-send").disabled')).toBe(false);
      expect(gatedConfigResponse?.writableEnded).toBe(false);

      release();
      await waitFor(
        () => q<boolean>('r.querySelector(".solv-title").textContent === "Fieldnotes assistant"'),
        "late config applied",
      );
      expect(submissions).toHaveLength(1);
      await submit();
      await waitForVisitorCheck();
      await click(".solv-check iframe", true);
      await waitFor(
        () => q<boolean>('r.querySelector(".solv-feedback") !== null'),
        "answer to the new submission",
      );
      expect(submissions).toHaveLength(2);
      expect(submissions[1]?.body).toEqual({ ...submissions[0]?.body, session: TEST_SESSION });
    } finally {
      release();
    }
  }, 12_000);

  it("restores feedback controls while config is still stalled", async () => {
    await open("/host-controls");
    await page_(`sessionStorage.setItem("solv-chat-open:pk_layout", JSON.stringify({
      conversationId: "cnv_1",
      turns: [{ role: "assistant", text: "Search your docs", messageId: "msg_1" }],
    }))`);
    visitorCheck = true;
    const release = delayConfig();
    const vote = () => click('.solv-fb-btn[aria-label="Helpful"]', true);
    try {
      await open("/host-controls?stalled-feedback-config", false, false);
      await click(".solv-launcher", true);
      await waitFor(fallbackVisible, "fallback panel", 4_000);
      await vote();
      await waitFor(async () => submissions.length === 1, "feedback refusal");
      expect(submissions[0]?.body).not.toHaveProperty("session");

      await waitFor(
        () => q<boolean>('r.querySelector(".solv-fb-ack").textContent.includes("Try again.")'),
        "feedback failure with config still stalled",
        4_000,
      );
      expect(await q('r.querySelectorAll(".solv-fb-btn:disabled").length')).toBe(0);
      expect(await q("r.querySelectorAll('.solv-fb-btn[aria-pressed=\"true\"]').length")).toBe(0);
      expect(gatedConfigResponse?.writableEnded).toBe(false);

      release();
      await waitFor(
        () => q<boolean>('r.querySelector(".solv-title").textContent === "Docs"'),
        "config",
      );
      expect(submissions).toHaveLength(1);
      await vote();
      await waitForVisitorCheck();
      await click(".solv-check iframe", true);
      await waitFor(
        () =>
          q<boolean>('r.querySelector(".solv-fb-ack").textContent === "Thanks for the feedback."'),
        "feedback acknowledgement",
      );
      expect(submissions).toHaveLength(2);
      expect(submissions[1]?.body).toEqual({ ...submissions[0]?.body, session: TEST_SESSION });
    } finally {
      release();
    }
  }, 12_000);

  it("keeps a refused restored continuation available after the config wait expires", async () => {
    await viewport(1280, 800);
    await open("/host-controls");
    await savePausedAnswer();
    visitorCheck = true;
    const release = delayConfig();
    try {
      await open("/host-controls?stalled-resume-config", false, false);
      await waitFor(async () => submissions.length === 1, "resume refusal", 4_000);
      expect(submissions[0]?.body).not.toHaveProperty("session");
      await waitFor(
        () => q<boolean>('r.querySelector(".solv-bubble-error") !== null'),
        "visible resume refusal with config still stalled",
        4_000,
      );
      expect(await q('r.querySelector(".solv-send").disabled')).toBe(false);
      expect(await pendingResume()).toMatchObject({ resumeMessageId: "msg_1" });
      expect(
        await page_('JSON.parse(sessionStorage.getItem("solv-chat-open:pk_layout")).turns[0]'),
      ).toMatchObject({ error: "Complete the security check.", awaiting: ["call_1"] });
      expect(gatedConfigResponse?.writableEnded).toBe(false);

      release();
      await waitFor(
        () => q<boolean>('r.querySelector(".solv-title").textContent === "Docs"'),
        "config",
      );
      expect(submissions).toHaveLength(1);
      await open("/host-controls?retry-resume", false);
      await waitForVisitorCheck();
      expect(await q('r.querySelector(".solv-bubble-error") === null')).toBe(true);
      await click(".solv-check iframe", true);
      await waitFor(
        () => q<boolean>('r.querySelector(".solv-feedback") !== null'),
        "answer to the restored continuation",
      );
      expect(submissions).toHaveLength(2);
      expect(submissions[1]?.body).toMatchObject({
        resumeMessageId: "msg_1",
        session: TEST_SESSION,
      });
      expect(await pendingResume()).toBeUndefined();
    } finally {
      release();
    }
  }, 12_000);

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

    await open("/host-controls");
    await keypress("/", "Digit7", 8); // Shift+7 produces slash on a German layout.
    expect(await panelHidden()).toBe(false);
    expect(await focus()).toBe("solv-input");

    visitorCheck = false;
    widgetOptions = { keyboardShortcut: "mod-k" };
    await open("/host-controls");
    await keypress("k", "KeyK");
    expect(await panelHidden()).toBe(true);
    await keypress("K", "KeyK", 10); // Ctrl+Shift
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

  const dockId = "solv-dock:1:pk_layout";
  const expandedWidth = 812;
  const fullWidth = 1280;
  const bootFrames = () =>
    page_<Array<{ width: number; placeholder: boolean; panel: boolean; launcher: boolean }>>(
      "window.dockFrames",
    );

  async function watchDockFrames() {
    return browser.cdp.send<{ identifier: string }>("Page.addScriptToEvaluateOnNewDocument", {
      source: `window.dockFrames = [];
      window.dockStyleChanges = [];
      window.dockErrors = [];
      addEventListener("error", (event) => window.dockErrors.push(event.message));
      const observe = () => new MutationObserver(() => {
        window.dockStyleChanges.push(document.documentElement.getAttribute("style"));
      }).observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
      const tick = () => {
        const content = document.getElementById("content");
        if (content) {
          if (!window.dockFrames.length) observe();
          const stub = document.getElementById("${dockId}");
          const widget = document.querySelector("solv-chat");
          const panel = widget?.shadowRoot?.querySelector(".solv-panel");
          const launcher = widget?.shadowRoot?.querySelector(".solv-launcher");
          const column = (el) => {
            if (!el || getComputedStyle(el).backgroundColor === "rgba(0, 0, 0, 0)") return false;
            const box = el.getBoundingClientRect();
            return box.width === 460 && box.top === 0 && box.height === innerHeight &&
              (box.right === innerWidth || box.left === 0);
          };
          window.dockFrames.push({
            width: content.getBoundingClientRect().width,
            placeholder: column(stub),
            panel: column(panel),
            launcher: !!launcher && getComputedStyle(launcher).display !== "none",
          });
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);`,
    });
  }

  async function screenshot(name: string) {
    if (!process.env.SOLV_DOCK_PREVIEWS) return;
    const directory = resolve(ROOT, "../../.propr/previews");
    mkdirSync(directory, { recursive: true });
    const { data } = await browser.cdp.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
    });
    writeFileSync(resolve(directory, name), Buffer.from(data, "base64"));
  }

  it("reserves the column on every frame of navigation and restores the docked conversation", async () => {
    await viewport(1280, 800);
    await open("/?boot=yes");
    await q('(r.querySelector(".solv-launcher").click(), r.querySelector(".solv-expand").click())');
    // Use the regular send path for a finished answer and a second answer
    // that is still streaming when this document goes away.
    await q(
      `(r.querySelector("#solv-input").value = "How do I search?", r.querySelector("form").requestSubmit())`,
    );
    await waitFor(() => q<boolean>('!!r.querySelector(".solv-feedback")'), "completed answer");
    const question = [
      "I’m setting up search for a workspace that holds product documentation and release notes.",
      "How can I limit results to published documents and exclude drafts or archived release notes?",
      "Can I combine those filters with a date range and then sort the results by relevance?",
      "We have separate workspaces for staging and production. Is the workspace set on the API key or on each search request?",
      "Could you show a complete example with pagination and explain how the cursor changes between pages?",
    ].join("\n\n");
    holdChatStream = true;
    await q(
      `(r.querySelector("#solv-input").value = ${JSON.stringify(question)}, r.querySelector("form").requestSubmit())`,
    );
    await waitFor(
      () =>
        q<boolean>('r.querySelector(".solv-bubble:last-child").textContent.includes("To search")'),
      "streaming answer",
    );
    // Wait for the scroll event so the widget has stopped following the latest message.
    const scroll = await q<{ top: number; remaining: number }>(`new Promise((resolve) => {
      const input = r.querySelector("#solv-input");
      input.value = "Can I search archived notes?";
      input.focus();
      const messages = r.querySelector(".solv-messages");
      messages.addEventListener("scroll", () => resolve({
        top: messages.scrollTop,
        remaining: messages.scrollHeight - messages.scrollTop - messages.clientHeight,
      }), { once: true });
      messages.scrollTop = 45;
    })`);
    expect(scroll.top).toBe(45);
    expect(scroll.remaining).toBeGreaterThan(32);

    const { identifier } = await watchDockFrames();
    try {
      const engineRequestStart = engineRequests.length;
      await browser.cdp.send("Page.navigate", { url: `${hostOrigin()}/other?boot=yes` });
      await waitFor(
        async () => (await bootFrames())?.some((frame) => frame.placeholder),
        "placeholder frame",
      );
      expect(engineRequests.slice(engineRequestStart)).toContain("/widget.js");
      expect(await page_(`document.getElementById("${dockId}").textContent`)).toBe("Docs");
      await screenshot("dock-first-frame.png");
      await waitFor(
        async () => (await bootFrames())?.some((frame) => frame.panel),
        "docked panel frame",
      );
      const frames = await bootFrames();
      expect(frames[0]).toEqual({
        width: expandedWidth,
        placeholder: true,
        panel: false,
        launcher: false,
      });
      expect(
        frames.every(
          ({ width, placeholder, panel, launcher }) =>
            width === expandedWidth && (placeholder || panel) && !launcher,
        ),
      ).toBe(true);
      expect(await page_("window.dockStyleChanges")).toEqual([]);
      expect(await q("getComputedStyle(el).viewTransitionName")).toBe("solv-chat-dock");
      expect(await q('getComputedStyle(r.querySelector(".solv-panel")).animationName')).toBe(
        "none",
      );
      expect(await q('r.querySelector("#solv-input").value')).toBe("Can I search archived notes?");
      expect(await focus()).toBe("solv-input");
      expect(await q('r.querySelector(".solv-messages").scrollTop')).toBe(45);
      expect(await q('r.querySelector(".solv-messages").textContent')).toContain(
        "How do I search?",
      );
      expect(await q('r.querySelector(".solv-bubble:last-child").textContent')).toContain(
        "Response interrupted.",
      );
      expect(submissions).toHaveLength(2);
      await screenshot("dock-restored.png");

      // The control sees the same cross-origin delay and the first full-width
      // frame, followed by a resize once the widget has loaded.
      await browser.cdp.send("Page.navigate", { url: `${hostOrigin()}/other?boot=no` });
      await waitFor(
        async () => (await bootFrames())?.some((frame) => frame.width === fullWidth),
        "full-width control",
      );
      await screenshot("dock-without-boot.png");
      await waitFor(
        async () => (await bootFrames())?.some((frame) => frame.panel),
        "control panel",
      );
      expect((await bootFrames())[0]).toEqual({
        width: fullWidth,
        placeholder: false,
        panel: false,
        launcher: false,
      });

      await q('r.querySelector(".solv-collapse").click()');
      expect(await page_(`sessionStorage.getItem("${dockId}")`)).toBeNull();
      await browser.cdp.send("Page.navigate", { url: `${hostOrigin()}/other?boot=yes` });
      await waitFor(
        async () => (await bootFrames())?.some((frame) => frame.launcher),
        "collapsed next page",
      );
      expect(
        (await bootFrames()).every((frame) => frame.width === fullWidth && !frame.placeholder),
      ).toBe(true);
      await q('r.querySelector(".solv-expand").click()');
      expect(await page_(`sessionStorage.getItem("${dockId}")`)).toBeTruthy();
      await q("el.close()");
      expect(await page_(`sessionStorage.getItem("${dockId}")`)).toBeNull();
    } finally {
      await browser.cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
    }
  }, 25_000);

  it("continues a paused answer after a page action navigates with the panel docked", async () => {
    pageActions = true;
    await viewport(1280, 800);
    await open("/?boot=yes");
    await q('(r.querySelector(".solv-launcher").click(), r.querySelector(".solv-expand").click())');
    const { identifier } = await watchDockFrames();
    try {
      await q(
        `(r.querySelector("#solv-input").value = "Open the API keys page", r.querySelector("form").requestSubmit())`,
      );
      await waitFor(
        async () => (await bootFrames())?.some((frame) => frame.placeholder),
        "page action navigation",
      );
      await waitFor(async () => submissions.length === 2, "continued request");
      expect(submissions[1]?.body).toMatchObject({
        conversationId: "cnv_nav",
        resumeMessageId: "msg_nav",
        actionResults: [{ callId: "call_nav", ok: true }],
      });
      expect(submissions[1]?.body).not.toHaveProperty("message");
      await waitFor(() => q<boolean>('!!r.querySelector(".solv-feedback")'), "continued answer");
      expect((await bootFrames()).every((frame) => frame.width === expandedWidth)).toBe(true);
      expect(await pendingResume()).toBeUndefined();
      expect(await q('r.querySelector(".solv-messages").textContent')).toContain("That is all.");
    } finally {
      await browser.cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
    }
  }, 15_000);

  it("does nothing for fresh tabs, blocked storage and invalid records, and rolls back if the script is blocked", async () => {
    await viewport(1280, 800);
    await open();
    const { identifier } = await watchDockFrames();
    try {
      await open("/other?boot=yes", true, false);
      expect(
        (await bootFrames()).every((frame) => frame.width === fullWidth && !frame.placeholder),
      ).toBe(true);
      await browser.cdp.send("Page.navigate", { url: `${hostOrigin()}/?boot=storage` });
      await waitFor(async () => (await bootFrames())?.length > 0, "sandbox page frames");
      expect(await page_("window.dockErrors")).toEqual([]);
      expect((await bootFrames())[0]?.width).toBe(fullWidth);
      expect(await page_('document.querySelector("[inert]")')).toBeNull();

      await open();
      await page_(
        `sessionStorage.setItem("${dockId}", '["right","460px","position:fixed;background:url(https://invalid.example)", "Invalid"]')`,
      );
      await open("/other?boot=yes", false, false);
      expect(
        (await bootFrames()).every((frame) => frame.width === fullWidth && !frame.placeholder),
      ).toBe(true);

      await open();
      await q(
        '(r.querySelector(".solv-launcher").click(), r.querySelector(".solv-expand").click())',
      );
      await browser.cdp.send("Page.navigate", {
        url: `${hostOrigin()}/other?boot=blocked-shorthand`,
      });
      await waitFor(
        async () => (await bootFrames())?.some((frame) => frame.placeholder),
        "placeholder before rollback",
      );
      await waitFor(async () => (await bootFrames()).at(-1)?.width === fullWidth, "rollback", 3500);
      expect(await page_(`document.getElementById("${dockId}")`)).toBeNull();
      expect(await page_('document.documentElement.getAttribute("style")')).toBe(
        "margin:var(--host-margin,0 8px 0 0);background:#f8fafc",
      );
    } finally {
      await browser.cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
    }
  }, 20_000);

  it("preserves host style edits when a blocked widget's boot reservation expires", async () => {
    await viewport(1280, 800);
    await open();
    await q('(r.querySelector(".solv-launcher").click(), r.querySelector(".solv-expand").click())');
    await browser.cdp.send("Page.navigate", { url: `${hostOrigin()}/other?boot=blocked` });
    await waitFor(
      () =>
        page_<boolean>(`(() => {
          if (!document.getElementById("${dockId}")) return false;
          const { style } = document.documentElement;
          style.overflow = "hidden";
          style.setProperty("--host-nav-background", "#dbeafe", "important");
          return true;
        })()`),
      "host edits during the boot reservation",
    );
    await waitFor(
      () => page_<boolean>(`!document.getElementById("${dockId}")`),
      "placeholder removed by timeout",
      3500,
    );
    expect(
      await page_(`(() => {
        const root = document.documentElement;
        const { style } = root;
        return {
          margin: style.marginRight,
          maxWidth: style.maxWidth,
          panelWidth: style.getPropertyValue("--solv-chat-panel-width"),
          overflow: getComputedStyle(root).overflow,
          theme: style.getPropertyValue("--host-nav-background"),
          themePriority: style.getPropertyPriority("--host-nav-background"),
          navBackground: getComputedStyle(document.querySelector("nav")).backgroundColor,
          contentWidth: document.getElementById("content").getBoundingClientRect().width,
        };
      })()`),
    ).toEqual({
      margin: "8px",
      maxWidth: "",
      panelWidth: "",
      overflow: "hidden",
      theme: "#dbeafe",
      themePriority: "important",
      navBackground: "rgb(219, 234, 254)",
      contentWidth: fullWidth,
    });
    await screenshot("boot-timeout-preserves-host-theme.png");
  }, 10_000);

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
