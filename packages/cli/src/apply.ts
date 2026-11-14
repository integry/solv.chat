import { readFile } from "node:fs/promises";
import { parseVersionConfig, type VersionConfig } from "@solvchat/core";
import { assertValidHeaderValue, CliError, normalizeEndpoint, requestJson } from "./http.js";
import type { CliDeps } from "./push.js";

export interface ApplyOptions {
  file: string;
  endpoint: string;
  assistant: string;
  adminToken?: string;
  session?: string;
}

interface DraftResponse {
  draft?: { config?: VersionConfig };
  config?: VersionConfig;
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

function buildAuthHeaders(options: ApplyOptions): Record<string, string> {
  const headers: Record<string, string> = {};
  if (options.adminToken) {
    const authHeader = `Bearer ${options.adminToken}`;
    assertValidHeaderValue("Authorization", authHeader, "SOLV_ADMIN_TOKEN");
    headers.Authorization = authHeader;
  }
  if (options.session) {
    const cookieHeader = options.session.includes("=")
      ? options.session
      : `solv_session=${options.session}`;
    assertValidHeaderValue("Cookie", cookieHeader, "SOLV_SESSION");
    headers.Cookie = cookieHeader;
  }
  return headers;
}

/**
 * Parses `solv.config.json` with `@solvchat/core`, prints a diff against the
 * current draft, and writes the new draft through the admin API.
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

  if (!options.adminToken && !options.session) {
    throw new CliError("Missing SOLV_ADMIN_TOKEN or SOLV_SESSION environment variable");
  }

  const endpoint = normalizeEndpoint(options.endpoint);
  const draftUrl = `${endpoint}/api/admin/assistants/${encodeURIComponent(options.assistant)}/draft`;
  const authHeaders = buildAuthHeaders(options);

  const current = await requestJson<DraftResponse>(
    deps.fetchImpl,
    draftUrl,
    { method: "GET", headers: authHeaders },
    "SOLV_ADMIN_TOKEN or SOLV_SESSION",
  );

  const currentConfig = current.draft?.config ?? current.config;
  const merged = parseVersionConfig(rawJson, currentConfig);
  if (!merged.ok) {
    for (const error of merged.errors) {
      deps.log(error);
    }
    throw new CliError(merged.errors.join("; "));
  }

  deps.log(diffConfig(currentConfig, merged.value));

  await requestJson<DraftResponse>(
    deps.fetchImpl,
    draftUrl,
    {
      method: "PUT",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json",
        Origin: new URL(endpoint).origin,
      },
      body: JSON.stringify(rawJson),
    },
    "SOLV_ADMIN_TOKEN or SOLV_SESSION",
  );

  deps.log(`Applied ${options.file} to draft`);
}
