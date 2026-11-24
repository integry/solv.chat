import { isPlainObject } from "@solvchat/core";
import type { OperatorPrincipal, Principal } from "../seams/types.js";
import { sha256Hex } from "../util/crypto.js";

const MINUTE = 60_000;
export const ACCESS_TTL_SECONDS = 15 * 60;
export const GRANT_TTL = 30 * 24 * 60 * MINUTE;
export const CODE_TTL = 5 * MINUTE;

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function randomCredential(prefix: string): string {
  return prefix + base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export function privateJson(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", pragma: "no-cache" },
  });
}

export function operatorCredentials(db: D1Database, orgId: string, userId: string) {
  return {
    async authenticate(request: Request, resource: string): Promise<OperatorPrincipal | null> {
      const bearer = /^Bearer (solv_(?:pat|access)_[\w-]{43})$/i.exec(
        request.headers.get("authorization") ?? "",
      )?.[1];
      if (!bearer) return null;
      const now = Date.now();
      const row = await db
        .prepare(`
        WITH RECURSIVE chain(id, parent_id, expires_at) AS (
          SELECT id, parent_id, expires_at FROM operator_grants
          WHERE org_id = ?1 AND user_id = ?2 AND resource = ?3 AND access_hash = ?4
          UNION ALL
          SELECT g.id, g.parent_id, g.expires_at FROM operator_grants g
          JOIN chain c ON g.id = c.parent_id WHERE g.org_id = ?1 AND g.user_id = ?2 AND g.resource = ?3
        )
        UPDATE operator_grants SET last_used_at = ?5
        WHERE org_id = ?1 AND user_id = ?2 AND resource = ?3 AND access_hash = ?4
          AND (access_expires_at IS NULL OR access_expires_at > ?5)
          AND NOT EXISTS (SELECT 1 FROM chain WHERE expires_at <= ?5)
        RETURNING id, scope
      `)
        .bind(orgId, userId, resource, await sha256Hex(bearer), now)
        .first<{
          id: string;
          scope: OperatorPrincipal["scope"];
        }>();
      return row
        ? { principal: { orgId, userId, role: "owner" }, scope: row.scope, credentialId: row.id }
        : null;
    },

    async checkCall(principal: OperatorPrincipal): Promise<boolean> {
      const window = Math.floor(Date.now() / MINUTE);
      const row = await db
        .prepare(`
        UPDATE operator_grants
        SET call_count = CASE WHEN call_window = ?4 THEN call_count + 1 ELSE 1 END, call_window = ?4
        WHERE org_id = ?1 AND user_id = ?2 AND id = ?3
          AND (call_window <> ?4 OR call_count < 120)
        RETURNING id
      `)
        .bind(orgId, principal.principal.userId, principal.credentialId ?? "", window)
        .first();
      return row !== null;
    },

    async manage(
      principal: Principal,
      operation: "list" | "create" | "revoke",
      resource: string,
      input?: unknown,
      credentialId?: string,
    ): Promise<Response> {
      if (principal.orgId !== orgId || principal.userId !== userId) {
        return privateJson({ error: "Access denied." }, 403);
      }
      await db
        .prepare("DELETE FROM operator_grants WHERE org_id = ? AND expires_at <= ?")
        .bind(orgId, Date.now())
        .run();
      if (operation === "list") {
        const { results } = await db
          .prepare(`
          SELECT id, name, scope, created_at AS createdAt, last_used_at AS lastUsedAt,
            CASE WHEN client_id IS NULL THEN 'token' ELSE 'connection' END AS kind
          FROM operator_grants WHERE org_id = ? AND user_id = ? AND resource = ? AND code_hash IS NULL
          ORDER BY created_at DESC, id
        `)
          .bind(orgId, userId, resource)
          .all();
        return privateJson({ access: results });
      }
      if (operation === "revoke") {
        const row = await db
          .prepare(`
          DELETE FROM operator_grants WHERE org_id = ? AND user_id = ? AND resource = ? AND id = ?
          RETURNING id
        `)
          .bind(orgId, userId, resource, typeof input === "string" ? input : "")
          .first();
        return row
          ? privateJson({ revoked: true })
          : privateJson({ error: "Access was not found." }, 404);
      }
      if (
        !isPlainObject(input) ||
        typeof input.name !== "string" ||
        !input.name.trim() ||
        input.name.trim().length > 80 ||
        (input.scope !== "read" && input.scope !== "full")
      ) {
        return privateJson(
          { error: "Enter a name of 1–80 characters and choose Read only or Full access." },
          400,
        );
      }
      const id = crypto.randomUUID();
      const token = randomCredential("solv_pat_");
      const createdAt = Date.now();
      const row = await db
        .prepare(`
        WITH RECURSIVE ancestors(id, parent_id, depth) AS (
          SELECT id, parent_id, 1 FROM operator_grants WHERE org_id = ?1 AND user_id = ?3 AND id = ?9
          UNION ALL
          SELECT g.id, g.parent_id, a.depth + 1 FROM operator_grants g
          JOIN ancestors a ON a.parent_id = g.id WHERE g.org_id = ?1 AND g.user_id = ?3
        )
        INSERT INTO operator_grants (org_id, id, user_id, name, scope, resource, access_hash, created_at, parent_id)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
        WHERE ?9 IS NULL OR EXISTS (SELECT 1 FROM ancestors WHERE parent_id IS NULL AND depth < 16)
        RETURNING id
      `)
        .bind(
          orgId,
          id,
          userId,
          input.name.trim(),
          input.scope,
          resource,
          await sha256Hex(token),
          createdAt,
          credentialId ?? null,
        )
        .first();
      if (!row)
        return privateJson(
          { error: "Create this token from the admin screen or a directly connected client." },
          409,
        );
      return privateJson(
        { id, token, name: input.name.trim(), scope: input.scope, createdAt },
        201,
      );
    },
  };
}
