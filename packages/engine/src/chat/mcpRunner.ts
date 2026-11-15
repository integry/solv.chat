import type { Tenant } from "../db/tenant.js";
import { callTool } from "../mcp/client.js";
import { McpError, type McpTarget } from "../mcp/types.js";
import type { ToolDefinition } from "../providers/types.js";
import { openSecret } from "../security/secretBox.js";
import type { ToolRunner, ToolRunResult } from "./toolLoop.js";

// Both Anthropic and OpenAI restrict tool names to 1..64 characters matching ^[a-zA-Z0-9_-]+$.
// Sources (checked 2026-11-15):
// - https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
// - https://developers.openai.com/api/docs/guides/function-calling
export const MAX_TOOL_ALIAS_LENGTH = 64;
export const TOOL_ALIAS_PATTERN = /^[a-zA-Z0-9_-]+$/;

function sanitizeToolBase(toolName: string): string {
  const cleaned = toolName.replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned.length > 0 ? cleaned : "tool";
}

/**
 * Derives a unique model-visible alias from `toolName`, truncated to fit
 * provider limits and suffixed with a short counter on any collision.
 */
function allocateAlias(toolName: string, usedNames: Set<string>): string {
  const base = sanitizeToolBase(toolName);
  let candidate = base.slice(0, MAX_TOOL_ALIAS_LENGTH);
  if (!usedNames.has(candidate)) {
    usedNames.add(candidate);
    return candidate;
  }

  for (let counter = 2; ; counter++) {
    const suffix = `_${counter}`;
    const prefixLength = Math.max(0, MAX_TOOL_ALIAS_LENGTH - suffix.length);
    candidate = `${base.slice(0, prefixLength)}${suffix}`;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
  }
}

export interface McpRunnerDeps {
  tenant: Tenant;
  /** SOLV_SECRET_KEY, from the Worker environment. */
  secretKey: string;
  fetchImpl?: typeof fetch | undefined;
}

/**
 * Builds the MCP tool runner for one answer, or null when no tool may run.
 *
 * `allowedToolNames` is the version's `allowedTools` — the published version
 * for a visitor, the draft for the owner's preview. A tool must be in it *and*
 * have its `allowed` flag set: both lists say yes or the tool does not exist
 * as far as the model is concerned.
 */
export async function mcpRunnerFor(
  deps: McpRunnerDeps,
  assistantId: string,
  allowedToolNames: readonly string[],
  reservedNames: Iterable<string> = [],
): Promise<ToolRunner | null> {
  // Already filtered to allowed tools on enabled servers, inside this org.
  const rows = await deps.tenant.mcp.listAllowedTools(assistantId);
  if (rows.length === 0) return null;

  const published = new Set(allowedToolNames);
  const usable = rows.filter((row) => published.has(row.name));
  if (usable.length === 0) return null;

  // Explicit per-request alias table: alias -> { serverId, toolName, row }.
  // Page actions and MCP tools share `usedNames` so an MCP alias never
  // collides with a page action's name.
  const usedNames = new Set(reservedNames);
  const aliasTable = new Map<
    string,
    { serverId: string; toolName: string; row: (typeof usable)[number] }
  >();
  const definitions: ToolDefinition[] = [];

  for (const row of usable) {
    const alias = allocateAlias(row.name, usedNames);
    aliasTable.set(alias, { serverId: row.serverId, toolName: row.name, row });
    definitions.push({
      name: alias,
      // The server's own description, passed through as data. It reaches the
      // prompt as part of the tool list, never as an instruction, and the safety
      // frame says tool text is to be read and not obeyed.
      description: row.description,
      inputSchema: row.inputSchema,
    });
  }

  return {
    kind: "mcp",
    definitions,
    async run(call, signal): Promise<ToolRunResult> {
      const entry = aliasTable.get(call.name);
      if (!entry) {
        return { content: `No tool named ${call.name} is available.`, isError: true };
      }
      const { serverId, toolName, row } = entry;

      let target: McpTarget;
      try {
        target = {
          url: row.url,
          authKind: row.authKind,
          ...(row.authKind === "static_header"
            ? {
                headerName: row.headerName ?? "Authorization",
                // Opened here, per call, and held only for this request: the
                // specification says "decrypted only inside the Worker at call
                // time", and a runner that kept it would widen that window.
                headerValue: await openCredential(deps, serverId),
              }
            : {}),
        };
      } catch (err) {
        // Typically SOLV_SECRET_KEY was rotated without re-entering the keys.
        // The owner needs to know; the visitor gets an answer without the tool.
        console.error("mcp: stored credential could not be read", {
          serverId,
          reason: err instanceof Error ? err.message : "unknown error",
        });
        return { content: "That tool is not available right now.", isError: true };
      }

      try {
        const result = await callTool(target, toolName, call.input, {
          fetchImpl: deps.fetchImpl,
          signal,
        });
        return { content: result.content, isError: result.isError };
      } catch (err) {
        // McpError messages are written for a person and carry no upstream
        // body; anything else is replaced rather than forwarded into a prompt.
        return {
          content: err instanceof McpError ? err.message : "That tool could not be reached.",
          isError: true,
        };
      }
    },
  };
}

async function openCredential(deps: McpRunnerDeps, serverId: string): Promise<string> {
  const ciphertext = await deps.tenant.mcp.readSecretCiphertext(serverId);
  if (ciphertext === null) throw new Error("no credential stored");
  return openSecret(deps.secretKey, ciphertext);
}
