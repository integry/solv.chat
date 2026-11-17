// @vitest-environment node

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultVersionConfig } from "@solvchat/core";
import axe from "axe-core";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  AnswerTest,
  Assistant,
  AssistantReport,
  McpServerSummary,
  VersionRow,
} from "../src/api/types.js";
import {
  monitorConversationDetail,
  monitorConversations,
  monitorGaps,
  monitorOverview,
} from "./support/monitorFixtures.js";

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

const PUBLISHED_CONFIG = defaultVersionConfig();
const DRAFT_CONFIG = defaultVersionConfig();
DRAFT_CONFIG.behaviour = { ...DRAFT_CONFIG.behaviour, greeting: "Hello! Ask me about the docs." };

function versionRow(state: VersionRow["state"], config: VersionRow["config"]): VersionRow {
  return {
    id: `ver_${state}`,
    orgId: ASSISTANT.orgId,
    assistantId: ASSISTANT.id,
    state,
    config,
    createdAt: 1_700_000_000_000,
    publishedAt: state === "draft" ? null : 1_700_000_100_000,
  };
}

function findChromeBinary(): string {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
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

/** Stops Chromium and every child it started (it runs in its own process group). */
function killChromium(proc: ChildProcess) {
  try {
    if (proc.pid !== undefined) process.kill(-proc.pid, "SIGKILL");
  } catch {
    proc.kill("SIGKILL");
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
      // Its own process group, so teardown can stop the renderer and GPU
      // children too; they otherwise keep writing to the profile directory.
      detached: true,
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
            `Timed out waiting for Chromium DevTools endpoint (${chromePath}). Output: ${output.slice(-1000)}`,
          ),
        );
      }, 60_000);

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
      killChromium(proc);
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
              if (pathname === `/assistants/${ASSISTANT.id}/versions`) {
                res.end(
                  JSON.stringify({
                    versions: [
                      versionRow("draft", DRAFT_CONFIG),
                      versionRow("published", PUBLISHED_CONFIG),
                    ],
                  }),
                );
                return;
              }
              if (pathname === `/assistants/${ASSISTANT.id}/draft`) {
                res.end(JSON.stringify({ draft: versionRow("draft", DRAFT_CONFIG) }));
                return;
              }
              if (pathname === `/assistants/${ASSISTANT.id}/overview`) {
                res.end(JSON.stringify(monitorOverview(Date.now())));
                return;
              }
              if (pathname === `/assistants/${ASSISTANT.id}/conversations`) {
                const conversations = monitorConversations(Date.now());
                res.end(JSON.stringify({ conversations, total: 60, limit: 25, offset: 0 }));
                return;
              }
              if (pathname === "/conversations/cnv_1") {
                res.end(JSON.stringify(monitorConversationDetail(Date.now())));
                return;
              }
              if (pathname === `/assistants/${ASSISTANT.id}/gaps`) {
                const gaps = monitorGaps(Date.now());
                res.end(JSON.stringify({ gaps, total: gaps.length, limit: 25, offset: 0 }));
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
  }, 75_000);

  afterAll(async () => {
    cdp?.close();
    if (chromeProc && chromeProc.exitCode === null) {
      const exited = new Promise<void>((resolveExit) => {
        chromeProc.once("exit", () => resolveExit());
      });
      killChromium(chromeProc);
      await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
    }
    if (userDataDir) {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
      expect(card.actionsRect.right).toBeLessThanOrEqual(card.headerRect.right + 1);
      expect(card.firstScrollWidth).toBeLessThanOrEqual(card.firstClientWidth + 1);
    }

    await cdp.evaluate<void>(`(() => {
      const card = document.querySelector("ul.source-list > li.source-card");
      const editBtn = Array.from(card.querySelectorAll(".actions button")).find(
        (btn) => btn.textContent?.trim() === "Edit",
      );
      editBtn?.click();
    })()`);
    await cdp.evaluate<void>(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const check = () => {
        const card = document.querySelector("ul.source-list > li.source-card");
        const hasCloseEdit = Array.from(card?.querySelectorAll(".actions button") ?? []).some(
          (btn) => btn.textContent?.trim() === "Close edit",
        );
        if (hasCloseEdit) {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error("Timed out waiting for Close edit button"));
          return;
        }
        setTimeout(check, 20);
      };
      check();
    })`);

    const mobileCardsWithEditor = await measureCards();
    expect(mobileCardsWithEditor).toHaveLength(2);
    for (const card of mobileCardsWithEditor) {
      expect(card.actionsRect.top).toBeGreaterThanOrEqual(card.firstRect.bottom - 1);
      expect(Math.abs(card.actionsRect.left - card.firstRect.left)).toBeLessThanOrEqual(1);
      expect(card.actionsRect.right).toBeLessThanOrEqual(card.headerRect.right + 1);
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
  async function waitFor(expression: string, what: string) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (await cdp.evaluate<boolean>(`Boolean(${expression})`)) {
        await cdp.evaluate<void>(
          "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))",
        );
        return;
      }
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error(`Timed out waiting for ${what}`);
  }

  const horizontalOverflow = () =>
    cdp.evaluate<number>(
      "document.documentElement.scrollWidth - document.documentElement.clientWidth",
    );

  it("has no horizontal scroll at 320px on any shell screen, drawer open or closed", async () => {
    for (const path of [
      "/admin/overview",
      "/admin/reports",
      "/admin/behaviour",
      "/admin/tools",
      "/admin/tests",
    ]) {
      await openScreen(path, 320, ".shell-main h1");
      expect({ path, overflow: await horizontalOverflow() }).toEqual({ path, overflow: 0 });
    }

    await openScreen("/admin/behaviour", 320, ".shell-main h1");
    await cdp.evaluate<void>(`document.querySelector("button[aria-label='Menu']").click()`);
    await waitFor(`document.querySelector("#shell-drawer:not([hidden]) .status-badge")`, "drawer");
    expect(await horizontalOverflow()).toBe(0);
    const drawer = await cdp.evaluate<{ right: number; width: number }>(`(() => {
      const r = document.querySelector("#shell-drawer").getBoundingClientRect();
      return { right: r.right, width: r.width };
    })()`);
    expect(drawer.right).toBeLessThanOrEqual(320);
  }, 30_000);

  describe("Monitor screens", () => {
    const MONITOR = [
      { path: "/admin/overview", ready: ".chart-bar" },
      { path: "/admin/reports", ready: ".stat-card" },
      { path: "/admin/conversations", ready: ".conv-row" },
      { path: "/admin/conversations?id=cnv_1", ready: ".transcript .turn" },
      { path: "/admin/gaps", ready: ".gap-item" },
    ];

    it("has no horizontal scroll at 380px and 320px", async () => {
      for (const { path, ready } of MONITOR) {
        for (const width of [380, 320]) {
          await openScreen(path, width, ready);
          expect({ path, width, overflow: await horizontalOverflow() }).toEqual({
            path,
            width,
            overflow: 0,
          });
        }
      }
    }, 60_000);

    it("passes axe, colour contrast included, at 1280px and 380px", async () => {
      for (const { path, ready } of MONITOR) {
        for (const width of [1280, 380]) {
          await openScreen(path, width, ready);
          await cdp.evaluate<void>(axe.source);
          const violations = await cdp.evaluate<string[]>(`axe
            .run(document, { resultTypes: ["violations"] })
            .then((r) =>
              r.violations
                .filter((v) => v.impact === "serious" || v.impact === "critical")
                .map((v) => v.id + ": " + v.nodes.map((n) => n.target.join(" ")).join(", ")),
            )`);
          expect({ path, width, violations }).toEqual({ path, width, violations: [] });
        }
      }
    }, 60_000);

    it("puts the four figures in one row at 1280px and stacks them at 380px", async () => {
      const tops = () =>
        cdp.evaluate<number[]>(
          `Array.from(document.querySelectorAll(".overview-grid-4 > .stat-card")).map((c) => Math.round(c.getBoundingClientRect().top))`,
        );
      for (const path of ["/admin/overview", "/admin/reports"]) {
        await openScreen(path, 1280, ".stat-card");
        const wide = await tops();
        expect(wide).toHaveLength(4);
        expect(new Set(wide).size).toBe(1);

        await openScreen(path, 380, ".stat-card");
        expect(new Set(await tops()).size).toBe(4);
      }
    }, 30_000);

    it("keeps every conversation row and gap action a tap-sized target at 380px", async () => {
      await openScreen("/admin/conversations", 380, ".conv-row");
      const rowHeights = await cdp.evaluate<number[]>(
        `Array.from(document.querySelectorAll(".conv-row")).map((r) => r.getBoundingClientRect().height)`,
      );
      expect(rowHeights.length).toBe(3);
      for (const height of rowHeights) expect(height).toBeGreaterThanOrEqual(44);

      await openScreen("/admin/gaps", 380, ".gap-item");
      const overflowing =
        await cdp.evaluate<number>(`Array.from(document.querySelectorAll(".gap-item")).filter((item) => {
        const box = item.getBoundingClientRect();
        return Array.from(item.querySelectorAll("button")).some((b) => b.getBoundingClientRect().right > box.right + 0.5);
      }).length`);
      expect(overflowing).toBe(0);
    }, 30_000);
  });

  it("keeps the phone header to one short row so content starts near the top at 380px", async () => {
    await openScreen("/admin/overview", 380, ".shell-main h1");
    const metrics = await cdp.evaluate<{
      headerHeight: number;
      h1Top: number;
      navVisible: boolean;
      current: string;
    }>(`(() => {
      const header = document.querySelector("header.shell-header").getBoundingClientRect();
      const h1 = document.querySelector(".shell-main h1").getBoundingClientRect();
      const nav = document.querySelector("nav[aria-label='Primary']");
      return {
        headerHeight: header.height,
        h1Top: h1.top,
        navVisible: Boolean(nav && nav.getClientRects().length > 0),
        current: document.querySelector(".shell-current")?.textContent ?? "",
      };
    })()`);
    expect(metrics.headerHeight).toBeLessThanOrEqual(56);
    expect(metrics.h1Top).toBeLessThan(110);
    expect(metrics.navVisible).toBe(false);
    expect(metrics.current).toBe("Overview");
  }, 15_000);

  it("lays out sidebar, content and Try it at 1280px", async () => {
    const columns = () =>
      cdp.evaluate<{ nav: number; main: number; tryIt: number; viewport: number }>(`(() => {
        const width = (sel) => {
          const el = document.querySelector(sel);
          return el && el.getClientRects().length ? el.getBoundingClientRect().width : 0;
        };
        return {
          nav: width(".shell-sidebar"),
          main: width(".shell-main"),
          tryIt: width(".try-it"),
          // Less than 1280 when the page is tall enough for a vertical scrollbar.
          viewport: document.documentElement.clientWidth,
        };
      })()`);

    await openScreen("/admin/overview", 1280, ".shell-main h1");
    const overview = await columns();
    expect(overview.tryIt).toBe(0);
    expect(overview.nav).toBe(220);
    expect(overview.main).toBe(overview.viewport - 220);

    await openScreen("/admin/behaviour", 1280, ".try-it:not([hidden])");
    const behaviour = await columns();
    expect(behaviour.tryIt).toBe(360);
    expect(behaviour.main).toBe(1280 - 220 - 360);
    expect(await horizontalOverflow()).toBe(0);
  }, 15_000);

  it("passes axe, colour contrast included, on the shell at 1280px and 380px", async () => {
    const runAxe = async () => {
      await cdp.evaluate<void>(axe.source);
      return cdp.evaluate<string[]>(`axe
        .run(document, { resultTypes: ["violations"] })
        .then((r) =>
          r.violations
            .filter((v) => v.impact === "serious" || v.impact === "critical")
            .map((v) => v.id + ": " + v.nodes.map((n) => n.target.join(" ")).join(", ")),
        )`);
    };

    for (const width of [1280, 380]) {
      await openScreen("/admin/behaviour", width, ".shell-main h1");
      await waitFor(`document.querySelector(".status-badge") || ${width < 900}`, "status");
      expect({ width, violations: await runAxe() }).toEqual({ width, violations: [] });
    }

    await openScreen("/admin/behaviour", 380, ".shell-main h1");
    await cdp.evaluate<void>(`document.querySelector("button[aria-label='Menu']").click()`);
    await waitFor(`document.querySelector("#shell-drawer:not([hidden]) .status-badge")`, "drawer");
    expect({ drawer: await runAxe() }).toEqual({ drawer: [] });
  }, 30_000);

  it("turns off drawer, toast, skeleton and button motion when reduced motion is on", async () => {
    const motion = () =>
      cdp.evaluate<Record<string, string>>(`(() => {
        const probe = document.createElement("div");
        probe.innerHTML =
          '<div class="toast"></div><div class="skeleton"><span class="skeleton-line"></span></div>' +
          '<button class="btn btn-primary">x</button>';
        document.body.append(probe);
        const style = (sel) => getComputedStyle(probe.querySelector(sel));
        const result = {
          drawer: getComputedStyle(document.querySelector("#shell-drawer")).animationName,
          toast: style(".toast").animationName,
          skeleton: style(".skeleton-line").animationName,
          button: style(".btn").transitionProperty,
        };
        probe.remove();
        return result;
      })()`);
    const openDrawer = async () => {
      await openScreen("/admin/behaviour", 380, ".shell-main h1");
      await cdp.evaluate<void>(`document.querySelector("button[aria-label='Menu']").click()`);
      await waitFor(`document.querySelector("#shell-drawer:not([hidden])")`, "drawer");
    };

    try {
      // Without the preference the animations run, so the check below is meaningful.
      await cdp.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
      });
      await openDrawer();
      const normal = await motion();
      expect(normal.drawer).toBe("drawer-in");
      expect(normal.toast).toBe("toast-in");
      expect(normal.skeleton).toBe("skeleton-pulse");
      expect(normal.button).not.toBe("none");

      await cdp.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "reduce" }],
      });
      await openDrawer();
      expect(await motion()).toEqual({
        drawer: "none",
        toast: "none",
        skeleton: "none",
        button: "none",
      });
    } finally {
      await cdp.send("Emulation.setEmulatedMedia", { features: [] });
    }
  }, 30_000);

  it("closes the Try it sheet when Menu opens so the drawer links can be pressed", async () => {
    await openScreen("/admin/behaviour", 380, ".shell-main h1");
    await cdp.evaluate<void>(`document.querySelector(".try-it-toggle").click()`);
    await waitFor(`document.querySelector(".try-it-overlay:not([hidden])")`, "Try it sheet");
    await cdp.evaluate<void>(`document.querySelector("button[aria-label='Menu']").click()`);
    await waitFor(`document.querySelector("#shell-drawer:not([hidden])")`, "drawer");
    // Hit-test once the drawer has finished sliding in.
    await cdp.evaluate<void>(
      `Promise.all(document.getAnimations().map((a) => a.finished)).then(() => undefined)`,
    );
    const hits = await cdp.evaluate<{ label: string; hit: boolean }[]>(`(() =>
      Array.from(document.querySelectorAll("#shell-drawer a.nav-link")).map((link) => {
        const r = link.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { label: link.textContent.trim(), hit: Boolean(top && link.contains(top)) };
      }))()`);
    expect(hits.length).toBeGreaterThan(5);
    // Links scrolled below the drawer's fold are not hit-testable; the visible ones must be.
    const visible = hits.slice(0, 5);
    expect(visible).toEqual(visible.map(({ label }) => ({ label, hit: true })));
  }, 15_000);

  it("keeps the New assistant form and its text when the screen crosses 900px", async () => {
    const setWidth = async (width: number) => {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: width < 600,
      });
      await cdp.evaluate<void>(
        "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))",
      );
    };
    await openScreen("/admin/behaviour", 1280, ".shell-main h1");
    await waitFor(`document.querySelector(".switcher-button[data-value]")`, "switcher");
    // Wide: switcher sits in the header row, to the right of the brand.
    const wide = await cdp.evaluate<{ inRow: boolean; signOutInRow: boolean }>(`(() => {
      const header = document.querySelector("header.shell-header").getBoundingClientRect();
      const within = (el) => {
        const r = el.getBoundingClientRect();
        return r.height > 0 && r.top >= header.top && r.bottom <= header.bottom;
      };
      const signOut = Array.from(document.querySelectorAll("header button")).find(
        (b) => b.textContent.trim() === "Sign out",
      );
      return {
        inRow: within(document.querySelector(".switcher-button")),
        signOutInRow: within(signOut),
      };
    })()`);
    expect(wide).toEqual({ inRow: true, signOutInRow: true });

    await cdp.evaluate<void>(`document.querySelector(".switcher-button").click()`);
    await waitFor(`document.querySelector(".switcher-new")`, "New assistant option");
    await cdp.evaluate<void>(`document.querySelector(".switcher-new").click()`);
    await waitFor(`document.querySelector(".switcher-form input")`, "New assistant form");
    await cdp.evaluate<void>(`(() => {
      const input = document.querySelector(".switcher-form input");
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      set.call(input, "Half typed");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      window.__nameInput = input;
    })()`);

    await setWidth(380);
    await waitFor(`document.querySelector(".shell-narrow")`, "narrow layout");
    await cdp.evaluate<void>(`document.querySelector("button[aria-label='Menu']").click()`);
    await waitFor(`document.querySelector("#shell-drawer:not([hidden])")`, "drawer");
    const narrow = await cdp.evaluate<{ same: boolean; value: string; inDrawer: boolean }>(`(() => {
      const input = document.querySelector(".switcher-form input");
      return {
        same: input === window.__nameInput,
        value: input?.value ?? "",
        inDrawer: Boolean(input?.closest("#shell-drawer[role='dialog']")),
      };
    })()`);
    expect(narrow).toEqual({ same: true, value: "Half typed", inDrawer: true });

    await setWidth(1280);
    await waitFor(`!document.querySelector(".shell-narrow")`, "wide layout");
    const back = await cdp.evaluate<{ same: boolean; value: string }>(`(() => {
      const input = document.querySelector(".switcher-form input");
      return { same: input === window.__nameInput, value: input?.value ?? "" };
    })()`);
    expect(back).toEqual({ same: true, value: "Half typed" });
  }, 20_000);
});
