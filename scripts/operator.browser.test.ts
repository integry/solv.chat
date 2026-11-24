import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { readD1Migrations } from "@cloudflare/vitest-pool-workers/config";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Browser,
  findChrome,
  launch,
  waitFor,
} from "../packages/widget/test/support/chromium.js";

const root = resolve(import.meta.dirname, "..");
const enginePath = resolve(root, "packages/engine");
const chrome = findChrome();
const capture = process.env.SOLV_OPERATOR_PREVIEWS === "1";
const previews: { path: string; title: string; description: string }[] = [];
const previewFolder = ".propr/previews";
const password = "browser-fixture-password";

function manifest() {
  mkdirSync(resolve(root, previewFolder), { recursive: true });
  writeFileSync(
    resolve(root, previewFolder, "manifest.json"),
    `${JSON.stringify(
      {
        previews,
        toolSuggestions: chrome
          ? []
          : [
              {
                name: "Chromium",
                reason:
                  "Install Chromium or set CHROME_PATH to capture the operator admin, sign-in, and consent screens.",
              },
            ],
      },
      null,
      2,
    )}\n`,
  );
}

if (capture && !chrome) manifest();

describe.skipIf(chrome === null)("operator access in Chromium", () => {
  let worker: Miniflare | undefined;
  let browser: Browser | undefined;
  let origin = "";
  let callback = "";
  let authorization = "";
  const callbackServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("Connection complete");
  });

  beforeAll(async () => {
    execFileSync(process.execPath, ["scripts/sync-widget.mjs"], { cwd: enginePath });
    execFileSync(process.execPath, ["scripts/sync-admin.mjs"], { cwd: enginePath });
    const bundle = await build({
      entryPoints: [resolve(enginePath, "src/worker.ts")],
      alias: { "@solvchat/core": resolve(root, "packages/core/src/index.ts") },
      bundle: true,
      format: "esm",
      write: false,
    });
    worker = new Miniflare({
      modules: [
        { type: "ESModule", path: "worker.js", contents: bundle.outputFiles[0]?.text ?? "" },
      ],
      d1Databases: ["DB"],
      compatibilityDate: "2025-05-01",
      bindings: {
        SOLV_ADMIN_PASSWORD: password,
        SOLV_SECRET_KEY: "browser-fixture-signing-key",
        // This screen makes no Turnstile requests. The fixtures keep the
        // capture focused on the connection and token controls.
        SOLV_TURNSTILE_SITE_KEY: "fixture-operator-browser-site-key",
        SOLV_TURNSTILE_SECRET: "fixture-operator-browser-secret",
      },
    });
    origin = (await worker.ready).origin;
    const db = await worker.getD1Database("DB");
    for (const { queries } of await readD1Migrations(resolve(enginePath, "migrations"))) {
      if (queries.length) await db.batch(queries.map((query) => db.prepare(query)));
    }
    await new Promise<void>((done) => callbackServer.listen(0, "127.0.0.1", done));
    callback = `http://127.0.0.1:${(callbackServer.address() as AddressInfo).port}/callback`;
    const registered = await fetch(`${origin}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Docs Workspace",
        redirect_uris: [callback],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(registered.status).toBe(201);
    const { client_id } = (await registered.json()) as { client_id: string };
    const params = new URLSearchParams({
      client_id,
      redirect_uri: callback,
      response_type: "code",
      resource: `${origin}/mcp`,
      scope: "read full",
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update("v".repeat(64)).digest("base64url"),
    });
    authorization = `${origin}/oauth/authorize?${params}`;
    browser = await launch(chrome ?? "");
  }, 75_000);

  afterAll(async () => {
    try {
      await browser?.close();
    } finally {
      await worker?.dispose();
      if (callbackServer.listening) {
        await new Promise<void>((done) => callbackServer.close(() => done()));
      }
      if (capture) manifest();
    }
  });

  it("signs in, grants access, and manages a token at desktop and mobile in light and dark", async () => {
    if (!browser) throw new Error("Chromium was not started");
    const { cdp } = browser;
    await cdp.send("Network.enable");
    const heading = (name: string) =>
      waitFor(
        () =>
          cdp.evaluate<boolean>(
            `document.querySelector('h1')?.textContent === ${JSON.stringify(name)}`,
          ),
        name,
      );
    for (const width of [1280, 380]) {
      for (const theme of ["light", "dark"]) {
        const height = 900;
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await cdp.send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: theme }],
        });
        await cdp.send("Network.clearBrowserCookies");

        const screenshot = async (screen: string, title: string) => {
          expect(
            await cdp.evaluate<boolean>("document.documentElement.scrollWidth <= innerWidth"),
          ).toBe(true);
          const dark = await cdp.evaluate<boolean>(
            "getComputedStyle(document.documentElement).colorScheme.includes('dark')",
          );
          expect(dark).toBe(theme === "dark");
          if (!capture) return;
          const contentHeight =
            screen === "tokens"
              ? await cdp.evaluate<number>("document.documentElement.scrollHeight")
              : height;
          const { data } = await cdp.send<{ data: string }>("Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: true,
            clip: { x: 0, y: 0, width, height: contentHeight, scale: 1 },
          });
          const path = `${previewFolder}/operator-${screen}-${width}-${theme}.png`;
          mkdirSync(resolve(root, previewFolder), { recursive: true });
          writeFileSync(resolve(root, path), Buffer.from(data, "base64"));
          previews.push({
            path,
            title: `${title} · ${width}px · ${theme}`,
            description: `The ${title.toLowerCase()} at ${width}px in ${theme} mode.`,
          });
        };

        await cdp.send("Page.navigate", { url: authorization });
        await heading("Sign in to solv.chat");
        await screenshot("sign-in", "MCP sign-in");
        await cdp.evaluate(`(() => {
          document.querySelector('#password').value = ${JSON.stringify(password)};
          document.querySelector('button[value="sign-in"]').click();
        })()`);
        await heading("Connect to solv.chat");
        expect(
          await cdp.evaluate(
            "document.querySelector('main').textContent.includes('Docs Workspace')",
          ),
        ).toBe(true);
        await screenshot("consent", "MCP consent");
        await cdp.evaluate("document.querySelector('button[value=allow]').click()");
        await waitFor(
          () =>
            cdp.evaluate<boolean>(
              `location.href.startsWith(${JSON.stringify(callback)}) && Boolean(new URL(location.href).searchParams.get('code'))`,
            ),
          "authorization callback",
        );

        const code = await cdp.evaluate<string>("new URL(location.href).searchParams.get('code')");
        const exchanged = await fetch(`${origin}/oauth/token`, {
          method: "POST",
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: new URL(authorization).searchParams.get("client_id") ?? "",
            code,
            code_verifier: "v".repeat(64),
            redirect_uri: callback,
            resource: `${origin}/mcp`,
          }),
        });
        expect(exchanged.status).toBe(200);
        const { refresh_token: refreshToken } = (await exchanged.json()) as {
          refresh_token: string;
        };
        await cdp.send("Page.navigate", { url: `${origin}/admin/operator-access` });
        await heading("MCP access");
        await waitFor(
          () => cdp.evaluate<boolean>("document.querySelector('.operator-list') !== null"),
          "active client",
        );
        if (width === 1280 && theme === "light") {
          await cdp.evaluate(`(() => {
            const input = document.querySelector('#operator-token-name');
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Activity reports');
            input.dispatchEvent(new Event('input', { bubbles: true }));
          })()`);
          await waitFor(
            () =>
              cdp.evaluate<boolean>(
                "!document.querySelector('.operator-token-form button').disabled",
              ),
            "token form enabled",
          );
          await cdp.evaluate("document.querySelector('.operator-token-form button').click()");
          await waitFor(
            () =>
              cdp.evaluate<boolean>(
                "document.querySelector('.operator-issued code')?.textContent.startsWith('solv_pat_')",
              ),
            "one-time token",
          );
          await cdp.evaluate("document.querySelector('.operator-issued > button').click()");
          await waitFor(
            () =>
              cdp.evaluate<boolean>(
                "document.querySelector('.operator-list').textContent.includes('Activity reports')",
              ),
            "token listed",
          );
        }
        expect(await cdp.evaluate<boolean>("!document.body.innerText.includes('solv_pat_')")).toBe(
          true,
        );
        await screenshot("tokens", "Operator access screen");
        if (width !== 380 || theme !== "dark") {
          const revoked = await fetch(`${origin}/oauth/revoke`, {
            method: "POST",
            body: new URLSearchParams({
              client_id: new URL(authorization).searchParams.get("client_id") ?? "",
              token: refreshToken,
            }),
          });
          expect(revoked.status).toBe(200);
          await revoked.body?.cancel();
        }
      }
    }
    await cdp.evaluate(
      "document.querySelector('button[aria-label=\"Revoke Activity reports\"]').click()",
    );
    await waitFor(
      () => cdp.evaluate<boolean>("document.querySelector('[role=dialog]') !== null"),
      "revoke confirmation",
    );
    await cdp.evaluate("document.querySelector('[role=dialog] .btn-danger').click()");
    await waitFor(
      () =>
        cdp.evaluate<boolean>(
          "!document.querySelector('.operator-list').textContent.includes('Activity reports')",
        ),
      "revoked entry disappears",
    );
  }, 60_000);
});
