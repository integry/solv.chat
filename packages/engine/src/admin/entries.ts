import { formatEntryMarkdown, newId, parseEntryInput } from "@solvchat/core";
import type { Tenant } from "../db/tenant.js";
import { type IngestCounts, type PushDeps, pushDocuments } from "../ingest/documents.js";
import { BadRequest, NotFound } from "./errors.js";

const textEncoder = new TextEncoder();

async function shortHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/**
 * Finds or lazily creates the single `entry` source for an assistant, so an
 * owner who never writes an answer has no empty source cluttering Sources.
 */
export async function ensureEntrySource(tenant: Tenant, assistantId: string): Promise<string> {
  const existing = await tenant.sources.getFirstByKind(assistantId, "entry");
  if (existing !== null) return existing.id;

  const created = await tenant.sources.create({
    id: newId("src"),
    assistantId,
    kind: "entry",
    label: "Answers you wrote",
    settings: {},
    createdAt: Date.now(),
  });
  return created.id;
}

export interface EntryDeps extends PushDeps {
  publicBaseUrl: string;
}

export interface SaveEntryArgs {
  assistantId: string;
  sourceId?: string;
  documentId?: string;
  question: string;
  answer: string;
}

export interface SaveEntryResult {
  documentId: string;
  sourceId: string;
  url: string;
  counts: IngestCounts;
}

/**
 * Creates or updates a hand-written entry.
 *
 * The answer goes through `pushDocuments` rather than writing chunks directly:
 * one ingest path means an entry gets content hashing, R2 storage and the
 * Queue consumer without any of that being reimplemented here.
 */
export async function saveEntry(
  deps: EntryDeps,
  principal: { orgId: string },
  args: SaveEntryArgs,
): Promise<SaveEntryResult> {
  const parsed = parseEntryInput({ question: args.question, answer: args.answer });
  if (!parsed.ok) throw new BadRequest(parsed.errors);

  const assistant = await deps.tenant.assistants.get(args.assistantId);
  if (assistant === null) throw new NotFound("assistant");

  let sourceId = args.sourceId;
  if (sourceId !== undefined) {
    const source = await deps.tenant.sources.get(sourceId);
    if (source === null || source.assistantId !== args.assistantId) {
      throw new NotFound("source");
    }
    if (source.kind !== "entry") {
      throw new BadRequest(["source: entries can only be saved in an entry source"]);
    }
  } else {
    sourceId = await ensureEntrySource(deps.tenant, args.assistantId);
  }

  let externalId: string;
  let url: string;

  if (args.documentId !== undefined) {
    const existing = await deps.tenant.documents.get(args.documentId);
    if (existing === null || existing.sourceId !== sourceId) {
      throw new NotFound("document");
    }
    // Keep externalId and URL stable across edits, even if the question changes.
    externalId = existing.externalId;
    url = existing.url;
  } else {
    const baseExternalId = `entry:${await shortHash(parsed.value.question)}`;
    let candidate = baseExternalId;
    for (let suffix = 2; ; suffix++) {
      const existing = await deps.tenant.documents.getByExternalId(sourceId, candidate);
      if (existing === null || existing.title === parsed.value.question) {
        externalId = candidate;
        break;
      }
      // The document that originally held this question-derived ID was renamed;
      // probe a deterministic suffix so retries preserve the same identity.
      candidate = `${baseExternalId}:${suffix}`;
    }
    const baseUrl = deps.publicBaseUrl.replace(/\/+$/, "");
    url = `${baseUrl}/admin/sources#${externalId}`;
  }

  const markdown = formatEntryMarkdown(parsed.value.question, parsed.value.answer);
  const counts = await pushDocuments(
    deps,
    { orgId: principal.orgId, assistantId: args.assistantId },
    {
      sourceId,
      documents: [
        {
          externalId,
          url,
          title: parsed.value.question,
          markdown,
        },
      ],
    },
  );

  const saved = await deps.tenant.documents.getByExternalId(sourceId, externalId);
  if (saved === null) {
    throw new Error(`failed to resolve saved entry ${externalId}`);
  }

  return {
    documentId: saved.id,
    sourceId,
    url: saved.url,
    counts,
  };
}
