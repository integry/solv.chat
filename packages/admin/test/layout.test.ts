// @vitest-environment node

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADMIN_CSP,
  ADMIN_PREVIEW_CSP,
  defaultVersionConfig,
  TOPIC_NAME_MAX_LENGTH,
  type TopicItem,
} from "@solvchat/core";
import axe from "axe-core";
import { build, createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  AnswerTest,
  Assistant,
  AssistantReport,
  InstallInfo,
  McpServerSummary,
  ProviderSettingsView,
  SourceSummary,
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
    { question: "Do you ship to Spain?", count: 2 },
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
    {
      documentId: "doc_answer",
      kind: "answer",
      url: "https://engine.example/admin/sources#entry:refunds",
      title: "How long do refunds take to reach my card after I cancel an annual plan?",
      count: 6,
    },
  ],
  uncitedSources: [],
  uncitedTotal: 0,
};

/** A topic name at the 40-character maximum, for the Conversations topic filter. */
const LONG_TOPIC: TopicItem = {
  id: "top_long",
  name: "Wholesale bread orders for cafés, hotels",
  createdAt: 1_700_000_000_000,
};
const TOPICS: TopicItem[] = [
  { id: "top_1", name: "Opening hours", createdAt: 1_700_000_000_000 },
  LONG_TOPIC,
];

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

const SOURCES: SourceSummary[] = [
  {
    id: "src_push",
    orgId: ASSISTANT.orgId,
    assistantId: ASSISTANT.id,
    kind: "push",
    label: "Push",
    settings: {},
    createdAt: 1_700_000_000_000,
    documentCount: 128,
    lastUpdatedAt: 1_700_000_100_000,
    indexingCount: 0,
    failedCount: 0,
    indexError: null,
  },
  {
    id: "src_entry",
    orgId: ASSISTANT.orgId,
    assistantId: ASSISTANT.id,
    kind: "entry",
    label: "Answers you wrote",
    settings: {},
    createdAt: 1_700_000_000_000,
    documentCount: 6,
    lastUpdatedAt: 1_700_000_100_000,
    indexingCount: 0,
    failedCount: 0,
    indexError: null,
  },
  {
    id: "src_map",
    orgId: ASSISTANT.orgId,
    assistantId: ASSISTANT.id,
    kind: "sitemap",
    label: "a-rather-long-blog-hostname-for-wrapping.example.com",
    settings: { url: "https://blog.example.com/sitemap.xml" },
    createdAt: 1_700_000_000_000,
    documentCount: 24,
    lastUpdatedAt: 1_700_000_100_000,
    indexingCount: 0,
    failedCount: 2,
    indexError: "too_long",
  },
];

const INSTALL: InstallInfo = {
  assistantId: ASSISTANT.id,
  publicKey: ASSISTANT.publicKey,
  allowedOrigins: ASSISTANT.allowedOrigins,
  snippet: `<script src="https://chat.example.com/widget.js" defer></script>\n<solv-chat assistant="${ASSISTANT.publicKey}"></solv-chat>`,
  lastSeen: { pageUrl: "https://docs.example.com/a/very/long/path/to/getting-started", at: 1 },
};

const PROVIDERS: ProviderSettingsView = {
  settings: {
    llmProvider: { value: "anthropic", source: "none" },
    llmTier: { value: "fast", source: "environment" },
    llmModel: { value: null, source: "none" },
    embeddingsProvider: { value: "openai", source: "stored" },
  },
  keysManaged: false,
  ownKeysAllowed: true,
  keys: {
    anthropic: { source: "stored", updatedAt: 1_700_000_000_000, unreadable: false },
    openai: { source: "environment", updatedAt: null, unreadable: false },
    openrouter: { source: "none", updatedAt: null, unreadable: false },
  },
  configError: null,
};

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

interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string | undefined;
}

class CdpClient {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();

