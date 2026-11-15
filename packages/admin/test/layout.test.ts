// @vitest-environment node

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AnswerTest, Assistant, AssistantReport, McpServerSummary } from "../src/api/types.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ADMIN_ROOT = resolve(TEST_DIR, "..");

const ASSISTANT: Assistant = {
  id: "ast_1",
  orgId: "org_00000000000000000000",
  name: "Docs Bot",
  publicKey: "pk_ast_1",
  allowedOrigins: ["https://docs.example.com"],
  hasIngestKey: true,
  createdAt: 1_700_000_000_000,
};

const SERVERS: McpServerSummary[] = [
  {
    id: "mcp_1",
    assistantId: ASSISTANT.id,
    label: "Server Enabled",
    url: "https://a.example.com/mcp",
    authKind: "static_header",
    headerName: "Authorization",
    hasSecret: true,
    enabled: true,
    createdAt: 1_700_000_000_000,
    toolCount: 2,
    allowedCount: 1,
  },
  {
    id: "mcp_2",
    assistantId: ASSISTANT.id,
    label: "Server Disabled",
    url: "https://very-long-server-hostname-that-pushes-unconstrained-headers-to-wrap.example.com/some/very/long/path/mcp",
    authKind: "none",
    headerName: null,
    hasSecret: false,
    enabled: false,
    createdAt: 1_700_000_000_000,
    toolCount: 0,
    allowedCount: 0,
  },
];

const REPORT: AssistantReport = {
  days: 30,
  from: "2026-10-16",
  to: "2026-11-15",
  questions: 42,
  replies: 40,
  answeredShare: 0.754,
  thumbsDownShare: 0.125,
  costMicros: 5_000,
  topQuestions: [
    {
      question:
        "Can you explain in great detail how enterprise billing, invoicing, and annual renewals work across multiple regions?",
      count: 9,
    },
  ],
  topGaps: [
    {
      question: "How do I configure single sign-on with a custom SAML identity provider?",
      count: 4,
    },
  ],
  topSources: [
    {
      url: "https://docs.example.com/guides/getting-started-with-enterprise-billing",
      title: "Enterprise Billing Guide",
      count: 7,
    },
  ],
  uncitedSources: [],
  uncitedTotal: 0,
};

const TESTS: AnswerTest[] = [
  {
    id: "tst_1",
    orgId: ASSISTANT.orgId,
    assistantId: ASSISTANT.id,
    question: "What is the refund policy?",
    expectation: { kind: "contains", phrase: "30 days" },
    createdAt: 1_700_000_000_000,
    latestResult: null,
  },
  {
    id: "tst_2",
    orgId: ASSISTANT.orgId,
    assistantId: ASSISTANT.id,
    question: "How do I reset my password?",
    expectation: { kind: "contains", phrase: "Settings" },
    createdAt: 1_700_000_000_000,
    latestResult: {
      testId: "tst_2",
      question: "How do I reset my password?",
      expectation: { kind: "contains", phrase: "Settings" },
      outcome: "passed",
      reason: "ok",
      excerpt: "Go to Settings.",
    },
  },
  {
    id: "tst_3",
    orgId: ASSISTANT.orgId,
    assistantId: ASSISTANT.id,
    question: "Can I export audit logs?",
    expectation: { kind: "contains", phrase: "CSV" },
    createdAt: 1_700_000_000_000,
    latestResult: {
      testId: "tst_3",
      question: "Can I export audit logs?",
      expectation: { kind: "contains", phrase: "CSV" },
      outcome: "failed",
      reason: "missing phrase",
      excerpt: "Not sure.",
    },
  },
];

function findChromeBinary(): string {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "No Chromium/Chrome executable found for browser layout tests. Set CHROME_PATH or install chromium.",
  );
}

class CdpClient {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: { message?: string };
      };
      if (msg.id === undefined) return;
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        entry.reject(new Error(msg.error.message ?? "CDP error"));
      } else {
        entry.resolve(msg.result);
      }
    });
  }

  static async connect(wsUrl: string): Promise<CdpClient> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolveReady, rejectReady) => {
      ws.addEventListener("open", () => resolveReady(), { once: true });
      ws.addEventListener("error", () => rejectReady(new Error("WebSocket connection failed")), {
        once: true,
      });
    });
    return new CdpClient(ws);
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolveMsg, rejectMsg) => {
      this.pending.set(id, {
        resolve: resolveMsg as (value: unknown) => void,
        reject: rejectMsg,
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const res = await this.send<{
      result?: { value?: T };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description ??
          res.exceptionDetails.text ??
          "Runtime.evaluate failed",
      );
    }
    return res.result?.value as T;
  }

  close() {
    this.ws.close();
  }
}

