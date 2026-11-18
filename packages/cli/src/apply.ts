import { readFile } from "node:fs/promises";
import {
  isPlainObject,
  parseVersionConfig,
  type TestInput,
  type VersionConfig,
} from "@solvchat/core";
import {
  assertValidHeaderValue,
  CliError,
  formatApiError,
  normalizeEndpoint,
  requestJson,
} from "./http.js";
import type { CliDeps } from "./push.js";
import { parseDeclaredTests } from "./test.js";

export interface ApplyOptions {
  file: string;
  endpoint: string;
  assistant: string;
  ingestKey?: string;
}

interface ConfigResponse {
  config?: VersionConfig;
}

/** One `mcpServers` entry: which tool server, and whether it gets the ids. */
export interface DeclaredMcpServer {
  url: string;
  sendConversationContext: boolean;
}

interface McpServersResponse {
  /** Through the ingest key a server is shown by its origin, never its full address. */
  servers?: Array<{ label: string; origin: string; sendConversationContext: boolean }>;
  changed?: number;
}

/**
 * Asks the engine whether `mcpServers` would be accepted, without changing
 * anything. Run before any write, so a refused entry leaves the draft, the
 * tests and every server as they were. Each refusal is printed on its own
 * line: the ingest key can turn "Send conversation context" off but not on,
 * so an entry asking for on where a server is off names the server to turn
 * on in the admin.
 */
async function checkMcpServers(
  deps: CliDeps,
  url: string,
  authHeaders: Record<string, string>,
  servers: DeclaredMcpServer[],
): Promise<McpServersResponse> {
  const response = await deps.fetchImpl(url, {
    method: "PUT",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ servers, dryRun: true }),
  });
  if (response.ok) return (await response.json()) as McpServersResponse;
  let errors: string[] = [];
  if (response.status === 400) {
    try {
      const body = (await response.clone().json()) as { errors?: unknown };
      if (Array.isArray(body.errors)) {
        errors = body.errors.filter((e): e is string => typeof e === "string");
      }
    } catch {
      // Fall back to the generic message below.
    }
  }
  const message =
    errors.length > 0 ? errors.join("; ") : await formatApiError(response, "SOLV_INGEST_KEY");
  for (const error of errors) deps.log(error);
  deps.log("Nothing was changed: not the draft, the tests or any tool server.");
  throw new CliError(message);
}

/**
 * Validates `mcpServers` from `solv.config.json`. The file only sets "Send
 * conversation context" on servers already added in the admin: a server's
 * credential has no place in a repository, so the file cannot add one.
 */
export function parseDeclaredMcpServers(
  raw: unknown,
  file: string,
  log?: (line: string) => void,
): DeclaredMcpServer[] {
  if (!Array.isArray(raw)) {
    throw new CliError(`${file}: mcpServers must be an array`);
  }
  const items: DeclaredMcpServer[] = [];
  const errors: string[] = [];
  raw.forEach((entry: unknown, i) => {
    if (!isPlainObject(entry)) {
      errors.push(`mcpServers[${i}]: must be an object`);
      return;
    }
    const url = typeof entry.url === "string" ? entry.url.trim() : "";
    if (!url.startsWith("https://")) {
      errors.push(`mcpServers[${i}].url: must be the https address of a tool server`);
      return;
    }
    if (typeof entry.sendConversationContext !== "boolean") {
      errors.push(`mcpServers[${i}].sendConversationContext: must be true or false`);
      return;
    }
    items.push({ url, sendConversationContext: entry.sendConversationContext });
  });
  if (errors.length > 0) {
    for (const error of errors) log?.(error);
    throw new CliError(errors.join("; "));
  }
  return items;
}

function flattenConfig(value: unknown, prefix = ""): Array<[string, string]> {
  if (Array.isArray(value) || typeof value !== "object" || value === null) {
    return [[prefix, JSON.stringify(value)]];
  }
  const entries: Array<[string, string]> = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const path = prefix ? `${prefix}.${key}` : key;
    entries.push(...flattenConfig(child, path));
  }
  return entries;
}

/**
 * Produces a concise line-by-line diff between two `VersionConfig` objects.
 */
export function diffConfig(before: VersionConfig | undefined, after: VersionConfig): string {
  if (!before) {
    return flattenConfig(after)
      .map(([path, val]) => `+ ${path}: ${val}`)
      .join("\n");
  }

  const prev = new Map(flattenConfig(before));
  const next = new Map(flattenConfig(after));
  const keys = [...new Set([...prev.keys(), ...next.keys()])].sort();
  const lines: string[] = [];

  for (const key of keys) {
    const oldVal = prev.get(key);
    const newVal = next.get(key);
    if (oldVal === newVal) continue;
    if (oldVal !== undefined) lines.push(`- ${key}: ${oldVal}`);
    if (newVal !== undefined) lines.push(`+ ${key}: ${newVal}`);
  }

  return lines.length > 0 ? lines.join("\n") : "No changes.";
}

