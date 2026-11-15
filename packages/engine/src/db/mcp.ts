import type { VersionConfig } from "@solvchat/core";
import { prepare, prepareInsert, safeJsonObject } from "./sql.js";
import { expectedVersionConfig, type VersionRow } from "./versions.js";

export type McpAuthKind = "none" | "static_header";

interface ServerDbRow {
  id: string;
  org_id: string;
  assistant_id: string;
  label: string;
  url: string;
  auth_kind: McpAuthKind;
  header_name: string | null;
  secret_ciphertext: string | null;
  enabled: number;
  created_at: number;
}

interface ServerWithStatsDbRow extends ServerDbRow {
  tool_count: number;
  allowed_count: number;
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

interface AllowedToolDbRow {
  id: string;
  server_id: string;
  name: string;
  description: string;
  input_schema: string;
  url: string;
  auth_kind: McpAuthKind;
  header_name: string | null;
  label: string;
}

export interface McpServerRow {
  id: string;
  orgId: string;
  assistantId: string;
  label: string;
  url: string;
  authKind: McpAuthKind;
  headerName: string | null;
  hasSecret: boolean;
  enabled: boolean;
  createdAt: number;
}

/**
 * Internal snapshot for outbound MCP requests, binding endpoint, auth
 * settings, and encrypted credential to a single DB read. Never returned by
 * any API response.
 */
export interface McpServerTargetSnapshot {
  id: string;
  assistantId: string;
  url: string;
  authKind: McpAuthKind;
  headerName: string | null;
  secretCiphertext: string | null;
}

export interface McpServerWithStatsRow extends McpServerRow {
  toolCount: number;
  allowedCount: number;
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

export interface McpAllowedToolRow {
  id: string;
  serverId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  url: string;
  authKind: McpAuthKind;
  headerName: string | null;
  label: string;
}

export interface CreateMcpServerInput {
  id: string;
  assistantId: string;
  label: string;
  url: string;
  authKind: McpAuthKind;
  headerName?: string | null | undefined;
  secretCiphertext: string | null;
  enabled: boolean;
  createdAt: number;
}

export interface UpdateMcpServerInput {
  label?: string | undefined;
  url?: string | undefined;
  enabled?: boolean | undefined;
  authKind?: McpAuthKind | undefined;
  headerName?: string | null | undefined;
  secretCiphertext?: string | null | undefined;
  expectedAuthKind?: McpAuthKind | undefined;
}

export interface UpsertMcpToolInput {
  id: string;
  serverId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface SetToolAllowedWithDraftInput {
  assistantId: string;
  toolId: string;
  toolName: string;
  allowed: boolean;
  keepName: boolean;
  expectedDraft: VersionRow;
  nextConfig: VersionConfig;
}

export interface SyncToolsWithDraftInput {
  assistantId: string;
  serverId: string;
  tools: readonly UpsertMcpToolInput[];
  remoteNames: readonly string[];
  prunedAllowedNames: readonly string[];
  removedFromDraftNames: readonly string[];
  expectedDraft: VersionRow;
  nextConfig: VersionConfig;
  hasDraftChange: boolean;
}

export interface RemoveServerWithDraftInput {
  assistantId: string;
  serverId: string;
  serverAllowedNames: readonly string[];
  removedFromDraftNames: readonly string[];
  expectedDraft: VersionRow;
  nextConfig: VersionConfig;
  hasDraftChange: boolean;
}

const SERVER_COLUMNS =
  "id, org_id, assistant_id, label, url, auth_kind, header_name, secret_ciphertext, enabled, created_at";
const TOOL_COLUMNS = "id, org_id, server_id, name, description, input_schema, allowed";

const mapServer = (row: ServerDbRow): McpServerRow => ({
  id: row.id,
  orgId: row.org_id,
  assistantId: row.assistant_id,
  label: row.label,
  url: row.url,
  authKind: row.auth_kind,
  headerName: row.header_name,
  hasSecret: row.secret_ciphertext !== null,
  enabled: row.enabled === 1,
  createdAt: row.created_at,
});

const mapServerWithStats = (row: ServerWithStatsDbRow): McpServerWithStatsRow => ({
  ...mapServer(row),
  toolCount: Number(row.tool_count ?? 0),
  allowedCount: Number(row.allowed_count ?? 0),
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

const mapAllowedTool = (row: AllowedToolDbRow): McpAllowedToolRow => ({
  id: row.id,
  serverId: row.server_id,
  name: row.name,
  description: row.description,
  inputSchema: safeJsonObject(row.input_schema),
  url: row.url,
  authKind: row.auth_kind,
  headerName: row.header_name,
  label: row.label,
});

function appendOtherServerAllowedGuards(
  params: unknown[],
  removedFromDraftNames: readonly string[],
  retainedNames: readonly string[],
): string {
  let sql = "";
  if (removedFromDraftNames.length > 0) {
    params.push(JSON.stringify([...removedFromDraftNames]));
    sql += ` AND NOT EXISTS (
      SELECT 1 FROM mcp_tools t
      JOIN mcp_servers s ON s.id = t.server_id AND s.org_id = t.org_id
       WHERE t.org_id = ?1 AND s.assistant_id = ?3 AND t.server_id != ?2 AND t.allowed = 1
         AND t.name IN (SELECT value FROM json_each(?${params.length}))
    )`;
  }
  if (retainedNames.length > 0) {
    params.push(JSON.stringify([...retainedNames]));
    sql += ` AND NOT EXISTS (
      SELECT 1 FROM json_each(?${params.length}) req
       WHERE NOT EXISTS (
         SELECT 1 FROM mcp_tools t
         JOIN mcp_servers s ON s.id = t.server_id AND s.org_id = t.org_id
          WHERE t.org_id = ?1 AND s.assistant_id = ?3 AND t.server_id != ?2 AND t.allowed = 1
            AND t.name = req.value
       )
    )`;
  }
  return sql;
}

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

    async listServersWithStats(assistantId: string): Promise<McpServerWithStatsRow[]> {
      const res = await prepare(
        db,
        `SELECT s.id, s.org_id, s.assistant_id, s.label, s.url, s.auth_kind, s.header_name,
                s.secret_ciphertext, s.enabled, s.created_at,
                COUNT(t.id) AS tool_count,
                COALESCE(SUM(t.allowed), 0) AS allowed_count
           FROM mcp_servers s
           LEFT JOIN mcp_tools t ON t.server_id = s.id AND t.org_id = s.org_id
          WHERE s.org_id = ?1 AND s.assistant_id = ?2
          GROUP BY s.id
          ORDER BY s.created_at ASC`,
      )
        .bind(orgId, assistantId)
        .all<ServerWithStatsDbRow>();
      return res.results.map(mapServerWithStats);
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

    async getServerWithStats(id: string): Promise<McpServerWithStatsRow | null> {
      const row = await prepare(
        db,
        `SELECT s.id, s.org_id, s.assistant_id, s.label, s.url, s.auth_kind, s.header_name,
                s.secret_ciphertext, s.enabled, s.created_at,
                COUNT(t.id) AS tool_count,
                COALESCE(SUM(t.allowed), 0) AS allowed_count
           FROM mcp_servers s
           LEFT JOIN mcp_tools t ON t.server_id = s.id AND t.org_id = s.org_id
          WHERE s.org_id = ?1 AND s.id = ?2
          GROUP BY s.id`,
      )
        .bind(orgId, id)
        .first<ServerWithStatsDbRow>();
      return row ? mapServerWithStats(row) : null;
    },

    /**
     * The stored ciphertext for one server.
     *
     * Deliberately a separate method with a name that says what it returns:
     * every other accessor maps to `McpServerRow`, which carries `hasSecret`
     * and never this value, so a list or detail response cannot leak it by
     * accident.
     */
    async readSecretCiphertext(id: string): Promise<string | null> {
      const row = await prepare(
        db,
        "SELECT secret_ciphertext FROM mcp_servers WHERE org_id = ?1 AND id = ?2",
      )
        .bind(orgId, id)
        .first<{ secret_ciphertext: string | null }>();
      return row?.secret_ciphertext ?? null;
    },

    /**
     * Reads the outbound target settings and ciphertext from a single
     * consistent snapshot so endpoint and credential updates never mix.
     */
    async readTargetWithSecretCiphertext(id: string): Promise<McpServerTargetSnapshot | null> {
      const row = await prepare(
        db,
        `SELECT id, assistant_id, url, auth_kind, header_name, secret_ciphertext
           FROM mcp_servers
          WHERE org_id = ?1 AND id = ?2`,
      )
        .bind(orgId, id)
        .first<{
          id: string;
          assistant_id: string;
          url: string;
          auth_kind: McpAuthKind;
          header_name: string | null;
          secret_ciphertext: string | null;
        }>();
      if (!row) return null;
      return {
        id: row.id,
        assistantId: row.assistant_id,
        url: row.url,
        authKind: row.auth_kind,
        headerName: row.header_name,
        secretCiphertext: row.secret_ciphertext,
      };
    },

    /**
     * Sets or clears the credential without touching label, URL or enabled, so
     * an owner editing a label cannot blank a credential by omission.
     */
    async setSecretCiphertext(id: string, ciphertext: string | null): Promise<boolean> {
      const res = await prepare(
        db,
        "UPDATE mcp_servers SET secret_ciphertext = ?3 WHERE org_id = ?1 AND id = ?2",
      )
        .bind(orgId, id, ciphertext)
        .run();
      return (res.meta.changes ?? 0) > 0;
    },

    async createServer(input: CreateMcpServerInput): Promise<McpServerRow> {
      const headerName = input.headerName ?? null;
      await prepareInsert(
        db,
        `INSERT INTO mcp_servers (id, org_id, assistant_id, label, url, auth_kind, header_name, secret_ciphertext, enabled, created_at)
         VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
        .bind(
          orgId,
          input.id,
          input.assistantId,
          input.label,
          input.url,
          input.authKind,
          headerName,
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
        headerName,
        hasSecret: input.secretCiphertext !== null,
        enabled: input.enabled,
        createdAt: input.createdAt,
      };
    },

    async updateServer(id: string, input: UpdateMcpServerInput): Promise<boolean> {
      const sets: string[] = [];
      const params: unknown[] = [orgId, id];
      const pushSet = (column: string, value: unknown) => {
        params.push(value);
        sets.push(`${column} = ?${params.length}`);
      };

      if (input.label !== undefined) pushSet("label", input.label);
      if (input.url !== undefined) pushSet("url", input.url);
      if (input.enabled !== undefined) pushSet("enabled", input.enabled ? 1 : 0);
      if (input.authKind !== undefined) pushSet("auth_kind", input.authKind);
      if (input.headerName !== undefined) pushSet("header_name", input.headerName);
      if (input.secretCiphertext !== undefined) {
        pushSet("secret_ciphertext", input.secretCiphertext);
      }

      if (sets.length === 0) {
        return (await this.getServer(id)) !== null;
      }

      let where = "org_id = ?1 AND id = ?2";
      if (input.expectedAuthKind !== undefined) {
        params.push(input.expectedAuthKind);
        where += ` AND auth_kind = ?${params.length}`;
      }

      const res = await prepare(db, `UPDATE mcp_servers SET ${sets.join(", ")} WHERE ${where}`)
        .bind(...params)
        .run();
      return (res.meta.changes ?? 0) > 0;
    },

    async removeServer(id: string): Promise<boolean> {
      const [, serverRes] = await db.batch([
        prepare(db, "DELETE FROM mcp_tools WHERE org_id = ?1 AND server_id = ?2").bind(orgId, id),
        prepare(db, "DELETE FROM mcp_servers WHERE org_id = ?1 AND id = ?2").bind(orgId, id),
      ]);
      return (serverRes?.meta.changes ?? 0) > 0;
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

    /** Returns whether another allowed tool on the assistant shares `name`. */
    async hasOtherAllowedTool(
      assistantId: string,
      excludeToolId: string,
      name: string,
    ): Promise<boolean> {
      const row = await prepare(
        db,
        `SELECT 1 AS found
           FROM mcp_tools t
           JOIN mcp_servers s ON s.id = t.server_id AND s.org_id = t.org_id
          WHERE t.org_id = ?1 AND s.assistant_id = ?2 AND t.name = ?3 AND t.id != ?4 AND t.allowed = 1
          LIMIT 1`,
      )
        .bind(orgId, assistantId, name, excludeToolId)
        .first<{ found: number }>();
      return row !== null;
    },

    /**
     * Atomically updates `mcp_tools.allowed` and the draft's `config` in one
     * batch, guarded on the draft's stored config and (when disabling) whether
     * another allowed tool on the assistant still requires the name.
     */
    async setToolAllowedWithDraft(input: SetToolAllowedWithDraftInput): Promise<boolean> {
      const expectedConfigJson = expectedVersionConfig(input.expectedDraft);
      const nextConfigJson = JSON.stringify(input.nextConfig);

      const otherSql = input.allowed
        ? ""
        : input.keepName
          ? ` AND EXISTS (
                SELECT 1 FROM mcp_tools t
                JOIN mcp_servers s ON s.id = t.server_id AND s.org_id = t.org_id
                WHERE t.org_id = ?1 AND s.assistant_id = ?3 AND t.name = ?6 AND t.id != ?2 AND t.allowed = 1
              )`
          : ` AND NOT EXISTS (
                SELECT 1 FROM mcp_tools t
                JOIN mcp_servers s ON s.id = t.server_id AND s.org_id = t.org_id
                WHERE t.org_id = ?1 AND s.assistant_id = ?3 AND t.name = ?6 AND t.id != ?2 AND t.allowed = 1
              )`;

      const toolArgs = input.allowed
        ? [orgId, input.toolId, input.assistantId, input.expectedDraft.id, expectedConfigJson]
        : [
            orgId,
            input.toolId,
            input.assistantId,
            input.expectedDraft.id,
            expectedConfigJson,
            input.toolName,
          ];

      const draftArgs = input.allowed
        ? [
            orgId,
            input.toolId,
            input.assistantId,
            input.expectedDraft.id,
            expectedConfigJson,
            nextConfigJson,
          ]
        : [
            orgId,
            input.toolId,
            input.assistantId,
            input.expectedDraft.id,
            expectedConfigJson,
            input.toolName,
            nextConfigJson,
          ];

      const draftNextParam = input.allowed ? "?6" : "?7";
      const [toolRes, draftRes] = await db.batch([
        prepare(
          db,
          `UPDATE mcp_tools
              SET allowed = ${input.allowed ? 1 : 0}
            WHERE org_id = ?1 AND id = ?2
              AND EXISTS (
                SELECT 1 FROM assistant_versions
                 WHERE org_id = ?1 AND assistant_id = ?3 AND id = ?4 AND state = 'draft' AND config = ?5
              )${otherSql}`,
        ).bind(...toolArgs),
        prepare(
          db,
          `UPDATE assistant_versions
              SET config = ${draftNextParam}
            WHERE org_id = ?1 AND assistant_id = ?3 AND state = 'draft' AND id = ?4 AND config = ?5
              AND EXISTS (SELECT 1 FROM mcp_tools WHERE org_id = ?1 AND id = ?2)${otherSql}`,
        ).bind(...draftArgs),
      ]);

      return (toolRes?.meta.changes ?? 0) > 0 && (draftRes?.meta.changes ?? 0) > 0;
    },

    async listPrunedAllowedToolNames(
      serverId: string,
      remoteNames: readonly string[],
    ): Promise<string[]> {
      const res = await prepare(
        db,
        `SELECT DISTINCT name
           FROM mcp_tools
          WHERE org_id = ?1 AND server_id = ?2 AND allowed = 1
            AND name NOT IN (SELECT value FROM json_each(?3))`,
      )
        .bind(orgId, serverId, JSON.stringify([...remoteNames]))
        .all<{ name: string }>();
      return res.results.map((r) => r.name);
    },

    async listServerAllowedToolNames(serverId: string): Promise<string[]> {
      const res = await prepare(
        db,
        `SELECT DISTINCT name
           FROM mcp_tools
          WHERE org_id = ?1 AND server_id = ?2 AND allowed = 1`,
      )
        .bind(orgId, serverId)
        .all<{ name: string }>();
      return res.results.map((r) => r.name);
    },

    async listOtherAllowedToolNames(
      assistantId: string,
      excludeServerId: string,
    ): Promise<Set<string>> {
      const res = await prepare(
        db,
        `SELECT DISTINCT t.name
           FROM mcp_tools t
           JOIN mcp_servers s ON s.id = t.server_id AND s.org_id = t.org_id
          WHERE t.org_id = ?1 AND s.assistant_id = ?2 AND t.server_id != ?3 AND t.allowed = 1`,
      )
        .bind(orgId, assistantId, excludeServerId)
        .all<{ name: string }>();
      return new Set(res.results.map((r) => r.name));
    },

    /**
     * Atomically upserts discovered tools, prunes dropped tools for `serverId`,
     * and reconciles the draft's `allowedTools` when any pruned allowed tool has
     * no remaining allowed counterpart on another server.
     */
    async syncToolsWithDraft(input: SyncToolsWithDraftInput): Promise<boolean> {
      const expectedConfigJson = expectedVersionConfig(input.expectedDraft);
      const remoteJson = JSON.stringify([...input.remoteNames]);
      const prunedAllowedJson = JSON.stringify([...input.prunedAllowedNames]);
      const removedSet = new Set(input.removedFromDraftNames);
      const retainedNames = input.prunedAllowedNames.filter((n) => !removedSet.has(n));
      const toolsJson = JSON.stringify(
        input.tools.map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          inputSchema: JSON.stringify(t.inputSchema),
        })),
      );

      const unexpectedServerAllowedGuard = `NOT EXISTS (
        SELECT 1 FROM mcp_tools
         WHERE org_id = ?1 AND server_id = ?2 AND allowed = 1
           AND name NOT IN (SELECT value FROM json_each(?6))
           AND name NOT IN (SELECT value FROM json_each(?7))
      )`;

      if (!input.hasDraftChange) {
        const verifyArgs: unknown[] = [
          orgId,
          input.serverId,
          input.assistantId,
          input.expectedDraft.id,
          expectedConfigJson,
          remoteJson,
          prunedAllowedJson,
        ];
        const otherServerGuards = appendOtherServerAllowedGuards(
          verifyArgs,
          input.removedFromDraftNames,
          retainedNames,
        );
        const statements: D1PreparedStatement[] = [
          prepare(
            db,
            `DELETE FROM mcp_tools
              WHERE org_id = ?1 AND server_id = ?2
                AND name NOT IN (SELECT value FROM json_each(?6))
                AND EXISTS (
                  SELECT 1 FROM assistant_versions
                   WHERE org_id = ?1 AND assistant_id = ?3 AND id = ?4 AND state = 'draft' AND config = ?5
                )
                AND EXISTS (SELECT 1 FROM mcp_servers WHERE org_id = ?1 AND id = ?2)
                AND ${unexpectedServerAllowedGuard}${otherServerGuards}`,
          ).bind(...verifyArgs),
        ];
        if (input.tools.length > 0) {
          const insertArgs = [...verifyArgs, toolsJson];
          statements.push(
            prepareInsert(
              db,
              `INSERT INTO mcp_tools (id, org_id, server_id, name, description, input_schema, allowed)
               SELECT json_extract(t.value, '$.id'),
                      ?1,
                      ?2,
                      json_extract(t.value, '$.name'),
                      json_extract(t.value, '$.description'),
                      json_extract(t.value, '$.inputSchema'),
                      0
                 FROM json_each(?${insertArgs.length}) t
                WHERE EXISTS (
                        SELECT 1 FROM assistant_versions
                         WHERE org_id = ?1 AND assistant_id = ?3 AND id = ?4 AND state = 'draft' AND config = ?5
                      )
                  AND EXISTS (SELECT 1 FROM mcp_servers WHERE org_id = ?1 AND id = ?2)
                  AND ${unexpectedServerAllowedGuard}${otherServerGuards}
               ON CONFLICT(org_id, server_id, name) DO UPDATE SET
                 description = excluded.description,
                 input_schema = excluded.input_schema`,
            ).bind(...insertArgs),
          );
        }
        statements.push(
          prepare(
            db,
            `SELECT 1 AS ok
               FROM assistant_versions
              WHERE org_id = ?1 AND assistant_id = ?3 AND id = ?4 AND state = 'draft' AND config = ?5
                AND EXISTS (SELECT 1 FROM mcp_servers WHERE org_id = ?1 AND id = ?2)
                AND ${unexpectedServerAllowedGuard}${otherServerGuards}`,
          ).bind(...verifyArgs),
        );
        const results = await db.batch(statements);
        const verifyRes = results[results.length - 1];
        return (verifyRes?.results?.length ?? 0) > 0;
      }

      const nextConfigJson = JSON.stringify(input.nextConfig);
      const updateArgs: unknown[] = [
        orgId,
        input.serverId,
        input.assistantId,
        input.expectedDraft.id,
        expectedConfigJson,
        remoteJson,
        prunedAllowedJson,
        nextConfigJson,
      ];
      const otherServerGuards = appendOtherServerAllowedGuards(
        updateArgs,
        input.removedFromDraftNames,
        retainedNames,
      );
      const statements: D1PreparedStatement[] = [
        prepare(
          db,
          `UPDATE assistant_versions
              SET config = ?8
            WHERE org_id = ?1 AND assistant_id = ?3 AND state = 'draft' AND id = ?4 AND config = ?5
              AND EXISTS (SELECT 1 FROM mcp_servers WHERE org_id = ?1 AND id = ?2)
              AND ${unexpectedServerAllowedGuard}${otherServerGuards}`,
        ).bind(...updateArgs),
        prepare(
          db,
          `DELETE FROM mcp_tools
            WHERE org_id = ?1 AND server_id = ?2
              AND name NOT IN (SELECT value FROM json_each(?5))
              AND EXISTS (
                SELECT 1 FROM assistant_versions
                 WHERE org_id = ?1 AND assistant_id = ?3 AND id = ?4 AND state = 'draft' AND config = ?6
              )`,
        ).bind(
          orgId,
          input.serverId,
          input.assistantId,
          input.expectedDraft.id,
          remoteJson,
          nextConfigJson,
        ),
      ];
      if (input.tools.length > 0) {
        statements.push(
          prepareInsert(
            db,
            `INSERT INTO mcp_tools (id, org_id, server_id, name, description, input_schema, allowed)
             SELECT json_extract(t.value, '$.id'),
                    ?1,
                    ?2,
                    json_extract(t.value, '$.name'),
                    json_extract(t.value, '$.description'),
                    json_extract(t.value, '$.inputSchema'),
                    0
               FROM json_each(?6) t
              WHERE EXISTS (
                      SELECT 1 FROM assistant_versions
                       WHERE org_id = ?1 AND assistant_id = ?3 AND id = ?4 AND state = 'draft' AND config = ?5
                    )
                AND EXISTS (SELECT 1 FROM mcp_servers WHERE org_id = ?1 AND id = ?2)
             ON CONFLICT(org_id, server_id, name) DO UPDATE SET
               description = excluded.description,
               input_schema = excluded.input_schema`,
          ).bind(
            orgId,
            input.serverId,
            input.assistantId,
            input.expectedDraft.id,
            nextConfigJson,
            toolsJson,
          ),
        );
      }
      const [draftRes] = await db.batch(statements);
      return (draftRes?.meta.changes ?? 0) > 0;
    },

    /** Atomically replaces a server's discovered tools when no draft version exists. */
    async replaceServerTools(
      serverId: string,
      tools: readonly UpsertMcpToolInput[],
    ): Promise<boolean> {
      const remoteJson = JSON.stringify(tools.map((t) => t.name));
      const statements: D1PreparedStatement[] = [
        prepare(
          db,
          `DELETE FROM mcp_tools
            WHERE org_id = ?1 AND server_id = ?2
              AND name NOT IN (SELECT value FROM json_each(?3))`,
        ).bind(orgId, serverId, remoteJson),
      ];
      if (tools.length > 0) {
        statements.push(
          prepareInsert(
            db,
            `INSERT INTO mcp_tools (id, org_id, server_id, name, description, input_schema, allowed)
             SELECT json_extract(t.value, '$.id'),
                    ?1,
                    ?2,
                    json_extract(t.value, '$.name'),
                    json_extract(t.value, '$.description'),
                    json_extract(t.value, '$.inputSchema'),
                    0
               FROM json_each(?3) t
              WHERE EXISTS (SELECT 1 FROM mcp_servers WHERE org_id = ?1 AND id = ?2)
             ON CONFLICT(org_id, server_id, name) DO UPDATE SET
               description = excluded.description,
               input_schema = excluded.input_schema`,
          ).bind(
            orgId,
            serverId,
            JSON.stringify(
              tools.map((t) => ({
                id: t.id,
                name: t.name,
                description: t.description,
                inputSchema: JSON.stringify(t.inputSchema),
              })),
            ),
          ),
        );
      }
      statements.push(
        prepare(db, "SELECT 1 AS ok FROM mcp_servers WHERE org_id = ?1 AND id = ?2").bind(
          orgId,
          serverId,
        ),
      );
      const results = await db.batch(statements);
      const verifyRes = results[results.length - 1];
      return (verifyRes?.results?.length ?? 0) > 0;
    },

    /**
     * Atomically deletes a server, its tools, and reconciles the draft's
     * `allowedTools` when any of its allowed tools has no remaining allowed
     * counterpart on another server.
     */
    async removeServerWithDraft(input: RemoveServerWithDraftInput): Promise<boolean> {
      const expectedConfigJson = expectedVersionConfig(input.expectedDraft);
      const serverAllowedJson = JSON.stringify([...input.serverAllowedNames]);
      const removedSet = new Set(input.removedFromDraftNames);
      const retainedNames = input.serverAllowedNames.filter((n) => !removedSet.has(n));

      const unexpectedServerAllowedGuard = `NOT EXISTS (
        SELECT 1 FROM mcp_tools
         WHERE org_id = ?1 AND server_id = ?2 AND allowed = 1
           AND name NOT IN (SELECT value FROM json_each(?6))
      )`;

      if (!input.hasDraftChange) {
        const guardArgs: unknown[] = [
          orgId,
          input.serverId,
          input.assistantId,
          input.expectedDraft.id,
          expectedConfigJson,
          serverAllowedJson,
        ];
        const otherServerGuards = appendOtherServerAllowedGuards(
          guardArgs,
          input.removedFromDraftNames,
          retainedNames,
        );
        const [, serverRes] = await db.batch([
          prepare(
            db,
            `DELETE FROM mcp_tools
              WHERE org_id = ?1 AND server_id = ?2
                AND EXISTS (
                  SELECT 1 FROM assistant_versions
                   WHERE org_id = ?1 AND assistant_id = ?3 AND id = ?4 AND state = 'draft' AND config = ?5
                )
                AND ${unexpectedServerAllowedGuard}${otherServerGuards}`,
          ).bind(...guardArgs),
          prepare(
            db,
            `DELETE FROM mcp_servers
              WHERE org_id = ?1 AND id = ?2
                AND EXISTS (
                  SELECT 1 FROM assistant_versions
                   WHERE org_id = ?1 AND assistant_id = ?3 AND id = ?4 AND state = 'draft' AND config = ?5
                )
                AND NOT EXISTS (SELECT 1 FROM mcp_tools WHERE org_id = ?1 AND server_id = ?2)`,
          ).bind(
            orgId,
            input.serverId,
            input.assistantId,
            input.expectedDraft.id,
            expectedConfigJson,
          ),
        ]);
        return (serverRes?.meta.changes ?? 0) > 0;
      }

      const nextConfigJson = JSON.stringify(input.nextConfig);
      const updateArgs: unknown[] = [
        orgId,
        input.serverId,
        input.assistantId,
        input.expectedDraft.id,
        expectedConfigJson,
        serverAllowedJson,
        nextConfigJson,
      ];
      const otherServerGuards = appendOtherServerAllowedGuards(
        updateArgs,
        input.removedFromDraftNames,
        retainedNames,
      );
      const [draftRes, , serverRes] = await db.batch([
        prepare(
          db,
          `UPDATE assistant_versions
              SET config = ?7
            WHERE org_id = ?1 AND assistant_id = ?3 AND state = 'draft' AND id = ?4 AND config = ?5
              AND EXISTS (SELECT 1 FROM mcp_servers WHERE org_id = ?1 AND id = ?2)
              AND ${unexpectedServerAllowedGuard}${otherServerGuards}`,
        ).bind(...updateArgs),
        prepare(
          db,
          `DELETE FROM mcp_tools
            WHERE org_id = ?1 AND server_id = ?2
              AND EXISTS (
                SELECT 1 FROM assistant_versions
                 WHERE org_id = ?1 AND assistant_id = ?3 AND id = ?4 AND state = 'draft' AND config = ?5
              )`,
        ).bind(orgId, input.serverId, input.assistantId, input.expectedDraft.id, nextConfigJson),
        prepare(
          db,
          `DELETE FROM mcp_servers
            WHERE org_id = ?1 AND id = ?2
              AND EXISTS (
                SELECT 1 FROM assistant_versions
                 WHERE org_id = ?1 AND assistant_id = ?3 AND id = ?4 AND state = 'draft' AND config = ?5
              )
              AND NOT EXISTS (SELECT 1 FROM mcp_tools WHERE org_id = ?1 AND server_id = ?2)`,
        ).bind(orgId, input.serverId, input.assistantId, input.expectedDraft.id, nextConfigJson),
      ]);
      return (draftRes?.meta.changes ?? 0) > 0 && (serverRes?.meta.changes ?? 0) > 0;
    },

    /**
     * Drops tools the server no longer offers. Refresh upserts what is there
     * and then calls this, rather than deleting everything first: deleting
     * would lose the `allowed` flag on every refresh.
     */
    async removeToolsNotIn(serverId: string, names: readonly string[]): Promise<number> {
      const res = await prepare(
        db,
        `DELETE FROM mcp_tools
          WHERE org_id = ?1 AND server_id = ?2
            AND name NOT IN (SELECT value FROM json_each(?3))`,
      )
        .bind(orgId, serverId, JSON.stringify([...names]))
        .run();
      return res.meta.changes ?? 0;
    },

    async getToolByName(serverId: string, name: string): Promise<McpToolRow | null> {
      const row = await prepare(
        db,
        `SELECT ${TOOL_COLUMNS} FROM mcp_tools WHERE org_id = ?1 AND server_id = ?2 AND name = ?3`,
      )
        .bind(orgId, serverId, name)
        .first<ToolDbRow>();
      return row ? mapTool(row) : null;
    },

    /**
     * Every switched-on tool of every enabled server for one assistant, with
     * the server it belongs to.
     */
    async listAllowedTools(assistantId: string): Promise<McpAllowedToolRow[]> {
      const res = await prepare(
        db,
        `SELECT t.id, t.server_id, t.name, t.description, t.input_schema,
                s.url, s.auth_kind, s.header_name, s.label
           FROM mcp_tools t
           JOIN mcp_servers s ON s.id = t.server_id AND s.org_id = t.org_id
          WHERE t.org_id = ?1 AND s.assistant_id = ?2 AND t.allowed = 1 AND s.enabled = 1
          ORDER BY s.created_at ASC, t.name ASC`,
      )
        .bind(orgId, assistantId)
        .all<AllowedToolDbRow>();
      return res.results.map(mapAllowedTool);
    },
  };
}