async function launchChromium(): Promise<{
  process: ChildProcess;
  cdp: CdpClient;
  userDataDir: string;
}> {
  const chromePath = findChromeBinary();
  const userDataDir = mkdtempSync(resolve(tmpdir(), "solvchat-admin-chrome-"));
  const proc = spawn(
    chromePath,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-extensions",
      "--password-store=basic",
      "--use-mock-keychain",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "about:blank",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        DBUS_SESSION_BUS_ADDRESS: "/dev/null",
      },
    },
  );

  try {
    const devToolsPortPath = resolve(userDataDir, "DevToolsActivePort");
    const wsBrowserUrl = await new Promise<string>((resolveUrl, rejectUrl) => {
      let settled = false;
      let output = "";

      const finish = (err: Error | null, url?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(pollTimer);
        if (err) {
          rejectUrl(err);
        } else if (url) {
          resolveUrl(url);
        }
      };

      const checkOutput = (chunk: Buffer) => {
        output += chunk.toString("utf8");
        const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match?.[1]) {
          finish(null, match[1]);
        }
      };

      const timer = setTimeout(() => {
        finish(
          new Error(
            `Timed out waiting for Chromium DevTools endpoint (${chromePath}). Output: ${output.slice(0, 500)}`,
          ),
        );
      }, 25_000);

      const pollTimer = setInterval(() => {
        if (!existsSync(devToolsPortPath)) return;
        try {
          const lines = readFileSync(devToolsPortPath, "utf8").trim().split(/\r?\n/);
          const port = lines[0]?.trim();
          const wsPath = lines[1]?.trim();
          if (port && wsPath) {
            finish(null, `ws://127.0.0.1:${port}${wsPath}`);
          }
        } catch {
          // File may still be partially written; retry on next tick.
        }
      }, 100);

      proc.stdout?.on("data", checkOutput);
      proc.stderr?.on("data", checkOutput);
      proc.on("error", (err) => {
        finish(new Error(`Failed to spawn Chromium (${chromePath}): ${err.message}`));
      });
      proc.on("exit", (code) => {
        finish(new Error(`Chromium exited early with code ${code}: ${output.slice(0, 500)}`));
      });
    });

    const devToolsOrigin = new URL(wsBrowserUrl).origin.replace(/^ws:/, "http:");
    const targets = (await (await fetch(`${devToolsOrigin}/json/list`)).json()) as Array<{
      type: string;
      webSocketDebuggerUrl?: string;
    }>;
    const pageTarget = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (!pageTarget?.webSocketDebuggerUrl) {
      throw new Error("Could not find Chromium page target");
    }

    const cdp = await CdpClient.connect(pageTarget.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    return { process: proc, cdp, userDataDir };
  } catch (err) {
    if (proc.exitCode === null) {
      proc.kill("SIGKILL");
    }
    rmSync(userDataDir, { recursive: true, force: true });
    throw err;
  }
}

