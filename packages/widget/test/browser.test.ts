// @vitest-environment node
/**
 * The visitor check in a real browser. A local server plays three origins:
 * the owner's page, the engine (widget script, config, session, chat and a
 * stand-in check frame that hands over a token when the test says so) and
 * an unrelated site whose frame on the page keeps posting forged tokens.
 * Turnstile itself is not reached: the frame protocol is what is tested.
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

interface Logged {
  port: number;
  method: string;
  path: string;
  body: string;
}

function listen(server: Server): Promise<number> {
  return new Promise((ok) =>
    server.listen(0, "127.0.0.1", () => ok((server.address() as AddressInfo).port)),
  );
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

describe.skipIf(chrome === null)("visitor check in Chromium", () => {
  const log: Logged[] = [];
  let releaseToken: (() => void) | null = null;
  let widgetJs = "";
  const servers: Server[] = [];
  let hostPort = 0;
  let enginePort = 0;
  let evilPort = 0;
  let browser: Browser;

  const engineOrigin = () => `http://127.0.0.1:${enginePort}`;
  const hostOrigin = () => `http://127.0.0.1:${hostPort}`;

  beforeAll(async () => {
    const bundle = await build({
      entryPoints: [resolve(ROOT, "src/widget.ts")],
      bundle: true,
      format: "iife",
      write: false,
      target: ["es2022"],
    });
    widgetJs = bundle.outputFiles[0]?.text ?? "";

    const handler = (port: () => number) => async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://x");
      const body = await readBody(req);
      log.push({ port: port(), method: req.method ?? "GET", path: url.pathname, body });
      const cors = {
        "access-control-allow-origin": hostOrigin(),
        "access-control-allow-headers": "content-type",
        "access-control-allow-methods": "GET, POST, OPTIONS",
      };
      const p = port();
      if (p === hostPort && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><html><body><h1>Owner's page</h1>
<iframe src="http://127.0.0.1:${evilPort}/evil.html" title="ad" style="width:10px;height:10px;border:0"></iframe>
<script src="${engineOrigin()}/widget.js"></script>
<solv-chat assistant="pk_browser"></solv-chat></body></html>`);
        return;
      }
      if (p === evilPort && url.pathname === "/evil.html") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><script>
setInterval(() => {
  parent.postMessage({ solvCheck: 1, type: "ready" }, "*");
  parent.postMessage({ solvCheck: 1, type: "token", token: "forged" }, "*");
}, 30);
</script>`);
        return;
      }
      if (p !== enginePort) {
        res.writeHead(404).end();
        return;
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204, cors).end();
        return;
      }
      if (url.pathname === "/widget.js") {
        res.writeHead(200, { "content-type": "application/javascript" });
        res.end(widgetJs);
        return;
      }
      if (url.pathname === "/v1/assistants/pk_browser") {
        res.writeHead(200, { "content-type": "application/json", ...cors });
        res.end(
          JSON.stringify({
            title: "Docs",
            greeting: "Hi",
            suggestedQuestions: [],
            visitorCheck: true,
          }),
        );
        return;
      }
      if (url.pathname === "/v1/check/frame") {
        // Stands in for the engine's frame: same messages, same targeting.
        const parent = url.searchParams.get("parent") ?? "";
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><body><script>
const parentOrigin = ${JSON.stringify(parent)};
parent.postMessage({ solvCheck: 1, type: "ready" }, parentOrigin);
fetch("/test/token").then((r) => r.text()).then((token) => {
  parent.postMessage({ solvCheck: 1, type: "token", token }, parentOrigin);
});
</script></body>`);
        return;
      }
      if (url.pathname === "/test/token") {
        // Held until the test lets the "challenge" finish.
        await new Promise<void>((ok) => {
          releaseToken = ok;
        });
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("XXXX.DUMMY.TOKEN.XXXX");
        return;
      }
      if (url.pathname === "/v1/session" && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json", ...cors });
        res.end(
          JSON.stringify({ session: "vs1.browser-session", expiresAt: Date.now() + 3_600_000 }),
        );
        return;
      }
      if (url.pathname === "/v1/chat" && req.method === "POST") {
        res.writeHead(200, { "content-type": "text/event-stream", ...cors });
        res.end(
          'event: token\ndata: {"text":"Delivered answer"}\n\nevent: done\ndata: {"messageId":"msg_1","conversationId":"cnv_1"}\n\n',
        );
        return;
      }
      res.writeHead(404).end();
    };

    for (const set of [
      (p: number) => {
        hostPort = p;
      },
      (p: number) => {
        enginePort = p;
      },
      (p: number) => {
        evilPort = p;
      },
    ]) {
      let own = 0;
      const server = createServer((req, res) => void handler(() => own)(req, res));
      servers.push(server);
      own = await listen(server);
      set(own);
    }
    browser = await launch(chrome as string);
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    for (const server of servers) server.close();
  });

  const engineHits = (path: string) =>
    log.filter(
      (entry) => entry.port === enginePort && entry.path === path && entry.method !== "OPTIONS",
    );

  it("loads nothing until the visitor types, waits for the check, and ignores other origins", async () => {
    const { cdp } = browser;
    await cdp.send("Page.navigate", { url: `${hostOrigin()}/` });
    await waitFor(
      () => cdp.evaluate<boolean>('!!document.querySelector("solv-chat")?.shadowRoot'),
      "widget",
    );

    const q = (expr: string) =>
      cdp.evaluate(
        `(() => { const r = document.querySelector("solv-chat").shadowRoot; return ${expr}; })()`,
      );
    // Opening the panel focuses the input by itself; that is not the visitor.
    await q(`(r.querySelector(".solv-launcher").click(), true)`);
    await waitFor(
      () => q('r.activeElement === r.querySelector("#solv-input")'),
      "config and input focus",
    );
    expect(await q(`r.activeElement === r.querySelector("#solv-input")`)).toBe(true);
    expect(engineHits("/v1/check/frame")).toHaveLength(0);
    expect(await q(`r.querySelectorAll("iframe").length`)).toBe(0);
    const heightBefore = await q(
      `r.querySelector(".solv-messages").getBoundingClientRect().height`,
    );

    // The visitor's first keystroke starts the check.
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "H", text: "H" });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "H" });
    await waitFor(async () => engineHits("/v1/check/frame").length > 0, "check frame");
    await waitFor(
      async () => (await q(`r.querySelectorAll(".solv-check iframe").length`)) === 1,
      "frame",
    );
    // Created in the collapsed area: nothing in the panel moved.
    expect(await q(`r.querySelector(".solv-messages").getBoundingClientRect().height`)).toBe(
      heightBefore,
    );
    expect(await q(`r.querySelector(".solv-check").getBoundingClientRect().height`)).toBe(0);
    const frameSrc = new URL(String(await q(`r.querySelector(".solv-check iframe").src`)));
    expect(frameSrc.origin).toBe(engineOrigin());
    expect(frameSrc.searchParams.get("parent")).toBe(hostOrigin());

    // Sent while the check runs: it waits, it is not lost.
    await cdp.send("Input.insertText", { text: "ello there" });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    });
    await new Promise((r) => setTimeout(r, 600));
    expect(engineHits("/v1/chat")).toHaveLength(0);
    // The other site's frame has been posting forged tokens all along.
    expect(engineHits("/v1/session")).toHaveLength(0);
    expect(await q(`r.querySelectorAll(".solv-bubble--assistant").length`)).toBe(2);

    await waitFor(async () => releaseToken !== null, "token request");
    releaseToken?.();
    await waitFor(async () => engineHits("/v1/chat").length === 1, "chat request");
    const sessionBody = JSON.parse(engineHits("/v1/session")[0]?.body ?? "{}");
    expect(sessionBody.token).toBe("XXXX.DUMMY.TOKEN.XXXX");
    const chatBody = JSON.parse(engineHits("/v1/chat")[0]?.body ?? "{}");
    expect(chatBody).toMatchObject({ message: "Hello there", session: "vs1.browser-session" });
    await waitFor(
      async () => String(await q("r.textContent")).includes("Delivered answer"),
      "answer",
    );
    expect(engineHits("/v1/session")).toHaveLength(1);
    // Nothing on the page reached Turnstile or any third origin.
    expect(log.every((entry) => entry.port !== evilPort || entry.path === "/evil.html")).toBe(true);
  }, 60_000);
});
