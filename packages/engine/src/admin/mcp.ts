import { isPlainObject, newId, parseVersionConfig, type VersionConfig } from "@solvchat/core";
import type {
  McpAuthKind,
  McpServerTargetSnapshot,
  McpServerWithStatsRow,
  McpToolRow,
} from "../db/mcp.js";
import type { Tenant } from "../db/tenant.js";
import { listTools as listRemoteTools } from "../mcp/client.js";
import {
  CONVERSATION_CONTEXT_HEADER_NAMES,
  isConversationContextHeaderName,
} from "../mcp/context.js";
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
  /** "Send conversation context": off unless the owner turned it on. */
  sendConversationContext: boolean;
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
    sendConversationContext: row.sendConversationContext,
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
  sendConversationContext?: boolean;
}

const RESERVED_HEADER_NAMES = new Set([
  "host",
  "content-length",
  "content-type",
  "accept",
  "connection",
  "transfer-encoding",
]);

/** Shown when the owner's auth header would clash with a context header. */
export const CONTEXT_HEADER_CLASH_MESSAGE = `headerName: ${CONVERSATION_CONTEXT_HEADER_NAMES.join(", ")} are sent by solv.chat itself when "Send conversation context" is on. Choose another header name.`;

function isReservedHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return RESERVED_HEADER_NAMES.has(lower) || lower.startsWith("mcp-");
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

  if (body.sendConversationContext !== undefined) {
    if (typeof body.sendConversationContext !== "boolean") {
      errors.push("sendConversationContext: must be a boolean");
    } else {
      parsed.sendConversationContext = body.sendConversationContext;
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
      } else if (isConversationContextHeaderName(headerName)) {
        // Refused whether or not the setting is on, so turning it on later
        // can never make a context header stand in for the credential.
        errors.push(CONTEXT_HEADER_CLASH_MESSAGE);
      } else if (isReservedHeaderName(headerName)) {
        errors.push("headerName: header name is reserved");
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
    sendConversationContext: input.sendConversationContext ?? false,
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

  // A row saved before the clash rule could still hold one of these names.
  // Any save of it (not only turning the setting on) asks for a new name.
  const effectiveAuthKind = input.authKind ?? existing.authKind;
  const effectiveHeaderName =
    input.headerName !== undefined ? input.headerName : existing.headerName;
  if (
    effectiveAuthKind === "static_header" &&
    effectiveHeaderName !== null &&
    isConversationContextHeaderName(effectiveHeaderName)
  ) {
    throw new BadRequest([CONTEXT_HEADER_CLASH_MESSAGE]);
  }

  const secretCiphertext =
    input.headerValue === null
      ? null
      : input.headerValue !== undefined
        ? await sealSecret(deps.secretKey, input.headerValue)
        : undefined;

  const needsAuthKindCheck = input.authKind === undefined && input.headerName !== undefined;
  const hasAnyUpdate =
    input.label !== undefined ||
    input.url !== undefined ||
    input.enabled !== undefined ||
    input.sendConversationContext !== undefined ||
    input.authKind !== undefined ||
    input.headerName !== undefined ||
    secretCiphertext !== undefined;

  if (!hasAnyUpdate) {
    return { server: await getServerSummary(deps, serverId) };
  }

  if (!needsAuthKindCheck) {
    const headerName = input.authKind === "none" ? null : input.headerName;
    const updated = await deps.tenant.mcp.updateServer(serverId, {
      label: input.label,
      url: input.url,
      enabled: input.enabled,
      sendConversationContext: input.sendConversationContext,
      authKind: input.authKind,
      headerName,
      secretCiphertext,
    });
    if (!updated) throw new NotFound("mcp server");
    return { server: await getServerSummary(deps, serverId) };
  }

  let current = existing;
  for (let attempt = 0; attempt < MAX_DRAFT_UPDATE_ATTEMPTS; attempt++) {
    const headerName = current.authKind === "none" ? null : input.headerName;
    const updated = await deps.tenant.mcp.updateServer(serverId, {
      label: input.label,
      url: input.url,
      enabled: input.enabled,
      sendConversationContext: input.sendConversationContext,
      headerName,
      secretCiphertext,
      expectedAuthKind: current.authKind,
    });
    if (updated) {
      return { server: await getServerSummary(deps, serverId) };
    }
    const fresh = await deps.tenant.mcp.getServer(serverId);
    if (fresh === null) throw new NotFound("mcp server");
    current = fresh;
  }

  throw new Conflict("The server changed while you were saving. Please try again.");
}

const MAX_DRAFT_UPDATE_ATTEMPTS = 5;

function withoutToolNames(
  config: VersionConfig,
  namesToRemove: readonly string[],
): { next: VersionConfig; changed: boolean } {
  if (namesToRemove.length === 0) return { next: config, changed: false };
  const removeSet = new Set(namesToRemove);
  const filtered = config.allowedTools.filter((name) => !removeSet.has(name));
  if (filtered.length === config.allowedTools.length) {
    return { next: config, changed: false };
  }
  const parsed = parseVersionConfig({ allowedTools: filtered }, config);
  if (!parsed.ok) {
    throw new Conflict("The draft changed while you were saving. Please try again.");
  }
  return { next: parsed.value, changed: true };
}

/** Deletes an MCP server, its discovered tools, and reconciles the draft's `allowedTools`. */
export async function deleteMcpServer(
  tenant: Tenant,
  serverId: string,
): Promise<{ deleted: true }> {
  let expectedDraftId: string | null = null;

  for (let attempt = 0; attempt < MAX_DRAFT_UPDATE_ATTEMPTS; attempt++) {
    const server = await tenant.mcp.getServer(serverId);
    if (server === null) throw new NotFound("mcp server");

    const draft = await tenant.versions.draft(server.assistantId);
    if (draft === null) {
      const removed = await tenant.mcp.removeServer(serverId);
      if (!removed) throw new NotFound("mcp server");
      return { deleted: true };
    }
    if (expectedDraftId !== null && draft.id !== expectedDraftId) {
      throw new Conflict("The draft changed because it was published. Please try again.");
    }
    expectedDraftId = draft.id;

    const serverAllowedNames = await tenant.mcp.listServerAllowedToolNames(serverId);
    const otherAllowedNames = await tenant.mcp.listOtherAllowedToolNames(
      server.assistantId,
      serverId,
    );
    const removedFromDraftNames = serverAllowedNames.filter((n) => !otherAllowedNames.has(n));
    const { next, changed } = withoutToolNames(draft.config, removedFromDraftNames);

    const removed = await tenant.mcp.removeServerWithDraft({
      assistantId: server.assistantId,
      serverId,
      serverAllowedNames,
      removedFromDraftNames,
      expectedDraft: draft,
      nextConfig: next,
      hasDraftChange: changed,
    });
    if (removed) {
      return { deleted: true };
    }
  }

  throw new Conflict("The draft changed while you were saving. Please try again.");
}

/** Lists all discovered tools for one MCP server. */
export async function listMcpTools(tenant: Tenant, serverId: string): Promise<McpToolView[]> {
  const server = await tenant.mcp.getServer(serverId);
  if (server === null) throw new NotFound("mcp server");
  return (await tenant.mcp.listTools(serverId)).map(toToolView);
}

function targetsEqual(a: McpServerTargetSnapshot, b: McpServerTargetSnapshot): boolean {
  return (
    a.url === b.url &&
    a.authKind === b.authKind &&
    a.headerName === b.headerName &&
    a.secretCiphertext === b.secretCiphertext
  );
}

/**
 * Lists the server's tools and stores them switched off, then drops the ones
 * it no longer offers and reconciles the draft's `allowedTools`. `allowed`
 * survives for tools that are still there.
 */
export async function refreshMcpTools(deps: McpDeps, serverId: string): Promise<McpToolView[]> {
  for (let targetAttempt = 0; targetAttempt < MAX_DRAFT_UPDATE_ATTEMPTS; targetAttempt++) {
    const snapshot = await deps.tenant.mcp.readTargetWithSecretCiphertext(serverId);
    if (snapshot === null) throw new NotFound("mcp server");

    const target: McpTarget = {
      url: snapshot.url,
      authKind: snapshot.authKind,
      headerName: snapshot.headerName ?? undefined,
    };
    if (snapshot.authKind === "static_header" && snapshot.secretCiphertext !== null) {
      target.headerValue = await openSecret(deps.secretKey, snapshot.secretCiphertext);
    }
    if (snapshot.sendConversationContext) {
      // An owner's add or refresh belongs to no conversation: the assistant id
      // is all there is to send.
      target.conversationContext = { assistantId: snapshot.assistantId };
    }

    const remote = await listRemoteTools(target, { fetchImpl: deps.fetchImpl });
    const toolsByName = new Map<
      string,
      {
        id: string;
        serverId: string;
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
      }
    >();
    for (const tool of remote) {
      toolsByName.set(tool.name, {
        id: newId("mcp"),
        serverId,
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }
    const toolsToUpsert = [...toolsByName.values()];
    const remoteNames = toolsToUpsert.map((tool) => tool.name);
    let expectedDraftId: string | null = null;
    let targetChanged = false;

    for (let attempt = 0; attempt < MAX_DRAFT_UPDATE_ATTEMPTS; attempt++) {
      const currentTarget = await deps.tenant.mcp.readTargetWithSecretCiphertext(serverId);
      if (currentTarget === null) throw new NotFound("mcp server");
      if (!targetsEqual(snapshot, currentTarget)) {
        targetChanged = true;
        break;
      }

      const draft = await deps.tenant.versions.draft(currentTarget.assistantId);
      if (draft === null) {
        const replaced = await deps.tenant.mcp.replaceServerTools(
          serverId,
          toolsToUpsert,
          snapshot,
        );
        if (replaced) {
          return (await deps.tenant.mcp.listTools(serverId)).map(toToolView);
        }
        const latestTarget = await deps.tenant.mcp.readTargetWithSecretCiphertext(serverId);
        if (latestTarget === null) throw new NotFound("mcp server");
        if (!targetsEqual(snapshot, latestTarget)) {
          targetChanged = true;
          break;
        }
        throw new NotFound("mcp server");
      }
      if (expectedDraftId !== null && draft.id !== expectedDraftId) {
        throw new Conflict("The draft changed because it was published. Please try again.");
      }
      expectedDraftId = draft.id;

      const prunedAllowedNames = await deps.tenant.mcp.listPrunedAllowedToolNames(
        serverId,
        remoteNames,
      );
      const otherAllowedNames = await deps.tenant.mcp.listOtherAllowedToolNames(
        currentTarget.assistantId,
        serverId,
      );
      const removedFromDraftNames = prunedAllowedNames.filter((n) => !otherAllowedNames.has(n));
      const { next, changed } = withoutToolNames(draft.config, removedFromDraftNames);

      const synced = await deps.tenant.mcp.syncToolsWithDraft({
        assistantId: currentTarget.assistantId,
        serverId,
        expectedTarget: snapshot,
        tools: toolsToUpsert,
        remoteNames,
        prunedAllowedNames,
        removedFromDraftNames,
        expectedDraft: draft,
        nextConfig: next,
        hasDraftChange: changed,
      });
      if (synced) {
        return (await deps.tenant.mcp.listTools(serverId)).map(toToolView);
      }

      const latestTarget = await deps.tenant.mcp.readTargetWithSecretCiphertext(serverId);
      if (latestTarget === null) throw new NotFound("mcp server");
      if (!targetsEqual(snapshot, latestTarget)) {
        targetChanged = true;
        break;
      }
    }

    if (!targetChanged) {
      throw new Conflict("The draft changed while you were saving. Please try again.");
    }
  }

  throw new Conflict("The server configuration changed while refreshing tools. Please try again.");
}

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

  let expectedDraftId: string | null = null;
  for (let attempt = 0; attempt < MAX_DRAFT_UPDATE_ATTEMPTS; attempt++) {
    const tools = await tenant.mcp.listTools(serverId);
    const tool = tools.find((candidate) => candidate.id === toolId);
    if (!tool) throw new NotFound("mcp tool");

    const draft = await tenant.versions.draft(server.assistantId);
    if (draft === null) {
      await tenant.mcp.setToolAllowed(toolId, allowed);
      return { tool: toToolView({ ...tool, allowed }) };
    }
    if (expectedDraftId !== null && draft.id !== expectedDraftId) {
      throw new Conflict("The draft changed because it was published. Please try again.");
    }
    expectedDraftId = draft.id;

    const names = new Set(draft.config.allowedTools);
    let keepName = false;
    if (allowed) {
      names.add(tool.name);
    } else {
      keepName = await tenant.mcp.hasOtherAllowedTool(server.assistantId, toolId, tool.name);
      if (!keepName) {
        names.delete(tool.name);
      }
    }

    const next = parseVersionConfig({ allowedTools: [...names] }, draft.config);
    if (!next.ok) {
      throw new Conflict("The draft changed while you were saving. Please try again.");
    }

    const updated = await tenant.mcp.setToolAllowedWithDraft({
      assistantId: server.assistantId,
      toolId,
      toolName: tool.name,
      allowed,
      keepName,
      expectedDraft: draft,
      nextConfig: next.value,
    });
    if (updated) {
      return { tool: toToolView({ ...tool, allowed }) };
    }
  }

  throw new Conflict("The draft changed while you were saving. Please try again.");
}

/** One server as `solv apply` sees it: no credential, no header name. */
export interface McpServerContextSetting {
  id: string;
  label: string;
  url: string;
  sendConversationContext: boolean;
}

/** The "Send conversation context" setting of every server on an assistant. */
export async function listMcpServerSettings(
  tenant: Tenant,
  assistantId: string,
): Promise<{ servers: McpServerContextSetting[] }> {
  const assistant = await tenant.assistants.get(assistantId);
  if (assistant === null) throw new NotFound("assistant");
  const rows = await tenant.mcp.listServers(assistantId);
  return {
    servers: rows.map((row) => ({
      id: row.id,
      label: row.label,
      url: row.url,
      sendConversationContext: row.sendConversationContext,
    })),
  };
}

/**
 * Sets "Send conversation context" from `solv.config.json`'s `mcpServers`.
 *
 * Servers are matched by address on this assistant. The file cannot add a
 * server (its credential has no place in a repository), so an address with no
 * server is refused, and nothing changes unless every entry is valid. Servers
 * the file does not list keep their setting.
 */
export async function applyMcpServerSettings(
  tenant: Tenant,
  assistantId: string,
  body: unknown,
): Promise<{ servers: McpServerContextSetting[]; changed: number }> {
  const assistant = await tenant.assistants.get(assistantId);
  if (assistant === null) throw new NotFound("assistant");
  if (!isPlainObject(body) || !Array.isArray(body.servers)) {
    throw new BadRequest(["servers: must be an array"]);
  }
  const rows = await tenant.mcp.listServers(assistantId);
  const errors: string[] = [];
  const wanted = new Map<string, boolean>();

  body.servers.forEach((entry: unknown, i: number) => {
    const at = `mcpServers[${i}]`;
    if (!isPlainObject(entry)) {
      errors.push(`${at}: must be an object`);
      return;
    }
    let url: string;
    try {
      url = assertPublicHttpsUrl(typeof entry.url === "string" ? entry.url.trim() : "").href;
    } catch {
      errors.push(`${at}.url: must be an https URL that is not a private or loopback address`);
      return;
    }
    if (typeof entry.sendConversationContext !== "boolean") {
      errors.push(`${at}.sendConversationContext: must be true or false`);
      return;
    }
    if (!rows.some((row) => row.url === url)) {
      errors.push(
        `${at}.url: this assistant has no tool server at ${url}. Add it on the Tools screen first.`,
      );
      return;
    }
    const previous = wanted.get(url);
    if (previous !== undefined && previous !== entry.sendConversationContext) {
      errors.push(`${at}.url: ${url} is listed twice with different settings`);
      return;
    }
    wanted.set(url, entry.sendConversationContext);
  });
  if (errors.length > 0) throw new BadRequest(errors);

  let changed = 0;
  for (const row of rows) {
    const next = wanted.get(row.url);
    if (next === undefined || next === row.sendConversationContext) continue;
    // Several servers may share an address; the setting is about where the
    // ids go, so each of them follows the file.
    if (await tenant.mcp.updateServer(row.id, { sendConversationContext: next })) changed += 1;
  }
  return { ...(await listMcpServerSettings(tenant, assistantId)), changed };
}
