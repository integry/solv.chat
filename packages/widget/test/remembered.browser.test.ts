// @vitest-environment node
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-pool-workers/config";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Browser, type Cdp, findChrome, launch, waitFor } from "./support/chromium.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const transcriptKey = "solv-chat-conversation:pk_remembered";
const tabKey = "solv-chat-open:pk_remembered";
const sessionKey = "solv-chat-session:pk_remembered";
const sevenDays = 7 * 24 * 60 * 60 * 1000;
const chrome = findChrome();

describe.skipIf(chrome === null)("remembered conversation in Chromium", () => {
  let browser: Browser;
  let worker: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  let site: string;
  let engine: string;
  const host = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
      <title>Product help center</title>
      <style>
        body { margin: 0; background: #f6f8fb; color: #17233a; font: 16px system-ui; }
        header { padding: 24px 7%; border-bottom: 1px solid #dce2eb; background: white; }
        main { max-width: 760px; padding: 50px 7%; }
        article { margin-top: 36px; padding: 4px 24px 12px; border: 1px solid #dce2eb;
          border-radius: 12px; background: white; }
      </style>
      <header><strong>Help Center</strong></header>
      <main><h1>Manage your workspace</h1>
      <p>Find answers about account settings, billing, and managing your team.</p>
      <article><h2>Workspace settings</h2><p>Manage access and preferences for your team.</p></article>
      <article><h2>Billing and plans</h2><p>Find your invoices and review what your plan includes.</p></article>
      </main>
      <script src="${engine}/widget.js" defer></script>
      <solv-chat assistant="pk_remembered"></solv-chat>`);
  });

  beforeAll(async () => {
    await new Promise<void>((done) => host.listen(0, "127.0.0.1", done));
    site = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;
    const widget = await build({
      entryPoints: [resolve(root, "src/widget.ts")],
      bundle: true,
      format: "iife",
      write: false,
    });
    const bundle = await build({
      entryPoints: [resolve(root, "test/support/remembered-engine.mjs")],
      bundle: true,
      format: "esm",
      write: false,
      plugins: [
        {
          name: "test-assets",
          setup(plugin) {
            plugin.onResolve({ filter: /(?:widget|admin)Bundle\.js$/ }, ({ path }) => ({
              path,
              namespace: "test-assets",
            }));
            plugin.onLoad({ filter: /.*/, namespace: "test-assets" }, ({ path }) => ({
              contents: path.endsWith("widgetBundle.js")
                ? `export const WIDGET_BUNDLE = ${JSON.stringify(widget.outputFiles[0]?.text)};
                   export const WIDGET_BOOT = "", WIDGET_BOOT_HASH = "";`
                : 'export const ADMIN_HTML = "", ADMIN_ASSETS = {};',
            }));
          },
        },
      ],
    });
    worker = new Miniflare({
      modules: [
        { type: "ESModule", path: "worker.js", contents: bundle.outputFiles[0]?.text ?? "" },
      ],
      d1Databases: ["DB"],
      compatibilityDate: "2025-01-01",
      bindings: {
        SITE_ORIGIN: site,
        // Public dummy keys, as in the engine visitor-check tests.
        // https://developers.cloudflare.com/turnstile/troubleshooting/testing/
        SOLV_TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
        SOLV_TURNSTILE_SECRET: "1x0000000000000000000000000000000AA",
        SOLV_SECRET_KEY: "widget-browser-test-only-signing-secret",
      },
    });
    const workerUrl = await worker.ready;
    engine = workerUrl.origin;
    db = await worker.getD1Database("DB");
    for (const { queries } of await readD1Migrations(resolve(root, "../engine/migrations"))) {
      if (queries.length) await db.batch(queries.map((query) => db.prepare(query)));
    }
    expect((await fetch(`${engine}/test/seed`)).status).toBe(204);
    browser = await launch(chrome as string);
  }, 90_000);

  beforeEach(async () => {
    await browser.cdp.send("Storage.clearDataForOrigin", {
      origin: site,
      storageTypes: "local_storage",
    });
  });

  afterAll(async () => {
    await browser?.close();
    await worker?.dispose();
    host.close();
  });

  async function tab(beforeLoad?: string) {
    const page = await browser.newTab();
    if (beforeLoad) {
      await page.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: beforeLoad });
    }
    await page.cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.cdp.send("Page.navigate", { url: site });
    await waitFor(() => widget(page.cdp, "!!r?.querySelector('.solv-launcher')"), "widget");
    return page;
  }

  function widget<T>(cdp: Cdp, expr: string): Promise<T> {
    return cdp.evaluate(
      `(() => { const el = document.querySelector("solv-chat"); const r = el?.shadowRoot; return ${expr}; })()`,
    );
  }

  async function open(cdp: Cdp): Promise<void> {
    await widget(cdp, 'r.querySelector(".solv-launcher").click()');
    await waitFor(
      () => widget(cdp, 'r.querySelector(".solv-title").textContent === "Product help"'),
      "open chat",
    );
  }

  function send(cdp: Cdp, message: string) {
    return widget<{ text: string }>(cdp, `el.send(${JSON.stringify(message)})`);
  }

  function transcript(cdp: Cdp) {
    return cdp.evaluate<{ conversationId: string; activityAt: number } | null>(
      `JSON.parse(localStorage.getItem(${JSON.stringify(transcriptKey)}))`,
    );
  }

  function messageCount(conversationId: string) {
    return db
      .prepare("SELECT COUNT(*) AS count FROM messages WHERE org_id = ?1 AND conversation_id = ?2")
      .bind("org_widget_browser", conversationId)
      .first<number>("count");
  }

  async function screenshot(cdp: Cdp, name: string): Promise<void> {
    if (!process.env.SOLV_REMEMBER_PREVIEWS) return;
    const dir = resolve(root, "../../.propr/previews");
    await mkdir(dir, { recursive: true });
    await widget(
      cdp,
      'Promise.all(r.querySelector(".solv-panel").getAnimations().map(a => a.finished))',
    );
    const { data } = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
    await writeFile(resolve(dir, name), Buffer.from(data, "base64"));
  }

  it("remembers a closed tab's conversation and continues it after a fresh visitor check", async () => {
    const first = await tab();
    await open(first.cdp);
    await send(first.cdp, "How do I change my workspace name?");
    const stored = await transcript(first.cdp);
    expect(stored?.conversationId).toBeTruthy();
    expect(await first.cdp.evaluate(`!!sessionStorage.getItem("${sessionKey}")`)).toBe(true);
    expect(
      await first.cdp.evaluate(`(() => {
        const { session } = JSON.parse(sessionStorage.getItem("${sessionKey}"));
        return Object.keys(localStorage).some(key => key.startsWith("solv-chat-session:") ||
          localStorage.getItem(key).includes(session));
      })()`),
    ).toBe(false);
    await first.close();

    const returning = await tab();
    try {
      expect(await returning.cdp.evaluate(`sessionStorage.getItem("${sessionKey}")`)).toBeNull();
      expect(await widget(returning.cdp, 'r.querySelector(".solv-panel").hidden')).toBe(true);
      await open(returning.cdp);
      expect(
        await widget(returning.cdp, 'r.querySelector(".solv-messages").textContent'),
      ).toContain("How do I change my workspace name?");
      await screenshot(returning.cdp, "remembered-conversation.png");
      await send(returning.cdp, "Can I change it from the billing page?");
      expect(await returning.cdp.evaluate(`!!sessionStorage.getItem("${sessionKey}")`)).toBe(true);
      expect(await transcript(returning.cdp)).toMatchObject({
        conversationId: stored?.conversationId,
      });
      expect(await messageCount(stored?.conversationId ?? "")).toBe(4);
    } finally {
      await returning.close();
    }
  });

  it("synchronizes both tabs, rejects a competing send, and clears both when starting over", async () => {
    const a = await tab();
    const b = await tab();
    try {
      await open(a.cdp);
      await widget(a.cdp, "el.newConversation()");
      await send(a.cdp, "How do I manage workspace security?");
      await open(b.cdp);
      const question = "Which plans include audit logs?";
      await fetch(`${engine}/test/hold`);
      const answering = send(a.cdp, question);
      try {
        await waitFor(
          () =>
            widget(
              a.cdp,
              'r.querySelector(".solv-bubble:last-child").textContent.includes("help center")',
            ),
          "reply text streaming in the first tab",
        );
        await waitFor(
          () =>
            widget(
              b.cdp,
              `r.querySelector(".solv-messages").textContent.includes(${JSON.stringify(question)})`,
            ),
          "question in the other tab before its reply",
        );
        await widget(
          b.cdp,
          `(r.querySelector("#solv-input").value = "Can I export them?", r.querySelector("form").requestSubmit())`,
        );
        await waitFor(
          () =>
            widget(b.cdp, 'r.querySelector(".solv-input-error").textContent.includes("other tab")'),
          "busy message",
        );
        expect(await widget(b.cdp, 'r.querySelector("#solv-input").value')).toBe(
          "Can I export them?",
        );
      } finally {
        await fetch(`${engine}/test/release`);
        await answering;
      }
      await waitFor(
        () => widget(b.cdp, 'r.querySelectorAll(".solv-feedback").length === 2'),
        "second reply in the other tab",
      );
      const old = await transcript(a.cdp);
      expect(await messageCount(old?.conversationId ?? "")).toBe(4);
      await send(b.cdp, "Can I export them?");
      expect(await messageCount(old?.conversationId ?? "")).toBe(6);
      await widget(b.cdp, 'r.querySelector(".solv-new").click()');
      await waitFor(
        () => widget(a.cdp, '!r.querySelector(".solv-bubble--user")'),
        "cleared transcript in the other tab",
      );
      expect(await transcript(a.cdp)).toBeNull();
      expect(await messageCount(old?.conversationId ?? "")).toBe(6);
    } finally {
      await b.close();
      await a.close();
    }
  });

  it("keeps a just-under-seven-day transcript and removes it on a closed-panel load after seven days", async () => {
    const seed = await tab();
    await widget(seed.cdp, "el.newConversation()");
    await send(seed.cdp, "A question that should expire.");
    const stored = await transcript(seed.cdp);
    if (!stored) throw new Error("Absent transcript");
    await seed.close();

    const before = await tab(`Date.now = () => ${stored.activityAt + sevenDays - 1}`);
    await open(before.cdp);
    expect(await widget(before.cdp, 'r.querySelector(".solv-messages").textContent')).toContain(
      "A question that should expire.",
    );
    expect(await transcript(before.cdp)).toEqual(stored);
    await before.close();

    const after = await tab(`Date.now = () => ${stored.activityAt + sevenDays + 1}`);
    expect(await widget(after.cdp, 'r.querySelector(".solv-panel").hidden')).toBe(true);
    expect(await transcript(after.cdp)).toBeNull();
    await open(after.cdp);
    expect(await widget(after.cdp, 'r.querySelector(".solv-bubble--user") === null')).toBe(true);
    await after.close();
  });

  it("moves legacy turns out of tab storage and recovers cleanly from server deletion", async () => {
    const legacy = {
      conversationId: "cnv_missing",
      open: true,
      view: { draft: "Saved draft" },
      turns: [
        { role: "user", text: "Oldest archived question" },
        ...Array.from({ length: 20 }, (_, i) => ({ role: "user", text: `Earlier question ${i}` })),
      ],
    };
    const legacyScript = `
      sessionStorage.setItem(${JSON.stringify(tabKey)}, ${JSON.stringify(JSON.stringify(legacy))});
    `;
    const { cdp, close } = await tab(legacyScript);
    try {
      expect(await transcript(cdp)).toMatchObject({ conversationId: "cnv_missing" });
      expect(await widget(cdp, 'r.querySelectorAll(".solv-bubble--user").length')).toBe(20);
      expect(await widget(cdp, 'r.querySelector(".solv-messages").textContent')).not.toContain(
        "Oldest archived question",
      );
      expect(await widget(cdp, 'r.querySelector(".solv-panel").hidden')).toBe(false);
      expect(await widget(cdp, 'r.querySelector("#solv-input").value')).toBe("Saved draft");
      expect(
        await cdp.evaluate(`JSON.parse(sessionStorage.getItem("${tabKey}")).turns`),
      ).toBeUndefined();
      await send(cdp, "Where can I find my invoices?");
      const active = await transcript(cdp);
      expect(active?.conversationId).not.toBe("cnv_missing");
      await db
        .prepare("DELETE FROM conversations WHERE org_id = ?1 AND id = ?2")
        .bind("org_widget_browser", active?.conversationId ?? "")
        .run();
      await send(cdp, "Can I download a copy?");
      expect((await transcript(cdp))?.conversationId).not.toBe(active?.conversationId);
      expect(await widget(cdp, 'r.querySelector(".solv-messages").textContent')).not.toContain(
        "Where can I find my invoices?",
      );
      expect(await widget(cdp, 'r.querySelector(".solv-conversation-note").textContent')).toContain(
        "A new one has started.",
      );
      expect(await widget(cdp, 'r.querySelector(".solv-bubble-error") === null')).toBe(true);
      await screenshot(cdp, "conversation-restarted.png");
      await widget(cdp, "el.newConversation()");
      const stale = await tab(legacyScript);
      try {
        expect(await transcript(stale.cdp)).toBeNull();
        expect(await widget(stale.cdp, 'r.querySelector(".solv-bubble--user") === null')).toBe(
          true,
        );
      } finally {
        await stale.close();
      }
    } finally {
      await close();
    }
  });

  it.each(["blocked", "quota"])(
    "falls back to tab storage when localStorage is %s",
    async (mode) => {
      const override =
        mode === "blocked"
          ? 'Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Blocked", "SecurityError"); } });'
          : 'const set = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (this === localStorage) throw new DOMException("Full", "QuotaExceededError"); return set.call(this, key, value); };';
      const { cdp, close } = await tab(override);
      try {
        await open(cdp);
        await send(cdp, "Can I update my billing address?");
        const stored = await cdp.evaluate<{ conversationId: string }>(
          `JSON.parse(sessionStorage.getItem("${tabKey}"))`,
        );
        expect(stored.conversationId).toBeTruthy();
        await cdp.send("Page.navigate", { url: `${site}/other` });
        await waitFor(
          () =>
            widget(
              cdp,
              'location.pathname === "/other" && r?.querySelector(".solv-messages").textContent.includes("billing address")',
            ),
          "same-tab transcript",
        );
        await send(cdp, "Can I add a tax ID too?");
        expect(await messageCount(stored.conversationId)).toBe(4);
        await widget(cdp, "el.newConversation()");
        expect(await cdp.evaluate(`JSON.parse(sessionStorage.getItem("${tabKey}"))`)).toMatchObject(
          { conversationId: null, turns: [] },
        );
      } finally {
        await close();
      }
    },
  );

  it("clears an earlier shared transcript after a quota failure moves the tab to fallback", async () => {
    const page = await tab();
    try {
      await open(page.cdp);
      await send(page.cdp, "Can I update my billing address?");
      const shared = await transcript(page.cdp);
      expect(shared?.conversationId).toBeTruthy();
      await page.cdp.evaluate(`(() => {
        const set = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key, value) {
          if (this === localStorage && key === ${JSON.stringify(transcriptKey)}) {
            throw new DOMException("Full", "QuotaExceededError");
          }
          return set.call(this, key, value);
        };
      })()`);
      await send(page.cdp, "Can I add a tax ID too?");
      expect(await transcript(page.cdp)).toEqual(shared);
      expect(
        await page.cdp.evaluate(`JSON.parse(sessionStorage.getItem("${tabKey}")).tabOnly`),
      ).toBe(true);

      await widget(page.cdp, 'r.querySelector(".solv-new").click()');
      await waitFor(
        () => widget(page.cdp, '!r.querySelector(".solv-bubble--user")'),
        "reset after quota failure",
      );
      expect(await transcript(page.cdp)).toBeNull();

      const returning = await tab();
      try {
        await open(returning.cdp);
        expect(await widget(returning.cdp, 'r.querySelector(".solv-bubble--user") === null')).toBe(
          true,
        );
        await screenshot(returning.cdp, "reset-after-quota.png");
      } finally {
        await returning.close();
      }
    } finally {
      await page.close();
    }
  });
});
