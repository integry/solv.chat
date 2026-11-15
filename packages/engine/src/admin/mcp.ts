import { isPlainObject, newId, parseVersionConfig } from "@solvchat/core";
import type { McpAuthKind, McpServerWithStatsRow, McpToolRow } from "../db/mcp.js";
import type { Tenant } from "../db/tenant.js";
import { listTools as listRemoteTools } from "../mcp/client.js";
import { McpError, type McpTarget } from "../mcp/types.js";
import { MAX_SECRET_LENGTH, openSecret, sealSecret } from "../security/secretBox.js";
import { assertPublicHttpsUrl } from "../security/urlGuard.js";
import { BadRequest, Conflict, NotFound } from "./errors.js";

export interface McpDeps {
  tenant: Tenant;
  /** From the Worker environment via AdminRouteDeps, never a seams/open import. */
  secretKey: string;
  fetchImpl?: typeof fetch | undefined;
}

export interface McpServerSummary {
  id: string;
  assistantId: string;
  label: string;
  url: string;
  authKind: McpAuthKind;
  headerName: string | null;
  /** "set" or "not set" on the screen. The value is never returned. */
  hasSecret: boolean;
  enabled: boolean;
  createdAt: number;
  toolCount: number;
  allowedCount: number;
}

export interface McpToolView {
  id: string;
  serverId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  allowed: boolean;
}

function toServerSummary(row: McpServerWithStatsRow): McpServerSummary {
  return {
    id: row.id,
    assistantId: row.assistantId,
    label: row.label,
    url: row.url,
    authKind: row.authKind,
    headerName: row.headerName,
    hasSecret: row.hasSecret,
    enabled: row.enabled,
    createdAt: row.createdAt,
    toolCount: row.toolCount,
    allowedCount: row.allowedCount,
  };
}

function toToolView(row: McpToolRow): McpToolView {
  return {
    id: row.id,
    serverId: row.serverId,
    name: row.name,
    description: row.description,
    inputSchema: row.inputSchema,
    allowed: row.allowed,
  };
}

interface ParsedServerInput {
  label?: string;
  url?: string;
  authKind?: McpAuthKind;
  headerName?: string | null;
  headerValue?: string | null;
  enabled?: boolean;
}

/** Validates and normalises the owner's input. Errors name their field. */
function readServerInput(body: unknown, forCreate: boolean): ParsedServerInput {
  if (!isPlainObject(body)) {
    throw new BadRequest(["body: must be a JSON object"]);
  }
  const errors: string[] = [];
  const parsed: ParsedServerInput = {};

  if (forCreate || body.label !== undefined) {
    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (label.length < 1 || label.length > 80) {
      errors.push("label: must be 1 to 80 characters");
    } else {
      parsed.label = label;
    }
  }

  if (forCreate || body.url !== undefined) {
    try {
      // The same guard the fetch uses, run here so the owner is told at once
      // rather than after a server row exists.
      parsed.url = assertPublicHttpsUrl(typeof body.url === "string" ? body.url : "").href;
    } catch {
      errors.push("url: must be an https URL that is not a private or loopback address");
    }
  }

  if (forCreate || body.authKind !== undefined) {
    if (body.authKind !== "none" && body.authKind !== "static_header") {
      errors.push('authKind: must be "none" or "static_header"');
    } else {
      parsed.authKind = body.authKind;
    }
  }

  if (!forCreate && body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      errors.push("enabled: must be a boolean");
    } else {
      parsed.enabled = body.enabled;
    }
  }

  if (body.headerName !== undefined) {
    if (body.headerName === null || body.headerName === "") {
      parsed.headerName = null;
    } else if (typeof body.headerName === "string") {
      const headerName = body.headerName.trim();
      if (!/^[A-Za-z0-9-]{1,64}$/.test(headerName)) {
        // Header names go straight into an outbound request; anything outside
        // this set could split a header.
        errors.push("headerName: must be letters, digits and hyphens");
      } else {
        parsed.headerName = headerName;
      }
    } else {
      errors.push("headerName: must be a string");
    }
  }

  // `undefined` means "leave the stored credential alone"; "" (or null) means
  // "clear it". Two meanings for one field, so the screen does not need a
  // second boolean.
  if (body.headerValue !== undefined) {
    if (body.headerValue === null || body.headerValue === "") {
      parsed.headerValue = null;
    } else if (typeof body.headerValue === "string") {
      if (body.headerValue.length > MAX_SECRET_LENGTH) {
        errors.push(`headerValue: must be at most ${MAX_SECRET_LENGTH} characters`);
      } else {
        parsed.headerValue = body.headerValue;
      }
    } else {
      errors.push("headerValue: must be a string");
    }
  }

  if (forCreate && parsed.authKind === "static_header") {
    if (!parsed.headerName) {
      errors.push("headerName: a header name is required for a static header");
    }
    if (!parsed.headerValue) {
      errors.push("headerValue: a credential is required for a static header");
    }
  }

  if (errors.length > 0) throw new BadRequest(errors);
  return parsed;
}

