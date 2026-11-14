import { prepare, prepareInsert, safeJsonObject } from "./sql.js";

export type McpAuthKind = "none" | "static_header";

interface ServerDbRow {
  id: string;
  org_id: string;
  assistant_id: string;
  label: string;
  url: string;
  auth_kind: McpAuthKind;
  secret_ciphertext: string | null;
  enabled: number;
  created_at: number;
}

interface ToolDbRow {
  id: string;
  org_id: string;
  server_id: string;
  name: string;
  description: string;
  input_schema: string;
  allowed: number;
}

export interface McpServerRow {
  id: string;
  orgId: string;
  assistantId: string;
  label: string;
  url: string;
  authKind: McpAuthKind;
  hasSecret: boolean;
  enabled: boolean;
  createdAt: number;
}

export interface McpToolRow {
  id: string;
  orgId: string;
  serverId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  allowed: boolean;
}

export interface CreateMcpServerInput {
  id: string;
  assistantId: string;
  label: string;
  url: string;
  authKind: McpAuthKind;
  secretCiphertext: string | null;
  enabled: boolean;
  createdAt: number;
}

export interface UpdateMcpServerInput {
  label: string;
  url: string;
  enabled: boolean;
}

export interface UpsertMcpToolInput {
  id: string;
  serverId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const SERVER_COLUMNS =
  "id, org_id, assistant_id, label, url, auth_kind, secret_ciphertext, enabled, created_at";
const TOOL_COLUMNS = "id, org_id, server_id, name, description, input_schema, allowed";

const mapServer = (row: ServerDbRow): McpServerRow => ({
  id: row.id,
  orgId: row.org_id,
  assistantId: row.assistant_id,
  label: row.label,
  url: row.url,
  authKind: row.auth_kind,
  hasSecret: row.secret_ciphertext !== null,
  enabled: row.enabled === 1,
  createdAt: row.created_at,
});

const mapTool = (row: ToolDbRow): McpToolRow => ({
  id: row.id,
  orgId: row.org_id,
  serverId: row.server_id,
  name: row.name,
  description: row.description,
  inputSchema: safeJsonObject(row.input_schema),
  allowed: row.allowed === 1,
});

/** Tenant-scoped data access for `mcp_servers` and `mcp_tools`. */
export function mcpFor(db: D1Database, orgId: string) {
  return {
    async listServers(assistantId: string): Promise<McpServerRow[]> {
      const res = await prepare(
        db,
        `SELECT ${SERVER_COLUMNS} FROM mcp_servers WHERE org_id = ?1 AND assistant_id = ?2 ORDER BY created_at ASC`,
      )
        .bind(orgId, assistantId)
        .all<ServerDbRow>();
      return res.results.map(mapServer);
    },

    async getServer(id: string): Promise<McpServerRow | null> {
      const row = await prepare(
        db,
        `SELECT ${SERVER_COLUMNS} FROM mcp_servers WHERE org_id = ?1 AND id = ?2`,
      )
        .bind(orgId, id)
        .first<ServerDbRow>();
      return row ? mapServer(row) : null;
    },

    async createServer(input: CreateMcpServerInput): Promise<McpServerRow> {
      await prepareInsert(
        db,
        `INSERT INTO mcp_servers (id, org_id, assistant_id, label, url, auth_kind, secret_ciphertext, enabled, created_at)
         VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
        .bind(
          orgId,
          input.id,
          input.assistantId,
          input.label,
          input.url,
          input.authKind,
          input.secretCiphertext,
          input.enabled ? 1 : 0,
          input.createdAt,
        )
        .run();

      return {
        id: input.id,
        orgId,
        assistantId: input.assistantId,
        label: input.label,
        url: input.url,
        authKind: input.authKind,
        hasSecret: input.secretCiphertext !== null,
        enabled: input.enabled,
        createdAt: input.createdAt,
      };
    },

    async updateServer(id: string, input: UpdateMcpServerInput): Promise<boolean> {
      const res = await prepare(
        db,
        "UPDATE mcp_servers SET label = ?3, url = ?4, enabled = ?5 WHERE org_id = ?1 AND id = ?2",
      )
        .bind(orgId, id, input.label, input.url, input.enabled ? 1 : 0)
        .run();
      return (res.meta.changes ?? 0) > 0;
    },

    async removeServer(id: string): Promise<boolean> {
      const res = await prepare(db, "DELETE FROM mcp_servers WHERE org_id = ?1 AND id = ?2")
        .bind(orgId, id)
        .run();
      return (res.meta.changes ?? 0) > 0;
    },

    async listTools(serverId: string): Promise<McpToolRow[]> {
      const res = await prepare(
        db,
        `SELECT ${TOOL_COLUMNS} FROM mcp_tools WHERE org_id = ?1 AND server_id = ?2 ORDER BY name ASC`,
      )
        .bind(orgId, serverId)
        .all<ToolDbRow>();
      return res.results.map(mapTool);
    },

    async upsertTool(input: UpsertMcpToolInput): Promise<void> {
      await prepareInsert(
        db,
        `INSERT INTO mcp_tools (id, org_id, server_id, name, description, input_schema, allowed)
         VALUES (?2, ?1, ?3, ?4, ?5, ?6, 0)
         ON CONFLICT(org_id, server_id, name) DO UPDATE SET
           description = excluded.description,
           input_schema = excluded.input_schema`,
      )
        .bind(
          orgId,
          input.id,
          input.serverId,
          input.name,
          input.description,
          JSON.stringify(input.inputSchema),
        )
        .run();
    },

    async setToolAllowed(id: string, allowed: boolean): Promise<boolean> {
      const res = await prepare(
        db,
        "UPDATE mcp_tools SET allowed = ?3 WHERE org_id = ?1 AND id = ?2",
      )
        .bind(orgId, id, allowed ? 1 : 0)
        .run();
      return (res.meta.changes ?? 0) > 0;
    },
  };
}