  private listeners = new Set<(event: CdpEvent) => void>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        sessionId?: string;
        result?: unknown;
        error?: { message?: string };
      };
      if (msg.id === undefined) {
        if (msg.method) {
          const cdpEvent: CdpEvent = {
            method: msg.method,
            params: msg.params ?? {},
            sessionId: msg.sessionId,
          };
          for (const listener of this.listeners) listener(cdpEvent);
        }
        return;
      }
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

  /** Events from the page and from any attached session (flattened). */
  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolveMsg, rejectMsg) => {
      this.pending.set(id, {
        resolve: resolveMsg as (value: unknown) => void,
        reject: rejectMsg,
      });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  async evaluate<T>(
    expression: string,
    target: { sessionId?: string; contextId?: number } = {},
  ): Promise<T> {
    const res = await this.send<{
      result?: { value?: T };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
        ...(target.contextId === undefined ? {} : { contextId: target.contextId }),
      },
      target.sessionId,
    );
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

/** The admin API the screens read, answered from the fixtures above. `url` is relative to /api/admin. */
function answerAdminApi(req: IncomingMessage, res: ServerResponse): void {
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
  if (pathname === `/assistants/${ASSISTANT.id}`) {
    res.end(JSON.stringify({ assistant: ASSISTANT }));
    return;
  }
  if (pathname === `/assistants/${ASSISTANT.id}/sources`) {
    res.end(JSON.stringify({ sources: SOURCES }));
    return;
  }
  if (pathname === `/assistants/${ASSISTANT.id}/install`) {
    res.end(JSON.stringify(INSTALL));
    return;
  }
  if (pathname === "/providers") {
    res.end(JSON.stringify(PROVIDERS));
    return;
  }
  if (pathname === `/assistants/${ASSISTANT.id}/test-runs`) {
    res.end(JSON.stringify({ runs: [] }));
    return;
  }
  if (pathname === `/assistants/${ASSISTANT.id}/tests`) {
    res.end(JSON.stringify({ tests: TESTS }));
    return;
  }
  if (pathname === `/assistants/${ASSISTANT.id}/versions`) {
    res.end(
      JSON.stringify({
        versions: [versionRow("draft", DRAFT_CONFIG), versionRow("published", PUBLISHED_CONFIG)],
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
  if (pathname === `/assistants/${ASSISTANT.id}/topics`) {
    res.end(JSON.stringify({ topics: TOPICS, reviewAnswers: true }));
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
  if (pathname === "/conversations/cnv_quiet") {
    // Replies written with "Show sources in answers" off.
    const detail = monitorConversationDetail(Date.now());
    res.end(
      JSON.stringify({
        ...detail,
        conversation: { ...detail.conversation, id: "cnv_quiet" },
        turns: detail.turns.map((turn) =>
          turn.role === "assistant" ? { ...turn, citationsShown: false } : turn,
        ),
      }),
    );
    return;
  }
  if (pathname === `/assistants/${ASSISTANT.id}/gaps`) {
    const gaps = monitorGaps(Date.now());
    res.end(JSON.stringify({ gaps, total: gaps.length, limit: 25, offset: 0 }));
    return;
  }
  res.end(JSON.stringify({}));
}

const WORKSPACE_ROOT = resolve(ADMIN_ROOT, "../..");
const WIDGET_BUNDLE = resolve(WORKSPACE_ROOT, "packages/widget/dist/widget.js");

/**
 * A plain page with the real widget, for answers from an assistant with
 * "Show sources in answers" off: the stream carries tokens and no citation.
 * `?sources=on` adds one, for comparison.
 */
function answerWidgetPage(req: IncomingMessage, res: ServerResponse, next: () => void): void {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname === "/widget-check.html") {
    res.setHeader("content-type", CONTENT_TYPES[".html"] ?? "text/html");
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Widget check</title></head>
<body><solv-chat assistant="pk_ast_1" endpoint="http://${req.headers.host}"></solv-chat>
<script src="/widget.js"></script></body></html>`);
    return;
  }
  if (url.pathname === "/widget.js") {
    res.setHeader("content-type", CONTENT_TYPES[".js"] ?? "application/javascript");
    res.end(readFileSync(WIDGET_BUNDLE));
    return;
  }
  if (url.pathname === "/v1/assistants/pk_ast_1") {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({ title: "Ask a question", greeting: "Hello.", suggestedQuestions: [] }),
    );
    return;
  }
  if (url.pathname === "/v1/chat" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      const message = (JSON.parse(body || "{}") as { message?: string }).message ?? "";
      res.setHeader("content-type", "text/event-stream");
      const events = [
        `event: token\ndata: ${JSON.stringify({ text: "Click Forgot Password on the sign-in page, then follow the link in the email we send you." })}\n\n`,
        ...(message.includes("sources on")
          ? [
              `event: citation\ndata: ${JSON.stringify({ url: "https://docs.example.com/reset", title: "Reset your password" })}\n\n`,
            ]
          : []),
        `event: done\ndata: ${JSON.stringify({ messageId: `msg_${Date.now()}`, conversationId: "cnv_w" })}\n\n`,
      ];
      res.end(events.join(""));
    });
    return;
  }
  next();
}
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

/**
 * Serves a production build of the admin the way the engine Worker does
 * (`packages/engine/src/admin/assets.ts`): the shell with the admin policy,
 * the preview page with its own, plus `/widget.js` and the fake API. The Vite
 * dev server cannot stand in here: its inline React preamble breaks under
 * the policy, and it sends none.
 */
function serveBuiltAdmin(distDir: string): Server {
  const indexHtml = readFileSync(resolve(distDir, "index.html"));
  return createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/api/admin/")) {
      req.url = url.pathname.slice("/api/admin".length) + url.search;
      answerAdminApi(req, res);
      return;
    }
    if (url.pathname === "/widget.js") {
      res.writeHead(200, { "content-type": CONTENT_TYPES[".js"] });
      res.end(readFileSync(WIDGET_BUNDLE));
      return;
    }
    if (url.pathname.startsWith("/admin/")) {
      const file = resolve(distDir, url.pathname.slice("/admin/".length));
      if (file.startsWith(distDir + sep) && existsSync(file) && statSync(file).isFile()) {
        const headers: Record<string, string> = {
          "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
        };
        if (url.pathname === "/admin/preview.html") {
          headers["content-security-policy"] = `${ADMIN_PREVIEW_CSP}; frame-ancestors 'self'`;
        }
        res.writeHead(200, headers);
        res.end(readFileSync(file));
        return;
      }
    }
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      res.writeHead(200, {
        "content-type": CONTENT_TYPES[".html"],
        "x-frame-options": "DENY",
        "content-security-policy": ADMIN_CSP,
      });
      res.end(indexHtml);
      return;
    }
    res.writeHead(404).end();
  });
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
            server.middlewares.use("/api/admin", answerAdminApi);
            server.middlewares.use(answerWidgetPage);
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
      // A helper can still be flushing its cache as it exits: retry for a few
      // seconds, then leave the folder to the OS rather than fail the run.
      for (let attempt = 0; ; attempt++) {
        try {
          rmSync(userDataDir, { recursive: true, force: true });
          break;
        } catch (err) {
          if (attempt >= 20) {
            console.warn(`Could not remove ${userDataDir}:`, err);
            break;
          }
          await new Promise((r) => setTimeout(r, 250));
        }
      }
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
        return Array.from(document.querySelectorAll(".row-item")).map((item) => {
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
      await openScreen("/admin/reports", width, ".row-item > .badge");
      const pills = await measurePills();
      expect(pills.length).toBeGreaterThanOrEqual(3);
      for (const pill of pills) {
        expect(pill.lineRects).toBe(1);
        expect(pill.badgeRight).toBeLessThanOrEqual(pill.itemRight + 1);
        expect(pill.firstScrollWidth).toBeLessThanOrEqual(pill.firstClientWidth + 1);
      }
    }
  }, 15_000);

  it("keeps each Reports and Overview count badge at its natural width, beside the question at 1280px, at 1280px and 390px", async () => {
    interface BadgeMetrics {
      text: string;
      rowWidth: number;
      badgeWidth: number;
      contentWidth: number;
      badgeLeft: number;
      badgeMiddle: number;
      firstRight: number;
      firstTop: number;
      firstBottom: number;
    }

    // Every list row that ends in a count badge. The badge's content width is
    // its text plus its own padding and border, which is what it measures when
    // nothing stretches it.
    const measureBadges = () =>
      cdp.evaluate<BadgeMetrics[]>(`(() => {
        return Array.from(document.querySelectorAll(".row-item"))
          .filter((row) => row.querySelector(":scope > .badge"))
          .map((row) => {
            const badge = row.querySelector(":scope > .badge");
            const first = row.firstElementChild;
            const range = document.createRange();
            range.selectNodeContents(badge);
            const style = getComputedStyle(badge);
            const extra = ["paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth"]
              .reduce((sum, key) => sum + parseFloat(style[key]), 0);
            const badgeRect = badge.getBoundingClientRect();
            const firstRect = first.getBoundingClientRect();
            return {
              text: badge.textContent,
              rowWidth: row.getBoundingClientRect().width,
              badgeWidth: badgeRect.width,
              contentWidth: range.getBoundingClientRect().width + extra,
              badgeLeft: badgeRect.left,
              badgeMiddle: (badgeRect.top + badgeRect.bottom) / 2,
              firstRight: firstRect.right,
              firstTop: firstRect.top,
              firstBottom: firstRect.bottom,
            };
          });
      })()`);

    for (const path of ["/admin/reports", "/admin/overview"]) {
      for (const width of [1280, 390]) {
        await openScreen(path, width, ".row-item > .badge");
        const badges = await measureBadges();
        expect(badges.length, `${path} at ${width}px`).toBeGreaterThanOrEqual(2);
        for (const badge of badges) {
          const where = `${badge.text} on ${path} at ${width}px`;
          expect(Math.abs(badge.badgeWidth - badge.contentWidth), where).toBeLessThanOrEqual(2);
          expect(badge.badgeWidth, where).toBeLessThan(badge.rowWidth / 2);
          if (width === 1280) {
            expect(badge.badgeLeft, where).toBeGreaterThanOrEqual(badge.firstRight - 1);
            expect(badge.badgeMiddle, where).toBeGreaterThanOrEqual(badge.firstTop);
            expect(badge.badgeMiddle, where).toBeLessThanOrEqual(badge.firstBottom);
          }
        }
      }
    }
  }, 20_000);

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

  it("keeps each Tests result badge level with its row's buttons, Edit and Delete on one line, at 1440px and 390px", async () => {
    interface RowMetrics {
      badgeHeight: number;
      buttonHeight: number;
      badgeTop: number;
      badgeBottom: number;
      editTop: number;
      editBottom: number;
      deleteTop: number;
      rowRight: number;
      deleteRight: number;
    }

    const measureRows = () =>
      cdp.evaluate<RowMetrics[]>(`(() => {
        return Array.from(document.querySelectorAll(".tests-table tbody tr")).map((row) => {
          const badge = row.querySelector(".status-badge").getBoundingClientRect();
          const [edit, del] = Array.from(row.querySelectorAll(".actions button")).map((b) =>
            b.getBoundingClientRect(),
          );
          const tr = row.getBoundingClientRect();
          return {
            badgeHeight: badge.height,
            buttonHeight: edit.height,
            badgeTop: badge.top,
            badgeBottom: badge.bottom,
            editTop: edit.top,
            editBottom: edit.bottom,
            deleteTop: del.top,
            rowRight: tr.right,
            deleteRight: del.right,
          };
        });
      })()`);

    for (const width of [1440, 390]) {
      await openScreen("/admin/tests", width, ".tests-table tbody tr .status-badge");
      const rows = await measureRows();
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.badgeHeight).toBeLessThan(row.buttonHeight - 2);
        // Edit and Delete share one line and stay inside the row.
        expect(Math.abs(row.editTop - row.deleteTop)).toBeLessThanOrEqual(1);
        expect(row.deleteRight).toBeLessThanOrEqual(row.rowRight + 0.5);
        if (width >= 600) {
          // On a wide screen the badge sits on the same line as the buttons.
          expect(row.badgeTop).toBeLessThan(row.editBottom);
          expect(row.badgeBottom).toBeGreaterThan(row.editTop);
        }
      }
      expect(await horizontalOverflow()).toBe(0);
    }
  }, 20_000);

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

    it("shrinks the topic filter to the row and truncates a 40-character topic at 380px and 320px", async () => {
      expect(LONG_TOPIC.name).toHaveLength(TOPIC_NAME_MAX_LENGTH);
      for (const width of [380, 320]) {
        await openScreen("/admin/conversations", width, ".list-topic select");
        // The long topic chosen, so it is the name the select shows.
        await cdp.evaluate<void>(`(() => {
          const select = document.querySelector(".list-topic select");
          select.value = ${JSON.stringify(LONG_TOPIC.id)};
          select.dispatchEvent(new Event("change", { bubbles: true }));
        })()`);
        await waitFor(
          `document.querySelector(".list-topic select").value === ${JSON.stringify(LONG_TOPIC.id)} && document.querySelector(".conv-row")`,
          "topic chosen",
        );
        const metrics = await cdp.evaluate<{
          overflow: number;
          selectRight: number;
          toolbarRight: number;
          clientWidth: number;
          textOverflow: string;
          shown: string;
        }>(`(() => {
          const select = document.querySelector(".list-topic select");
          const toolbar = document.querySelector(".list-toolbar");
          return {
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            selectRight: select.getBoundingClientRect().right,
            toolbarRight: toolbar.getBoundingClientRect().right,
            clientWidth: document.documentElement.clientWidth,
            textOverflow: getComputedStyle(select).textOverflow,
            shown: select.selectedOptions[0].textContent,
          };
        })()`);
        expect({ width, overflow: metrics.overflow }).toEqual({ width, overflow: 0 });
        expect(metrics.shown).toBe(LONG_TOPIC.name);
        expect(metrics.selectRight).toBeLessThanOrEqual(metrics.toolbarRight + 0.5);
        expect(metrics.selectRight).toBeLessThanOrEqual(metrics.clientWidth);
        expect(metrics.textOverflow).toBe("ellipsis");
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

  it("shows the Build, Go live and Settings screens without sideways scroll and passes axe, contrast included, at 1280px and 380px", async () => {
    await cdp.evaluate<void>(axe.source);
    const screens: Array<[string, string]> = [
      ["/admin/sources", ".sources-table"],
      ["/admin/behaviour", "#behaviour-greeting"],
      ["/admin/widget", ".widget-preview-frame"],
      ["/admin/tools", "ul.source-list"],
      ["/admin/tests", ".tests-table"],
      ["/admin/install", ".install-steps"],
      ["/admin/providers", "#llm-provider"],
    ];
    for (const width of [1280, 380]) {
      for (const [path, ready] of screens) {
        await openScreen(path, width, ready);
        expect({ path, width, overflow: await horizontalOverflow() }).toEqual({
          path,
          width,
          overflow: 0,
        });
        await cdp.evaluate<void>(axe.source);
        const violations = await cdp.evaluate<string[]>(`axe
          .run(document.querySelector(".shell-main"), { resultTypes: ["violations"] })
          .then((r) =>
            r.violations
              .filter((v) => v.impact === "serious" || v.impact === "critical")
              .map((v) => v.id + ": " + v.nodes.map((n) => n.target.join(" ")).join(", ")),
          )`);
        expect({ path, width, violations }).toEqual({ path, width, violations: [] });
      }
    }
  }, 90_000);

  it("keeps the Show sources in answers choices and List sources inside the form, at 1280px and 380px", async () => {
    for (const width of [1280, 380]) {
      await openScreen("/admin/behaviour", width, "#behaviour-list-sources");
      const box = await cdp.evaluate<{
        heading: string;
        legend: string;
        cards: {
          title: string;
          checked: boolean;
          radioTop: number;
          radioBottom: number;
          titleTop: number;
          titleBottom: number;
          right: number;
        }[];
        listTop: number;
        listBottom: number;
        listTextTop: number;
        listTextBottom: number;
        listRight: number;
        mainRight: number;
      }>(`(() => {
        const fieldset = document.querySelector(".sources-choices");
        fieldset.scrollIntoView({ block: "center" });
        const cards = [...fieldset.querySelectorAll("label.choice-card")].map((card) => {
          const radio = card.querySelector('input[type="radio"]').getBoundingClientRect();
          const title = card.querySelector(".choice-card-title");
          const titleBox = title.getBoundingClientRect();
          return {
            title: title.textContent,
            checked: card.querySelector("input").checked,
            radioTop: radio.top, radioBottom: radio.bottom,
            titleTop: titleBox.top, titleBottom: titleBox.bottom,
            right: card.getBoundingClientRect().right,
          };
        });
        const list = document.getElementById("behaviour-list-sources");
        const listLabel = list.closest("label");
        const listText = listLabel.querySelector("span").getBoundingClientRect();
        const check = list.getBoundingClientRect();
        return {
          heading: document.getElementById("behaviour-sources-group-heading").textContent,
          legend: fieldset.querySelector("legend").textContent,
          cards,
          listTop: check.top, listBottom: check.bottom,
          listTextTop: listText.top, listTextBottom: listText.bottom,
          listRight: listLabel.getBoundingClientRect().right,
          mainRight: document.querySelector(".shell-main").getBoundingClientRect().right,
        };
      })()`);
      expect(box.heading).toBe("Sources");
      expect(box.legend).toBe("Show sources in answers");
      expect(box.cards.map((c) => c.title)).toEqual([
        "Link in the text",
        "Numbered, with a list",
        "None",
      ]);
      expect(box.cards.map((c) => c.checked)).toEqual([true, false, false]);
      for (const card of box.cards) {
        // Each radio sits beside its title, and the card fits inside the form.
        expect(card.radioBottom, `${card.title} at ${width}px`).toBeGreaterThan(card.titleTop);
        expect(card.radioTop, `${card.title} at ${width}px`).toBeLessThan(card.titleBottom);
        expect(card.right, `${card.title} at ${width}px`).toBeLessThanOrEqual(box.mainRight);
      }
      // The List sources box sits beside its words, and the words fit on one line.
      expect(box.listBottom).toBeGreaterThan(box.listTextTop);
      expect(box.listTop).toBeLessThan(box.listTextBottom);
      expect(box.listTextBottom - box.listTextTop).toBeLessThan(30);
      expect(box.listRight).toBeLessThanOrEqual(box.mainRight);
      expect(await horizontalOverflow()).toBe(0);
    }
  }, 30_000);

  it("labels a reply's pages Used content when the visitor saw no sources, at 1280px and 380px", async () => {
    for (const width of [1280, 380]) {
      await openScreen("/admin/conversations?id=cnv_quiet", width, ".transcript .turn-sources");
      const labels = await cdp.evaluate<string[]>(
        `[...document.querySelectorAll(".turn-sources-label")].map((el) => el.textContent)`,
      );
      expect(labels.length).toBeGreaterThan(0);
      expect(new Set(labels)).toEqual(new Set(["Used content"]));
      expect(await horizontalOverflow()).toBe(0);
      await cdp.evaluate<void>(axe.source);
      const violations = await cdp.evaluate<string[]>(`axe
        .run(document.querySelector(".transcript"), { resultTypes: ["violations"] })
        .then((r) =>
          r.violations
            .filter((v) => v.impact === "serious" || v.impact === "critical")
            .map((v) => v.id + ": " + v.nodes.map((n) => n.target.join(" ")).join(", ")),
        )`);
      expect({ width, violations }).toEqual({ width, violations: [] });
    }
  }, 30_000);

  describe("Widget answers with sources off", () => {
    beforeAll(() => {
      if (!existsSync(WIDGET_BUNDLE)) {
        execFileSync("npm", ["run", "build", "-w", "@solvchat/widget"], {
          cwd: WORKSPACE_ROOT,
          stdio: "pipe",
        });
      }
    }, 120_000);

    interface Answer {
      citations: number;
      text: string;
      /** Space between the bubble's last content and its bottom edge, less its padding. */
      extraBottom: number;
      bubbleRight: number;
      viewport: number;
    }

    async function ask(width: number, question: string): Promise<Answer> {
      await openScreen("/widget-check.html", width, "solv-chat");
      const opened = await cdp.evaluate<boolean>(`(async () => {
        for (let i = 0; i < 100; i++) {
          const root = document.querySelector("solv-chat")?.shadowRoot;
          const launcher = root?.querySelector(".solv-launcher");
          if (launcher) {
            launcher.click();
            const input = root.querySelector("#solv-input");
            input.value = ${JSON.stringify(question)};
            root.querySelector(".solv-form").requestSubmit();
            return true;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        return false;
      })()`);
      expect(opened).toBe(true);
      return cdp.evaluate<Answer>(`(async () => {
        const root = document.querySelector("solv-chat").shadowRoot;
        for (let i = 0; i < 100; i++) {
          const bubbles = root.querySelectorAll(".solv-bubble--assistant");
          const bubble = bubbles[bubbles.length - 1];
          const text = bubble?.querySelector(".solv-bubble-text");
          if (text && text.textContent.includes("Click Forgot Password")) {
            await new Promise((r) => setTimeout(r, 100));
            const box = bubble.getBoundingClientRect();
            const style = getComputedStyle(bubble);
            const last = Math.max(
              ...[...bubble.children]
                .map((el) => el.getBoundingClientRect())
                .filter((r) => r.height > 0)
                .map((r) => r.bottom),
            );
            return {
              citations: root.querySelectorAll(".solv-citations").length,
              text: text.textContent,
              extraBottom:
                box.bottom - parseFloat(style.borderBottomWidth) - parseFloat(style.paddingBottom) - last,
              bubbleRight: box.right,
              viewport: document.documentElement.clientWidth,
            };
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error("no answer: " + root.textContent.slice(0, 200));
      })()`);
    }

    it("shows no sources block and no leftover space under the answer at 1280px and 380px", async () => {
      for (const width of [1280, 380]) {
        await cdp.evaluate<void>("sessionStorage.clear(); localStorage.clear()").catch(() => {});
        const off = await ask(width, "How do I reset my password?");
        expect(off.citations).toBe(0);
        expect(off.text).toBe(
          "Click Forgot Password on the sign-in page, then follow the link in the email we send you.",
        );
        expect(Math.abs(off.extraBottom)).toBeLessThanOrEqual(1);
        expect(off.bubbleRight).toBeLessThanOrEqual(off.viewport);
        expect(await horizontalOverflow()).toBe(0);

        // The same answer with a source has its list where the space would be.
        await cdp.evaluate<void>("sessionStorage.clear(); localStorage.clear()");
        const on = await ask(width, "How do I reset my password, sources on?");
        expect(on.citations).toBe(1);
        await cdp.evaluate<void>("sessionStorage.clear(); localStorage.clear()");
      }
    }, 60_000);
  });

  it("puts the widget preview beside the form when there is room, and under it at 380px", async () => {
    const layout = () =>
      cdp.evaluate<{
        formRight: number;
        previewLeft: number;
        formBottom: number;
        previewTop: number;
      }>(`(() => {
        const form = document.querySelector(".widget-layout > form").getBoundingClientRect();
        const preview = document.querySelector(".widget-preview-column").getBoundingClientRect();
        return { formRight: form.right, previewLeft: preview.left, formBottom: form.bottom, previewTop: preview.top };
      })()`);
    await openScreen("/admin/widget", 1280, ".widget-preview-frame");
    const wide = await layout();
    expect(wide.previewLeft).toBeGreaterThanOrEqual(wide.formRight);
    await openScreen("/admin/widget", 380, ".widget-preview-frame");
    const narrow = await layout();
    expect(narrow.previewTop).toBeGreaterThanOrEqual(narrow.formBottom);
  }, 20_000);

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

    await openScreen("/admin/behaviour", 1280, "#behaviour-greeting");
    await waitFor(`document.querySelector(".try-it:not([hidden])")`, "Try it");
    // Measured together: a screen taller than the window gets the page's
    // scrollbar, which comes out of the main column.
    const behaviour = await cdp.evaluate<{ main: number; tryIt: number; scrollbar: number }>(`({
      main: document.querySelector(".shell-main").getBoundingClientRect().width,
      tryIt: document.querySelector(".try-it").getBoundingClientRect().width,
      scrollbar: window.innerWidth - document.documentElement.clientWidth,
    })`);
    expect(behaviour.tryIt).toBe(360);
    expect(behaviour.main + behaviour.scrollbar).toBe(1280 - 220 - 360);
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

  describe("Widget preview under the admin's real policy", () => {
    let builtDir: string;
    let builtServer: Server;
    let builtUrl: string;

    beforeAll(async () => {
      if (!existsSync(WIDGET_BUNDLE)) {
        execFileSync("npm", ["run", "build", "-w", "@solvchat/widget"], {
          cwd: WORKSPACE_ROOT,
          stdio: "pipe",
        });
      }
      builtDir = mkdtempSync(resolve(tmpdir(), "solvchat-admin-built-"));
      await build({
        root: ADMIN_ROOT,
        logLevel: "silent",
        build: { outDir: builtDir, emptyOutDir: true },
      });
      builtServer = serveBuiltAdmin(builtDir);
      await new Promise<void>((r) => builtServer.listen(0, "127.0.0.1", r));
      const addr = builtServer.address();
      if (!addr || typeof addr === "string") throw new Error("no built admin server port");
      builtUrl = `http://127.0.0.1:${addr.port}`;
    }, 120_000);

    afterAll(async () => {
      builtServer?.closeAllConnections();
      await new Promise((r) => builtServer?.close(r));
      if (builtDir) rmSync(builtDir, { recursive: true, force: true });
    });

    it("shows title and accent edits inside the preview frame with no policy violation", async () => {
      const violations: string[] = [];
      // The sandboxed frame may run in its own process; then it is a
      // separate target and is evaluated through its session.
      let frameSession: string | undefined;
      const RECORDER = `addEventListener("securitypolicyviolation", (e) =>
        globalThis.__reportCsp(location.href + " " + e.violatedDirective + " " + e.blockedURI), true);`;
      const watch = async (sessionId?: string) => {
        await cdp.send("Log.enable", {}, sessionId);
        await cdp.send("Runtime.enable", {}, sessionId);
        await cdp.send("Runtime.addBinding", { name: "__reportCsp" }, sessionId);
        return cdp.send<{ identifier: string }>(
          "Page.addScriptToEvaluateOnNewDocument",
          { source: RECORDER },
          sessionId,
        );
      };
      const off = cdp.onEvent((event) => {
        if (event.method === "Log.entryAdded") {
          const text = (event.params.entry as { text?: string }).text ?? "";
          if (/Content Security Policy|Refused to/i.test(text)) violations.push(text);
        } else if (event.method === "Runtime.bindingCalled") {
          if (event.params.name === "__reportCsp") violations.push(String(event.params.payload));
        } else if (event.method === "Target.attachedToTarget") {
          const sessionId = event.params.sessionId as string;
          const info = event.params.targetInfo as { type: string };
          if (info.type === "iframe") frameSession = sessionId;
          void watch(sessionId)
            .catch(() => {})
            .finally(() => cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId));
        }
      });
      const { identifier } = await watch();
      await cdp.send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      });

      const frameTarget = async (): Promise<{ sessionId?: string; contextId?: number } | null> => {
        if (frameSession) return { sessionId: frameSession };
        const { frameTree } = await cdp.send<{
          frameTree: { childFrames?: Array<{ frame: { id: string; url: string } }> };
        }>("Page.getFrameTree");
        const child = frameTree.childFrames?.find((f) =>
          f.frame.url.endsWith("/admin/preview.html"),
        );
        if (!child) return null;
        const { executionContextId } = await cdp.send<{ executionContextId: number }>(
          "Page.createIsolatedWorld",
          { frameId: child.frame.id, worldName: "preview-check" },
        );
        return { contextId: executionContextId };
      };
      interface Shown {
        title: string | null;
        accent: string | null;
        background: string;
      }
      const shown = async (): Promise<Shown | null> => {
        const target = await frameTarget();
        if (!target) return null;
        return cdp
          .evaluate<Shown>(
            `(() => {
              const el = document.querySelector("solv-chat");
              return {
                title: el?.shadowRoot?.querySelector(".solv-title")?.textContent ?? null,
                accent: el?.style.getPropertyValue("--solv-accent") || null,
                background: getComputedStyle(document.body).backgroundColor,
              };
            })()`,
            target,
          )
          .catch(() => null);
      };
      const waitForShown = async (want: Partial<Shown>) => {
        let last: Shown | null = null;
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          last = await shown();
          if (last && Object.entries(want).every(([k, v]) => last?.[k as keyof Shown] === v)) {
            return last;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error(
          `Preview never showed ${JSON.stringify(want)}; last ${JSON.stringify(last)}; ` +
            `violations ${JSON.stringify(violations)}`,
        );
      };
      const typeInto = async (id: string, text: string) => {
        await cdp.evaluate<void>(`(() => {
          const el = document.getElementById(${JSON.stringify(id)});
          el.focus();
          el.select();
        })()`);
        await cdp.send("Input.insertText", { text });
      };

      try {
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          width: 1280,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await cdp.send("Page.navigate", { url: `${builtUrl}/admin/widget` });
        // The saved settings reach the frame, and its stylesheet applies.
        await waitForShown({
          title: "Ask a question",
          accent: "#2563eb",
          background: "rgb(226, 232, 240)",
        });

        await typeInto("widget-title", "Help desk");
        await typeInto("widget-accent", "#0f766e");
        await waitForShown({ title: "Help desk", accent: "#0f766e" });
        expect(violations).toEqual([]);
      } finally {
        off();
        await cdp.send("Target.setAutoAttach", {
          autoAttach: false,
          waitForDebuggerOnStart: false,
          flatten: true,
        });
        await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
        await cdp.send("Runtime.removeBinding", { name: "__reportCsp" });
        await cdp.send("Log.disable");
      }
    }, 30_000);
  });
});
