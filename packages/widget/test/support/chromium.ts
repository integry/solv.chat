import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

/** A headless Chromium driven over the DevTools protocol, with no dependency. */

export function findChrome(): string | null {
  for (const candidate of [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

export class Cdp {
  #ws: WebSocket;
  #nextId = 1;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: { message?: string };
      };
      if (msg.id === undefined) return;
      const entry = this.#pending.get(msg.id);
      if (!entry) return;
      this.#pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message ?? "CDP error"));
      else entry.resolve(msg.result);
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((ok, fail) => {
      ws.addEventListener("open", () => ok(), { once: true });
      ws.addEventListener("error", () => fail(new Error("CDP connection failed")), { once: true });
    });
    return new Cdp(ws);
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.#nextId++;
    return new Promise<T>((ok, fail) => {
      this.#pending.set(id, { resolve: ok as (v: unknown) => void, reject: fail });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const res = await this.send<{
      result?: { value?: T };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description ??
          res.exceptionDetails.text ??
          "evaluate failed",
      );
    }
    return res.result?.value as T;
  }

  close(): void {
    this.#ws.close();
  }
}

export interface Browser {
  cdp: Cdp;
  close(): void;
}

export async function launch(chromePath: string, extraArgs: string[] = []): Promise<Browser> {
  const userDataDir = mkdtempSync(resolve(tmpdir(), "solvchat-widget-chrome-"));
  const proc: ChildProcess = spawn(
    chromePath,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-extensions",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      ...extraArgs,
      "about:blank",
    ],
    {
      stdio: "ignore",
      detached: true,
      env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: "/dev/null" },
    },
  );
  const stop = () => {
    try {
      if (proc.pid !== undefined) process.kill(-proc.pid, "SIGKILL");
    } catch {
      proc.kill("SIGKILL");
    }
    rmSync(userDataDir, { recursive: true, force: true });
  };
  try {
    const portFile = resolve(userDataDir, "DevToolsActivePort");
    const started = Date.now();
    while (!existsSync(portFile) || readFileSync(portFile, "utf8").split("\n").length < 2) {
      if (Date.now() - started > 60_000) throw new Error("Chromium did not start");
      await new Promise((r) => setTimeout(r, 100));
    }
    const port = readFileSync(portFile, "utf8").split("\n")[0]?.trim();
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{
      type: string;
      webSocketDebuggerUrl?: string;
    }>;
    const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (!page?.webSocketDebuggerUrl) throw new Error("No Chromium page target");
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    return {
      cdp,
      close() {
        cdp.close();
        stop();
      },
    };
  } catch (err) {
    stop();
    throw err;
  }
}

export async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  what: string,
  timeoutMs = 10_000,
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
