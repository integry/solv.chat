// @vitest-environment node
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Browser, findChrome, launch, waitFor } from "./support/chromium.js";

const chrome = findChrome();
const CONFIG = {
  title: "Trail Shop Help",
  greeting: "Hi! I can help you find the right gear for your next hike.",
  accentColor: "#126146",
  position: "left",
  suggestedQuestions: ["What should I pack for a day hike?", "How do I choose a backpack?"],
};

interface Frame {
  title: string;
  text: string;
  accent: string;
  sendColor: string;
  palette: string[];
  inputDisabled: boolean;
  layout: string;
  bounds: [number, number, number, number];
  hostLeft: number;
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    );
  });
}

describe.skipIf(chrome === null)("published configuration in Chromium", () => {
  const requests: Array<{ key: string; method: string; validator: string | undefined }> = [];
  let browser: Browser;
  let host: Server;
  let engine: Server;
  let hostOrigin: string;
  let config: typeof CONFIG & {
    launcherLabel?: string;
    keyboardShortcut?: string;
    opensAs?: string;
  } = CONFIG;
  let delay = 0;
  let configGate: Promise<void> | undefined;
  let maxAge = 60;
  let etag = '"original"';

  beforeAll(async () => {
    const bundle = await build({
      entryPoints: [fileURLToPath(new URL("../src/widget.ts", import.meta.url))],
      bundle: true,
      format: "iife",
      write: false,
      target: ["es2022"],
    });
    engine = createServer((req, res) => {
      const path = req.url ?? "/";
      if (path === "/widget.js") {
        res.writeHead(200, { "content-type": "application/javascript" });
        res.end(bundle.outputFiles[0]?.text);
        return;
      }
      if (!path.startsWith("/v1/assistants/")) {
        res.writeHead(404).end();
        return;
      }
      const validator = req.headers["if-none-match"];
      requests.push({ key: path.split("/").at(-1) ?? "", method: req.method ?? "", validator });
      if (req.headers.origin !== hostOrigin || req.method !== "GET") {
        res.writeHead(403).end();
        return;
      }
      const headers = {
        "access-control-allow-origin": hostOrigin,
        "cache-control": `private, max-age=${maxAge}, must-revalidate, no-transform`,
        vary: "Origin",
        etag,
      };
      const body = JSON.stringify(config);
      const respond = () => {
        if (validator === headers.etag) res.writeHead(304, headers).end();
        else res.writeHead(200, { ...headers, "content-type": "application/json" }).end(body);
      };
      if (configGate) void configGate.then(respond);
      else setTimeout(respond, delay);
    });
    const engineOrigin = await listen(engine);
    host = createServer((req, res) => {
      const key = req.url?.split("/")[1];
      if (!key || !/^pk_\w+$/.test(key)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body { font: 16px system-ui, sans-serif; color: #172b24; background: #f4f7f4; margin: 0; }
header { padding: 24px 48px; background: #fff; border-bottom: 1px solid #cdd9d0; }
main { margin: 70px auto; width: min(650px, 90%); }
button { font: inherit; padding: 8px 14px; }
</style></head><body>
<header><strong>Trail Shop</strong></header>
<main><h1>Day hiking essentials</h1><p>Find backpacks, layers and other gear for a day on the trail.</p>
<button data-solv-chat-trigger="trail-chat" type="button"><span>Ask about gear</span></button></main>
<script src="${engineOrigin}/widget.js" defer></script>
<solv-chat id="trail-chat" assistant="${key}" ${
        req.url?.split("?")[0]?.endsWith("/bare")
          ? ""
          : `launcher-label="Gear help" launcher-position="left" launcher-accent-color="#126146"
  launcher-shortcut="${key === "pk_slow" ? "/" : "none"}"
  ${key === "pk_slow" ? 'opens-as="side"' : ""}`
      }></solv-chat>
</body></html>`);
    });
    hostOrigin = await listen(host);
    browser = await launch(chrome as string);
    await browser.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await browser.cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "light" }],
    });
    await browser.cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1120,
      height: 860,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await browser.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
        window.framesSeen = [];
        window.launcherFrames = [];
        function sample() {
          const widget = document.querySelector("solv-chat");
          const root = widget?.shadowRoot;
          const launcher = root?.querySelector(".solv-launcher");
          if (launcher && !launcher.hidden) {
            const label = launcher.querySelector(".solv-launcher-label").textContent;
            const badge = launcher.querySelector(".solv-shortcut");
            const frame = [label, badge.hidden ? "" : badge.textContent];
            if (JSON.stringify(frame) !== JSON.stringify(window.launcherFrames.at(-1))) {
              window.launcherFrames.push(frame);
            }
          }
          const panel = root?.querySelector(".solv-panel");
          if (panel && !panel.hidden) {
            const send = root.querySelector(".solv-send");
            const { x, y, width, height } = panel.getBoundingClientRect();
            const palette = [panel, ...panel.querySelectorAll("*")]
              .filter(node => node.getClientRects().length > 0)
              .map(node => {
                const style = getComputedStyle(node);
                return [style.color, style.backgroundColor, style.borderColor, style.outlineColor].join("/");
              });
            const frame = {
              title: root.querySelector(".solv-title").textContent,
              text: panel.innerText,
              accent: getComputedStyle(panel).getPropertyValue("--solv-accent").trim(),
              sendColor: getComputedStyle(send).backgroundColor,
              palette,
              inputDisabled: root.querySelector(".solv-input").disabled,
              layout: panel.hasAttribute("data-layout-pending") ? "pending" :
                widget.getAttribute("data-layout") ?? "panel",
              bounds: [x, y, width, height],
              hostLeft: document.documentElement.getBoundingClientRect().left,
            };
            if (JSON.stringify(frame) !== JSON.stringify(window.framesSeen.at(-1))) {
              window.framesSeen.push(frame);
            }
          }
          requestAnimationFrame(sample);
        }
        requestAnimationFrame(sample);
      `,
    });
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    engine?.close();
    host?.close();
  });

  const evaluate = <T>(source: string) => browser.cdp.evaluate<T>(source);
  const frames = () => evaluate<Frame[]>("window.framesSeen");
  const hits = (key: string) => requests.filter((request) => request.key === key);
  const launcher = 'document.querySelector("solv-chat").shadowRoot.querySelector(".solv-launcher")';

  async function navigate(path: string) {
    await browser.cdp.send("Page.navigate", { url: hostOrigin + path });
    await waitFor(
      () =>
        evaluate<boolean>(`location.pathname + location.search === ${JSON.stringify(path)} &&
          !!document.querySelector("solv-chat")?.shadowRoot && document.readyState === "complete"`),
      "widget on the new page",
    );
  }

  async function showTitle(title: string): Promise<void> {
    await waitFor(async () => (await frames()).at(-1)?.title === title, title);
  }

  async function capture(filename: string): Promise<void> {
    const directory = process.env.SOLV_WIDGET_PREVIEW_DIR;
    if (!directory) return;
    const result = await browser.cdp.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
    });
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, filename), Buffer.from(result.data, "base64"));
  }

  it("uses initial launcher styling and paints the published panel once after a two-second load", async () => {
    const key = "pk_slow";
    config = { ...CONFIG, launcherLabel: "Gear help", keyboardShortcut: "/", opensAs: "side" };
    delay = 2_000;
    await navigate(`/${key}/first`);
    expect(
      await evaluate(`[${launcher}.textContent, getComputedStyle(${launcher}).backgroundColor,
      document.querySelector("solv-chat").getAttribute("data-position")]`),
    ).toEqual(["Gear help/", "rgb(18, 97, 70)", "left"]);
    expect(await waitFor(() => evaluate("window.launcherFrames[0]"), "first launcher")).toEqual([
      "Gear help",
      "/",
    ]);
    expect(await evaluate("[sessionStorage.length, localStorage.length]")).toEqual([0, 0]);
    expect(hits(key)).toEqual([]);
    await capture("widget-launcher.png");

    await evaluate(`${launcher}.click()`);
    await showTitle("Loading chat…");
    const loading = (await frames())[0];
    expect(loading).toMatchObject({
      accent: "#475569",
      inputDisabled: true,
      layout: "side",
      hostLeft: 460,
    });
    expect(loading?.text).not.toMatch(/Ask a question|Hello\. Ask me anything/);
    expect(
      await evaluate(
        'document.querySelector("solv-chat").shadowRoot.querySelector("textarea").placeholder',
      ),
    ).toBe("");
    expect(
      await evaluate(
        "Object.keys(sessionStorage).some(key => key.startsWith('solv-chat-config:'))",
      ),
    ).toBe(false);
    await capture("widget-loading.png");

    await showTitle(CONFIG.title);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const content = (await frames()).slice(1);
    expect(content).toHaveLength(1);
    expect(content[0]).toMatchObject({
      title: CONFIG.title,
      accent: CONFIG.accentColor,
      sendColor: "rgb(18, 97, 70)",
      inputDisabled: false,
      layout: "side",
      bounds: loading?.bounds,
      hostLeft: 460,
    });
    expect(content[0]?.text).toContain(CONFIG.greeting);
    expect(content[0]?.text).toContain(CONFIG.suggestedQuestions[0]);
    expect(hits(key)).toHaveLength(1);
    await capture("widget-published.png");
  }, 15_000);

  it("honours the first keypress on a fresh embed without attributes, even during the config read", async () => {
    const key = "pk_shortcut";
    config = { ...CONFIG, launcherLabel: "Gear help", keyboardShortcut: "/" };
    let release = () => {};
    configGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await navigate(`/${key}/bare`);
      await waitFor(async () => hits(key).length === 1, "load-time request");
      expect(
        await evaluate(`Object.keys(sessionStorage).some(entry => entry.endsWith("${key}"))`),
      ).toBe(false);
      expect(await waitFor(() => evaluate("window.launcherFrames[0]"), "pending launcher")).toEqual(
        ["", ""],
      );
      await browser.cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "/",
        code: "Slash",
      });
      await browser.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "/", code: "Slash" });
    } finally {
      configGate = undefined;
      release();
    }
    await showTitle(CONFIG.title);
    expect(await evaluate(`${launcher}.getRootNode().activeElement.id`)).toBe("solv-input");
    expect(await evaluate("window.launcherFrames")).toEqual([
      ["", ""],
      ["Gear help", "/"],
    ]);
    expect(hits(key)).toHaveLength(1);

    await evaluate('document.querySelector("solv-chat").close()');
    await navigate(`/${key}/bare?next`);
    expect(await waitFor(() => evaluate("window.launcherFrames[0]"), "restored launcher")).toEqual([
      "Gear help",
      "/",
    ]);
    expect(hits(key)).toHaveLength(1);
  });

  it("shows a compact loading frame and paints the unknown side layout with its first content", async () => {
    const key = "pk_unknown_layout";
    config = { ...CONFIG, opensAs: "side" };
    delay = 2_000;
    await navigate(`/${key}/bare`);
    await evaluate(`${launcher}.click()`);
    await showTitle("Loading chat…");
    expect((await frames())[0]).toMatchObject({
      layout: "pending",
      inputDisabled: true,
      hostLeft: 0,
    });
    expect((await frames())[0]?.bounds[2]).toBe(320);
    await capture("widget-loading-unknown-layout.png");

    await showTitle(CONFIG.title);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const seen = await frames();
    expect(seen.map(({ layout }) => layout)).toEqual(["pending", "side"]);
    expect(seen[1]).toMatchObject({
      accent: CONFIG.accentColor,
      inputDisabled: false,
      bounds: [0, 0, 460, 860],
      hostLeft: 460,
    });
    expect(seen[1]?.text).toContain(CONFIG.greeting);
    expect(hits(key)).toHaveLength(1);
  }, 15_000);

  it.each(["hover", "focus", "host trigger", "declarative trigger", "touch"])(
    "shares the %s request with the open path",
    async (intent) => {
      const key = `pk_${intent.replace(" ", "_")}`;
      config = CONFIG;
      delay = 250;
      await navigate(`/${key}/first`);
      expect(hits(key)).toHaveLength(0);
      if (intent === "hover") {
        const point = await evaluate<{ x: number; y: number }>(
          `(() => { const rect = ${launcher}.getBoundingClientRect();
            return { x: rect.x + 5, y: rect.y + rect.height / 2 }; })()`,
        );
        await browser.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
      } else if (intent === "declarative trigger") {
        const point = await evaluate<{ x: number; y: number }>(`(() => {
          const trigger = document.querySelector("[data-solv-chat-trigger]");
          trigger.removeAttribute("data-solv-chat-trigger");
          trigger.setAttribute("data-solv-chat-open", "");
          const rect = trigger.querySelector("span").getBoundingClientRect();
          return { x: rect.x + 5, y: rect.y + rect.height / 2 };
        })()`);
        await browser.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
        await waitFor(async () => hits(key).length === 1, "declarative hover request");
        expect(await frames()).toEqual([]);
        await browser.cdp.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          button: "left",
          clickCount: 1,
          ...point,
        });
        await browser.cdp.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          button: "left",
          clickCount: 1,
          ...point,
        });
      } else if (intent === "host trigger") {
        expect(
          await evaluate(`(() => {
          const trigger = document.querySelector("[data-solv-chat-trigger]");
          trigger.focus();
          return document.activeElement === trigger;
        })()`),
        ).toBe(true);
      } else if (intent === "touch") {
        await evaluate(`${launcher}.dispatchEvent(new Event("touchstart"))`);
      } else {
        expect(
          await evaluate(`(() => {
          const launcher = ${launcher};
          launcher.focus();
          return launcher.getRootNode().activeElement === launcher;
        })()`),
        ).toBe(true);
      }
      await waitFor(async () => hits(key).length === 1, "intent request");
      if (intent !== "declarative trigger") expect(await frames()).toEqual([]);
      if (intent === "host trigger") {
        await evaluate('document.querySelector("[data-solv-chat-trigger] span").click()');
      } else if (intent !== "declarative trigger") {
        await evaluate(`${launcher}.click()`);
      }
      await showTitle(CONFIG.title);
      // Park the pointer before navigating to the next independent fixture.
      await browser.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 600, y: 20 });
      expect(hits(key)).toHaveLength(1);
    },
    15_000,
  );

  it("restores the first frame, revalidates, and skips an over-age copy", async () => {
    const key = "pk_tab";
    delay = 0;
    await navigate(`/${key}/first`);
    await evaluate(`${launcher}.click()`);
    await showTitle(CONFIG.title);

    delay = 450;
    await navigate(`/${key}/same`);
    await showTitle(CONFIG.title);
    expect((await frames())[0]?.accent).toBe(CONFIG.accentColor);
    await waitFor(async () => hits(key).length === 2, "conditional request");
    expect(hits(key)[1]).toMatchObject({ method: "GET", validator: etag });
    // The conditional response does not change any rendered frame.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(await frames()).toHaveLength(1);

    etag = '"new"';
    maxAge = 0; // Simulate an expired HTTP entry for the later age check.
    config = { ...CONFIG, title: "Trail Shop Support", accentColor: "#743c17" };
    await navigate(`/${key}/changed`);
    await showTitle(config.title);
    expect((await frames()).map(({ title, accent }) => [title, accent])).toEqual([
      [CONFIG.title, CONFIG.accentColor],
      [config.title, config.accentColor],
    ]);

    await evaluate(`(() => {
      const key = Object.keys(sessionStorage).find(key => key.endsWith("/${key}"));
      const entry = JSON.parse(sessionStorage.getItem(key));
      entry.savedAt -= 121_000;
      sessionStorage.setItem(key, JSON.stringify(entry));
    })()`);
    await navigate(`/${key}/expired`);
    await showTitle(config.title);
    expect((await frames()).map(({ title, accent }) => [title, accent])).toEqual([
      ["Loading chat…", "#475569"],
      [config.title, config.accentColor],
    ]);
  }, 15_000);
});