/**
 * Parses `solv.config.json` with `@solvchat/core`, prints a diff against the
 * current draft, and writes the new draft through the ingest API. `mcpServers`
 * is checked with the engine before anything is written, so a refused entry
 * leaves everything as it was.
 */
export async function apply(options: ApplyOptions, deps: CliDeps): Promise<void> {
  const rawText = await readFile(options.file, "utf8");
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(rawText);
  } catch {
    throw new CliError(`Invalid JSON in ${options.file}`);
  }

  const parsed = parseVersionConfig(rawJson);
  if (!parsed.ok) {
    // Field-prefixed messages straight through: the owner edited a file and
    // needs to know which field failed, not just that "the request was invalid".
    for (const error of parsed.errors) {
      deps.log(error);
    }
    throw new CliError(parsed.errors.join("; "));
  }

  // Separated before anything is sent. `parseVersionConfig` drops unknown
  // keys, so leaving `tests` in the config body would look like it worked.
  let declaredTests: TestInput[] | null = null;
  if (isPlainObject(rawJson) && rawJson.tests !== undefined) {
    declaredTests = parseDeclaredTests(rawJson.tests, options.file, deps.log);
  }
  let declaredMcpServers: DeclaredMcpServer[] | null = null;
  if (isPlainObject(rawJson) && rawJson.mcpServers !== undefined) {
    declaredMcpServers = parseDeclaredMcpServers(rawJson.mcpServers, options.file, deps.log);
  }
  const configOnly = isPlainObject(rawJson)
    ? Object.fromEntries(
        Object.entries(rawJson).filter(([key]) => key !== "tests" && key !== "mcpServers"),
      )
    : rawJson;

  if (!options.ingestKey) {
    throw new CliError("Missing SOLV_INGEST_KEY environment variable");
  }

  const endpoint = normalizeEndpoint(options.endpoint);
  const assistantBase = `${endpoint}/v1/ingest/${encodeURIComponent(options.assistant)}`;
  const configUrl = `${assistantBase}/config`;
  const authHeader = `Bearer ${options.ingestKey}`;
  assertValidHeaderValue("Authorization", authHeader, "SOLV_INGEST_KEY");
  const authHeaders = { Authorization: authHeader };

  const current = await requestJson<ConfigResponse>(
    deps.fetchImpl,
    configUrl,
    { method: "GET", headers: authHeaders },
    "SOLV_INGEST_KEY",
  );

  const currentConfig = current.config;
  const merged = parseVersionConfig(rawJson, currentConfig);
  if (!merged.ok) {
    for (const error of merged.errors) {
      deps.log(error);
    }
    throw new CliError(merged.errors.join("; "));
  }

  const mcpServersUrl = `${assistantBase}/mcp-servers`;
  if (declaredMcpServers !== null) {
    await checkMcpServers(deps, mcpServersUrl, authHeaders, declaredMcpServers);
  }

  deps.log(diffConfig(currentConfig, merged.value));

  await requestJson<ConfigResponse>(
    deps.fetchImpl,
    configUrl,
    {
      method: "PUT",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(configOnly),
    },
    "SOLV_INGEST_KEY",
  );

  deps.log(`Draft updated from ${options.file}. Publish in the admin when ready.`);

  if (declaredTests !== null) {
    deps.log(
      `Replacing the assistant's tests with ${declaredTests.length} from ${options.file} (any test not in this file will be removed).`,
    );
    const synced = await requestJson<{ created: number; removed: number }>(
      deps.fetchImpl,
      `${assistantBase}/tests`,
      {
        method: "PUT",
        headers: {
          ...authHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tests: declaredTests }),
      },
      "SOLV_INGEST_KEY",
    );
    deps.log(`Tests: ${synced.created} declared, ${synced.removed} removed.`);
  }

  if (declaredMcpServers !== null) {
    // Takes effect at once, like the switch on the Tools screen: this setting
    // belongs to the server, not to the draft, so Publish does not gate it.
    // Checked above, so only a change made in the admin since then can make
    // this refuse.
    const result = await requestJson<McpServersResponse>(
      deps.fetchImpl,
      mcpServersUrl,
      {
        method: "PUT",
        headers: {
          ...authHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ servers: declaredMcpServers }),
      },
      "SOLV_INGEST_KEY",
    );
    for (const server of result.servers ?? []) {
      deps.log(
        `Tool server ${server.label} (${server.origin}): send conversation context ${server.sendConversationContext ? "on" : "off"}.`,
      );
    }
    deps.log(`Tool servers: ${result.changed ?? 0} changed.`);
  }
}
