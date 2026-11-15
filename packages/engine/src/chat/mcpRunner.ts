import type { Tenant } from "../db/tenant.js";
import { callTool } from "../mcp/client.js";
import { McpError, type McpTarget } from "../mcp/types.js";
import type { ToolDefinition } from "../providers/types.js";
import { openSecret } from "../security/secretBox.js";
import type { ToolRunner, ToolRunResult } from "./toolLoop.js";

/**
 * Model-visible name for a tool. Two servers may both offer `search`, so the
 * server is part of the name: otherwise the engine would have to choose which
 * server a call meant, and choosing would mean guessing which credential to
 * spend.
 *
 * Prefixed with `m` so the name always starts with a letter even when the
 * server id suffix begins with a digit, keeping it within both providers'
 * tool-name rules.
 */
function qualifiedName(serverId: string, toolName: string): string {
  return `m${serverId.slice(-8)}__${toolName}`;
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
): Promise<ToolRunner | null> {
  // Already filtered to allowed tools on enabled servers, inside this org.
  const rows = await deps.tenant.mcp.listAllowedTools(assistantId);
  if (rows.length === 0) return null;

  const published = new Set(allowedToolNames);
  const usable = rows.filter((row) => published.has(row.name));
  if (usable.length === 0) return null;

  const byQualified = new Map(usable.map((row) => [qualifiedName(row.serverId, row.name), row]));
  const definitions: ToolDefinition[] = usable.map((row) => ({
    name: qualifiedName(row.serverId, row.name),
    // The server's own description, passed through as data. It reaches the
    // prompt as part of the tool list, never as an instruction, and the safety
    // frame says tool text is to be read and not obeyed.
    description: row.description,
    inputSchema: row.inputSchema,
  }));

  return {
    kind: "mcp",
    definitions,
    async run(call, signal): Promise<ToolRunResult> {
      const row = byQualified.get(call.name);
      if (!row) {
        // Cannot happen through the loop, which only calls names it offered,
        // but a wrong answer here would be a call with the wrong credential.
        return { content: "That tool is not available.", isError: true };
      }

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
                headerValue: await openCredential(deps, row.serverId),
              }
            : {}),
        };
      } catch (err) {
        // Typically SOLV_SECRET_KEY was rotated without re-entering the keys.
        // The owner needs to know; the visitor gets an answer without the tool.
        console.error("mcp: stored credential could not be read", {
          serverId: row.serverId,
          reason: err instanceof Error ? err.message : "unknown error",
        });
        return { content: "That tool is not available right now.", isError: true };
      }

      try {
        const result = await callTool(target, row.name, call.input, {
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
