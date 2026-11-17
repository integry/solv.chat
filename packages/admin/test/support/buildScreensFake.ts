import { defaultVersionConfig, parseVersionConfig } from "@solvchat/core";
import { vi } from "vitest";
import type { Assistant, InstallInfo, VersionRow } from "../../src/api/types.js";

export function makeAssistant(id: string, name: string, allowedOrigins: string[] = []): Assistant {
  return {
    id,
    orgId: "org_00000000000000000000",
    name,
    publicKey: `pk_${id}`,
    allowedOrigins,
    hasIngestKey: true,
    createdAt: 1_700_000_000_000,
  };
}

export interface BuildScreensFakeOptions {
  assistants?: Assistant[];
  lastSeen?: InstallInfo["lastSeen"];
  /** Paths answered with a 500 until `recover()` is called. */
  failing?: string[];
}

/**
 * A small admin API for the Behaviour, Widget and Install screens: assistants,
 * draft, versions, publish, install and ingest-key rotation.
 */
export function installBuildScreensFake(options: BuildScreensFakeOptions = {}) {
  const assistants = options.assistants ?? [
    makeAssistant("ast_1", "Docs Bot", ["https://docs.example.com"]),
  ];
  const drafts = new Map<string, VersionRow>();
  for (const a of assistants) {
    const config = defaultVersionConfig();
    config.behaviour.suggestedQuestions = ["First?", "Second?", "Third?"];
    drafts.set(a.id, {
      id: `ver_draft_${a.id}`,
      orgId: a.orgId,
      assistantId: a.id,
      state: "draft",
      config,
      createdAt: 1_700_000_000_000,
      publishedAt: null,
    });
  }
  let failing = new Set(options.failing ?? []);
  const calls: Array<{ method: string; path: string; body: unknown }> = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const path = new URL(url, "https://example.com").pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    calls.push({ method, path, body });

    if (failing.has(path)) {
      return Response.json({ error: "The server had a problem." }, { status: 500 });
    }
    if (path === "/api/admin/assistants" && method === "GET") {
      return Response.json({ assistants });
    }
    const m = /^\/api\/admin\/assistants\/([^/]+)(?:\/(.*))?$/.exec(path);
    const assistant = m ? assistants.find((a) => a.id === m[1]) : undefined;
    if (m && assistant) {
      const sub = m[2] ?? "";
      const draft = drafts.get(assistant.id);
      if (sub === "" && method === "GET") return Response.json({ assistant });
      if (sub === "" && method === "PATCH") {
        const b = body as { allowedOrigins: string[] };
        assistant.allowedOrigins = b.allowedOrigins;
        return Response.json({ assistant });
      }
      if (sub === "draft" && draft && method === "GET") return Response.json({ draft });
      if (sub === "draft" && draft && method === "PUT") {
        const parsed = parseVersionConfig(body, draft.config);
        if (!parsed.ok) {
          return Response.json({ error: "Invalid.", fields: parsed.errors }, { status: 400 });
        }
        draft.config = parsed.value;
        return Response.json({ draft });
      }
      if (sub === "versions") return Response.json({ versions: draft ? [draft] : [] });
      if (sub === "install") {
        const info: InstallInfo = {
          assistantId: assistant.id,
          publicKey: assistant.publicKey,
          allowedOrigins: assistant.allowedOrigins,
          snippet: `<script src="https://example.com/widget.js" defer></script>\n<solv-chat assistant="${assistant.publicKey}"></solv-chat>`,
          lastSeen: options.lastSeen ?? null,
        };
        return Response.json(info);
      }
      if (sub === "ingest-key" && method === "POST") {
        return Response.json({ ingestKey: "ik_rotated_once" });
      }
      if (sub === "overview") {
        return Response.json({
          messages: 0,
          answeredShare: 0,
          topQuestions: [],
          todayCostMicros: 0,
        });
      }
    }
    return Response.json({ error: "Not found." }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);

  return {
    calls,
    drafts,
    recover() {
      failing = new Set();
    },
  };
}