async function getServerSummary(deps: McpDeps, serverId: string): Promise<McpServerSummary> {
  const row = await deps.tenant.mcp.getServerWithStats(serverId);
  if (row === null) throw new NotFound("mcp server");
  return toServerSummary(row);
}

/** Lists an assistant's MCP servers with their tool and allowed-tool counts. */
export async function listMcpServers(
  tenant: Tenant,
  assistantId: string,
): Promise<McpServerSummary[]> {
  const assistant = await tenant.assistants.get(assistantId);
  if (assistant === null) throw new NotFound("assistant");
  const rows = await tenant.mcp.listServersWithStats(assistantId);
  return rows.map(toServerSummary);
}

/**
 * Adds an MCP server and immediately refreshes its tools. If the refresh fails,
 * the server is kept and `refreshError` is returned so the owner can fix the
 * URL or credential and retry.
 */
export async function createMcpServer(
  deps: McpDeps,
  assistantId: string,
  body: unknown,
): Promise<{ server: McpServerSummary; tools: McpToolView[]; refreshError?: string }> {
  const assistant = await deps.tenant.assistants.get(assistantId);
  if (assistant === null) throw new NotFound("assistant");
  const input = readServerInput(body, true);

  const authKind = input.authKind ?? "none";
  const server = await deps.tenant.mcp.createServer({
    id: newId("mcp"),
    assistantId,
    label: input.label ?? "",
    url: input.url ?? "",
    authKind,
    headerName: authKind === "static_header" ? (input.headerName ?? null) : null,
    // Sealed before it reaches D1; the plaintext exists only in this call.
    secretCiphertext:
      authKind === "static_header" && input.headerValue
        ? await sealSecret(deps.secretKey, input.headerValue)
        : null,
    enabled: true,
    createdAt: Date.now(),
  });

  try {
    const tools = await refreshMcpTools(deps, server.id);
    return { server: await getServerSummary(deps, server.id), tools };
  } catch (err) {
    return {
      server: await getServerSummary(deps, server.id),
      tools: [],
      refreshError:
        err instanceof McpError ? err.message : "That server's tools could not be listed.",
    };
  }
}

/**
 * Updates an MCP server's settings and/or credential. Omitting `headerValue`
 * leaves the stored credential untouched; passing `""` (or `null`) clears it.
 */
export async function updateMcpServer(
  deps: McpDeps,
  serverId: string,
  body: unknown,
): Promise<{ server: McpServerSummary }> {
  const existing = await deps.tenant.mcp.getServer(serverId);
  if (existing === null) throw new NotFound("mcp server");
  const input = readServerInput(body, false);

  const authKind = input.authKind ?? existing.authKind;
  const headerName =
    authKind === "none"
      ? null
      : input.headerName !== undefined
        ? input.headerName
        : existing.headerName;

  if (input.headerValue === null) {
    await deps.tenant.mcp.setSecretCiphertext(serverId, null);
  } else if (input.headerValue !== undefined) {
    const ciphertext = await sealSecret(deps.secretKey, input.headerValue);
    await deps.tenant.mcp.setSecretCiphertext(serverId, ciphertext);
  }

  await deps.tenant.mcp.updateServer(serverId, {
    label: input.label ?? existing.label,
    url: input.url ?? existing.url,
    enabled: input.enabled ?? existing.enabled,
    authKind,
    headerName,
  });

  return { server: await getServerSummary(deps, serverId) };
}