describe("Admin layout regressions (Chromium)", () => {
  let viteServer: ViteDevServer;
  let baseUrl: string;
  let chromeProc: ChildProcess;
  let cdp: CdpClient;
  let userDataDir: string;

  beforeAll(async () => {
    viteServer = await createServer({
      root: ADMIN_ROOT,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0, strictPort: false },
      plugins: [
        {
          name: "admin-layout-test-api-stub",
          configureServer(server) {
            server.middlewares.use("/api/admin", (req, res) => {
              const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
              res.setHeader("Content-Type", "application/json");
              if (pathname === "/assistants") {
                res.end(JSON.stringify({ assistants: [ASSISTANT] }));
                return;
              }
              if (pathname === `/assistants/${ASSISTANT.id}/mcp-servers`) {
                res.end(JSON.stringify({ servers: SERVERS }));
                return;
              }
              if (pathname === `/assistants/${ASSISTANT.id}/report`) {
                res.end(JSON.stringify(REPORT));
                return;
              }
              if (pathname === `/assistants/${ASSISTANT.id}/tests`) {
                res.end(JSON.stringify({ tests: TESTS }));
                return;
              }
              res.end(JSON.stringify({}));
            });
          },
        },
      ],
    });
    await viteServer.listen();
    const addr = viteServer.httpServer?.address();
    if (!addr || typeof addr === "string") {
      throw new Error("Failed to determine Vite server port");
    }
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const launched = await launchChromium();
    chromeProc = launched.process;
    cdp = launched.cdp;
    userDataDir = launched.userDataDir;
  }, 45_000);

  afterAll(async () => {
    cdp?.close();
    if (chromeProc && chromeProc.exitCode === null) {
      const exited = new Promise<void>((resolveExit) => {
        chromeProc.once("exit", () => resolveExit());
      });
      chromeProc.kill("SIGKILL");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
    }
    if (userDataDir) {
      rmSync(userDataDir, { recursive: true, force: true });
    }
    await viteServer?.close();
  });

  async function openScreen(path: string, width: number, readySelector: string) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: width < 600,
    });
    await cdp.send("Page.navigate", { url: `${baseUrl}${path}` });

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const ready = await cdp.evaluate<boolean>(
        `Boolean(document.querySelector(${JSON.stringify(readySelector)}))`,
      );
      if (ready) {
        await cdp.evaluate<void>(
          "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))",
        );
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    const bodyText = await cdp.evaluate<string>("document.body?.innerText ?? ''");
    throw new Error(
      `Timed out waiting for ${readySelector} on ${path} at ${width}px. Body: ${bodyText.slice(0, 300)}`,
    );
  }

  it("places Tools server card actions at top-right at 1440px and wraps them cleanly at 390px", async () => {
    interface CardMetrics {
      headerRect: { left: number; right: number; top: number; bottom: number };
      firstRect: { left: number; right: number; top: number; bottom: number };
      actionsRect: { left: number; right: number; top: number; bottom: number };
      firstScrollWidth: number;
      firstClientWidth: number;
    }

    const measureCards = () =>
      cdp.evaluate<CardMetrics[]>(`(() => {
        return Array.from(document.querySelectorAll("ul.source-list > li.source-card")).map((card) => {
          const header = card.querySelector(".source-row-header");
          const first = header.firstElementChild;
          const actions = header.querySelector(".actions");
          const toRect = (el) => {
            const r = el.getBoundingClientRect();
            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
          };
          return {
            headerRect: toRect(header),
            firstRect: toRect(first),
            actionsRect: toRect(actions),
            firstScrollWidth: first.scrollWidth,
            firstClientWidth: first.clientWidth,
          };
        });
      })()`);

    await openScreen("/admin/tools", 1440, "ul.source-list > li.source-card");
    const desktopCards = await measureCards();
    expect(desktopCards).toHaveLength(2);
    for (const card of desktopCards) {
      expect(card.actionsRect.top).toBeLessThan(card.firstRect.bottom);
      expect(Math.abs(card.actionsRect.top - card.firstRect.top)).toBeLessThanOrEqual(4);
      expect(card.actionsRect.left).toBeGreaterThanOrEqual(card.firstRect.right - 1);
      expect(card.firstScrollWidth).toBeLessThanOrEqual(card.firstClientWidth + 1);
    }
    expect(
      Math.abs(
        (desktopCards[0]?.actionsRect.right ?? 0) - (desktopCards[1]?.actionsRect.right ?? 0),
      ),
    ).toBeLessThanOrEqual(2);

    await openScreen("/admin/tools", 390, "ul.source-list > li.source-card");
    const mobileCards = await measureCards();
    expect(mobileCards).toHaveLength(2);
    for (const card of mobileCards) {
      expect(card.actionsRect.top).toBeGreaterThanOrEqual(card.firstRect.bottom - 1);
      expect(Math.abs(card.actionsRect.left - card.firstRect.left)).toBeLessThanOrEqual(1);
      expect(card.firstScrollWidth).toBeLessThanOrEqual(card.firstClientWidth + 1);
    }
  }, 15_000);

  it("keeps Reports count pills on a single line at 1440px and 390px", async () => {
    interface PillMetrics {
      lineRects: number;
      badgeRight: number;
      itemRight: number;
      firstScrollWidth: number;
      firstClientWidth: number;
    }

    const measurePills = () =>
      cdp.evaluate<PillMetrics[]>(`(() => {
        return Array.from(document.querySelectorAll(".history-item")).map((item) => {
          const badge = item.querySelector(".badge");
          const first = item.firstElementChild;
          const range = document.createRange();
          range.selectNodeContents(badge);
          const badgeRect = badge.getBoundingClientRect();
          const itemRect = item.getBoundingClientRect();
          return {
            lineRects: range.getClientRects().length,
            badgeRight: badgeRect.right,
            itemRight: itemRect.right,
            firstScrollWidth: first.scrollWidth,
            firstClientWidth: first.clientWidth,
          };
        });
      })()`);

    for (const width of [1440, 390]) {
      await openScreen("/admin/reports", width, ".history-item > .badge");
      const pills = await measurePills();
      expect(pills.length).toBeGreaterThanOrEqual(3);
      for (const pill of pills) {
        expect(pill.lineRects).toBe(1);
        expect(pill.badgeRight).toBeLessThanOrEqual(pill.itemRight + 1);
        expect(pill.firstScrollWidth).toBeLessThanOrEqual(pill.firstClientWidth + 1);
      }
    }
  }, 15_000);

  it("vertically centers Tests status badges with Edit and Delete buttons at 1440px and 390px", async () => {
    interface AlignmentMetrics {
      badgeHeight: number;
      buttonHeight: number;
      badgeCenterY: number;
      buttonCenterY: number;
    }

    const measureAlignment = () =>
      cdp.evaluate<AlignmentMetrics[]>(`(() => {
        return Array.from(document.querySelectorAll(".actions"))
          .filter((actions) => actions.querySelector(".badge") && actions.querySelector("button"))
          .map((actions) => {
            const badge = actions.querySelector(".badge").getBoundingClientRect();
            const button = actions.querySelector("button").getBoundingClientRect();
            return {
              badgeHeight: badge.height,
              buttonHeight: button.height,
              badgeCenterY: badge.top + badge.height / 2,
              buttonCenterY: button.top + button.height / 2,
            };
          });
      })()`);

    for (const width of [1440, 390]) {
      await openScreen("/admin/tests", width, ".actions .badge");
      const rows = await measureAlignment();
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.badgeHeight).toBeLessThan(row.buttonHeight - 2);
        expect(Math.abs(row.badgeCenterY - row.buttonCenterY)).toBeLessThanOrEqual(1.5);
      }
    }
  }, 15_000);
});
