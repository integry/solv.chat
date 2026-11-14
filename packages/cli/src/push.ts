import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CliError, normalizeEndpoint, requestJson } from "./http.js";
import { externalIdFor, firstHeading, markdownFiles, splitFrontMatter } from "./markdown.js";

// One request per 50 documents: the ingest API caps a batch at 100, and staying
// under it leaves room for the API to lower the cap without breaking older
// CLIs in the middle of a deploy.
export const BATCH_SIZE = 50;

export interface PushDocument {
  externalId?: unknown;
  url?: unknown;
  title?: unknown;
  markdown?: unknown;
  [key: string]: unknown;
}

export interface PushOptions {
  dir?: string;
  json?: string;
  endpoint: string;
  assistant: string;
  baseUrl?: string;
  sourceId?: string;
  ingestKey?: string;
  prune?: boolean;
  dryRun?: boolean;
}

export interface CliDeps {
  fetchImpl: typeof fetch;
  log: (line: string) => void;
}

interface IngestCounts {
  written: number;
  unchanged: number;
  deleted: number;
}

function resolveDocumentUrl(externalId: string, baseUrl: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(externalId, normalizedBase).href;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadFromDir(dir: string, baseUrl: string): Promise<PushDocument[]> {
  const root = resolve(dir);
  const files = await markdownFiles(root);
  const documents: PushDocument[] = [];

  for (const file of files) {
    const { frontMatter, body } = splitFrontMatter(await readFile(file, "utf8"));
    const externalId = externalIdFor(root, file);
    documents.push({
      externalId,
      // Front matter wins over the first heading: an author who wrote an
      // explicit title meant it, and headings are often shorter than the
      // page's real name.
      title: frontMatter.title ?? firstHeading(body) ?? externalId,
      url: resolveDocumentUrl(externalId, baseUrl),
      markdown: body,
    });
  }

  return documents;
}

async function loadFromJson(file: string, baseUrl?: string): Promise<PushDocument[]> {
  const raw = await readFile(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(`Invalid JSON in ${file}`);
  }

  const list = Array.isArray(parsed)
    ? parsed
    : isPlainObject(parsed) && Array.isArray(parsed.documents)
      ? parsed.documents
      : null;

  if (list === null) {
    throw new CliError("JSON batch must be an array or an object with a documents array");
  }

  return list.map((item) => {
    if (
      isPlainObject(item) &&
      item.url === undefined &&
      baseUrl !== undefined &&
      typeof item.externalId === "string"
    ) {
      return { ...item, url: resolveDocumentUrl(item.externalId, baseUrl) };
    }
    return item as PushDocument;
  });
}

/**
 * Reads Markdown files (or a prepared JSON batch) and pushes them to the
 * ingest API in batches, optionally pruning removed pages at the end.
 */
export async function push(options: PushOptions, deps: CliDeps): Promise<void> {
  let documents: PushDocument[];
  if (options.json !== undefined) {
    documents = await loadFromJson(options.json, options.baseUrl);
  } else if (options.dir !== undefined) {
    if (!options.baseUrl) {
      throw new CliError("--base-url is required when pushing a Markdown folder");
    }
    documents = await loadFromDir(options.dir, options.baseUrl);
  } else {
    throw new CliError("Provide a content directory or --json <file>");
  }

  if (options.dryRun) {
    // Print and stop. A dry run that posted anything would be useless for its
    // one job: checking a push before letting CI do it.
    deps.log(`${documents.length} documents would be pushed`);
    for (const doc of documents) {
      const id = typeof doc.externalId === "string" ? doc.externalId : "(unknown)";
      const url = typeof doc.url === "string" ? doc.url : "(no url)";
      deps.log(`  ${id} -> ${url}`);
    }
    if (options.prune) {
      deps.log(`Would prune documents not in the ${documents.length}-document pushed set`);
    }
    return;
  }

  if (!options.ingestKey) {
    throw new CliError("Missing SOLV_INGEST_KEY environment variable");
  }

  const endpoint = normalizeEndpoint(options.endpoint);
  const url = `${endpoint}/v1/ingest/${encodeURIComponent(options.assistant)}/documents`;
  const headers = {
    Authorization: `Bearer ${options.ingestKey}`,
    "Content-Type": "application/json",
  };

  let written = 0;
  let unchanged = 0;

  for (let i = 0; i < documents.length; i += BATCH_SIZE) {
    const batch = documents.slice(i, i + BATCH_SIZE);
    const body = options.sourceId
      ? { sourceId: options.sourceId, documents: batch }
      : { documents: batch };
    const res = await requestJson<IngestCounts>(
      deps.fetchImpl,
      url,
      { method: "PUT", headers, body: JSON.stringify(body) },
      "SOLV_INGEST_KEY",
    );
    written += res.written;
    unchanged += res.unchanged;
  }

  deps.log(`Pushed ${documents.length} documents (${written} written, ${unchanged} unchanged)`);

  if (options.prune) {
    // Prune last and with the full set, never per batch: pruning against a
    // partial list would delete pages a later batch was about to push.
    const keep = documents
      .map((doc) => doc.externalId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    const pruneBody = options.sourceId
      ? { sourceId: options.sourceId, prune: true, keep }
      : { prune: true, keep };
    const res = await requestJson<IngestCounts>(
      deps.fetchImpl,
      url,
      { method: "DELETE", headers, body: JSON.stringify(pruneBody) },
      "SOLV_INGEST_KEY",
    );
    deps.log(`Pruned ${res.deleted} documents`);
  }
}