/** Deletes an MCP server and its discovered tools. */
export async function deleteMcpServer(
  tenant: Tenant,
  serverId: string,
): Promise<{ deleted: true }> {
  const removed = await tenant.mcp.removeServer(serverId);
  if (!removed) throw new NotFound("mcp server");
  return { deleted: true };
}

/** Lists all discovered tools for one MCP server. */
export async function listMcpTools(tenant: Tenant, serverId: string): Promise<McpToolView[]> {
  const server = await tenant.mcp.getServer(serverId);
  if (server === null) throw new NotFound("mcp server");
  return (await tenant.mcp.listTools(serverId)).map(toToolView);
}

/**
 * Lists the server's tools and stores them switched off, then drops the ones
 * it no longer offers. `allowed` survives for tools that are still there.
 */
export async function refreshMcpTools(deps: McpDeps, serverId: string): Promise<McpToolView[]> {
  const server = await deps.tenant.mcp.getServer(serverId);
  if (server === null) throw new NotFound("mcp server");

  const target: McpTarget = {
    url: server.url,
    authKind: server.authKind,
    headerName: server.headerName ?? undefined,
  };
  if (server.authKind === "static_header") {
    const ciphertext = await deps.tenant.mcp.readSecretCiphertext(serverId);
    if (ciphertext !== null) {
      target.headerValue = await openSecret(deps.secretKey, ciphertext);
    }
  }

  const remote = await listRemoteTools(target, { fetchImpl: deps.fetchImpl });

  for (const tool of remote) {
    // upsertTool inserts with allowed = 0 and on conflict updates only the
    // description and schema: new tools are off, existing switches are kept.
    await deps.tenant.mcp.upsertTool({
      id: newId("mcp"),
      serverId,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    });
  }
  await deps.tenant.mcp.removeToolsNotIn(
    serverId,
    remote.map((tool) => tool.name),
  );
  return (await deps.tenant.mcp.listTools(serverId)).map(toToolView);
}

const MAX_DRAFT_UPDATE_ATTEMPTS = 5;

/**
 * Switches one tool on or off, and keeps the draft version's `allowedTools` in
 * step so the owner manages one list, not two.
 */
export async function setMcpToolAllowed(
  tenant: Tenant,
  serverId: string,
  toolId: string,
  body: unknown,
): Promise<{ tool: McpToolView }> {
  if (!isPlainObject(body) || typeof body.allowed !== "boolean") {
    throw new BadRequest(["allowed: must be a boolean"]);
  }
  const allowed = body.allowed;

  const server = await tenant.mcp.getServer(serverId);
  if (server === null) throw new NotFound("mcp server");
  const tools = await tenant.mcp.listTools(serverId);
  const tool = tools.find((candidate) => candidate.id === toolId);
  if (!tool) throw new NotFound("mcp tool");

  await tenant.mcp.setToolAllowed(toolId, allowed);

  for (let attempt = 0; attempt < MAX_DRAFT_UPDATE_ATTEMPTS; attempt++) {
    const draft = await tenant.versions.draft(server.assistantId);
    if (draft === null) break;
    const names = new Set(draft.config.allowedTools);
    if (allowed) names.add(tool.name);
    else names.delete(tool.name);
    const next = parseVersionConfig({ allowedTools: [...names] }, draft.config);
    if (!next.ok) break;
    const updated = await tenant.versions.updateDraft(server.assistantId, next.value, draft);
    if (updated) {
      return { tool: toToolView({ ...tool, allowed }) };
    }
  }

  const draft = await tenant.versions.draft(server.assistantId);
  if (draft !== null) {
    throw new Conflict("The draft changed while you were saving. Please try again.");
  }
  return { tool: toToolView({ ...tool, allowed }) };
}
