import { readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { isPlainObject } from "@solvchat/core";
import {
  cleanDocusaurusMarkdown,
  docusaurusBaseId,
  docusaurusSlug,
  hasDocusaurusFrontMatter,
  hasDocusaurusSyntax,
  withDescription,
} from "./docusaurus.js";
import { selectPaths } from "./glob.js";
import { assertValidHeaderValue, CliError, normalizeEndpoint, requestJson } from "./http.js";
import {
  externalIdFor,
  firstHeading,
  frontMatterBlock,
  markdownFiles,
  readFrontMatterString,
  splitFrontMatter,
} from "./markdown.js";

// One request per 10 documents, sized to Workers Free rather than the ingest
// API's cap of 100. Cloudflare counts calls to R2 and D1 as subrequests, and
// Free allows "50/request" ("10,000/request" on Paid). A changed document
// costs an R2 put, a D1 upsert and a queue send, plus a few fixed lookups per
// request, so ten documents stay under 50 with room to spare; this is the same
// accounting the sitemap import uses for its five-page batches. Ingest has no
// rate limit, so more, smaller requests cost nothing else.
// Source: https://developers.cloudflare.com/workers/platform/limits/ — checked 2026-11-14
export const BATCH_SIZE = 10;

export interface PushDocument {
  externalId?: unknown;
  url?: unknown;
  title?: unknown;
  markdown?: unknown;
  [key: string]: unknown;
}

/** A single file pushed from outside the folder, with its own URL. */
export interface ExtraFile {
  path: string;
  url: string;
}

export interface PushOptions {
  dir?: string;
  json?: string;
  endpoint: string;
  assistant: string;
  baseUrl?: string;
  sourceId?: string;
  /** Names the push source; `--prune` then deletes only that source's documents. */
  source?: string;
  /** Globs (relative to `dir`) selecting files; all Markdown files when empty. */
  include?: string[];
  /** Globs (relative to `dir`) of files to leave out. */
  exclude?: string[];
  /** Files outside the folder, each with an explicit URL. */
  files?: ExtraFile[];
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
  const encodedPath = externalId.split("/").map(encodeURIComponent).join("/");
  return new URL(encodedPath, normalizedBase).href;
}

/** Joins a Docusaurus slug (`/guides/intro`, `/` for the root) to the docs' base URL. */
function resolveSlugUrl(slug: string, baseUrl: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const path = slug.replace(/^\/+/, "");
  if (path === "") return new URL(normalizedBase).href;
  return new URL(path.split("/").map(encodeURIComponent).join("/"), normalizedBase).href;
}

interface SourceFile {
  file: string;
  /** Path under the folder with `/` separators and its extension. */
  rel: string;
  raw: string;
  block: string | null;
  body: string;
}

function looksLikeDocusaurus(entry: SourceFile): boolean {
  return (
    extname(entry.file).toLowerCase() === ".mdx" ||
    hasDocusaurusFrontMatter(entry.block) ||
    hasDocusaurusSyntax(entry.body)
  );
}

function readKey(block: string | null, key: string): string | undefined {
  if (block === null) return undefined;
  const value = readFrontMatterString(block, key)?.trim();
  return value === undefined || value === "" ? undefined : value;
}

async function readSource(file: string, rel: string): Promise<SourceFile> {
  const raw = await readFile(file, "utf8");
  const { block, body } = frontMatterBlock(raw);
  return { file, rel, raw, block, body };
}

/**
 * A Docusaurus document: front matter `title`, then `sidebar_label`, then the
 * first heading names it; `description` leads the body; the body is cleaned
 * of MDX and admonition syntax.
 */
function docusaurusDocument(
  entry: SourceFile,
  externalId: string,
  url: (relPath: string, fm: { id?: string; slug?: string }) => string,
): PushDocument {
  const relPath = entry.rel.replace(/\.[^./]+$/, "");
  const fm: { id?: string; slug?: string } = {};
  const id = readKey(entry.block, "id");
  const slug = readKey(entry.block, "slug");
  if (id !== undefined) fm.id = id;
  if (slug !== undefined) fm.slug = slug;
  const cleaned = cleanDocusaurusMarkdown(entry.body);
  return {
    externalId,
    title:
      readKey(entry.block, "title") ??
      readKey(entry.block, "sidebar_label") ??
      firstHeading(cleaned) ??
      docusaurusBaseId(relPath, fm),
    url: url(relPath, fm),
    markdown: withDescription(cleaned, readKey(entry.block, "description")),
  };
}

/** A plain Markdown document, exactly as `solv push` has always built it. */
function plainDocument(entry: SourceFile, externalId: string, url: string): PushDocument {
  const { frontMatter, body } = splitFrontMatter(entry.raw);
  return {
    externalId,
    // Front matter wins over the first heading: an author who wrote an
    // explicit title meant it, and headings are often shorter than the
    // page's real name.
    title: frontMatter.title ?? firstHeading(body) ?? externalId,
    url,
    markdown: body,
  };
}

interface Loaded {
  documents: PushDocument[];
  docusaurus: boolean;
}

async function loadFromDir(
  dir: string,
  baseUrl: string,
  include: readonly string[],
  exclude: readonly string[],
): Promise<Loaded> {
  const root = resolve(dir);
  const all = await markdownFiles(root);
  const relOf = new Map(all.map((file) => [relative(root, file).split(/[\\/]/).join("/"), file]));
  // One file at a time, as before: a large folder must not run out of file handles.
  const allEntries: SourceFile[] = [];
  for (const [rel, file] of relOf) allEntries.push(await readSource(file, rel));
  const selected = new Set(selectPaths([...relOf.keys()], include, exclude));
  const entries = allEntries.filter((entry) => selected.has(entry.rel));

  // Decided for the whole folder, before --include and --exclude: a page
  // without front matter still needs its number prefixes stripped like the
  // rest, and choosing fewer files must not change any file's URL.
  const docusaurus = allEntries.some(looksLikeDocusaurus);
  const documents: PushDocument[] = [];
  const seen = new Map<string, string>();

  for (const entry of entries) {
    const externalId = externalIdFor(root, entry.file);
    const normalizedId = externalId.trim();
    const existing = seen.get(normalizedId);
    if (existing !== undefined) {
      throw new CliError(
        `Duplicate document ID "${normalizedId}" generated from "${relative(root, existing)}" and "${relative(root, entry.file)}"`,
      );
    }
    seen.set(normalizedId, entry.file);

    documents.push(
      docusaurus
        ? docusaurusDocument(entry, externalId, (relPath, fm) =>
            resolveSlugUrl(docusaurusSlug(relPath, fm), baseUrl),
          )
        : plainDocument(entry, externalId, resolveDocumentUrl(externalId, baseUrl)),
    );
  }

  return { documents, docusaurus };
}

/**
 * The external id of a `--file`: its path relative to the working directory,
 * with `/` separators, so the same command in any checkout gives the same id.
 */
export function extraFileId(path: string, cwd: string = process.cwd()): string {
  return relative(cwd, resolve(cwd, path)).split(/[\\/]/).join("/");
}

/**
 * Loads `--file` documents. Each is read on its own: Docusaurus cleanup
 * applies only when that file itself uses Docusaurus syntax or front matter,
 * and its URL is always the one given.
 */
async function loadExtraFiles(files: readonly ExtraFile[]): Promise<PushDocument[]> {
  const documents: PushDocument[] = [];
  for (const extra of files) {
    const externalId = extraFileId(extra.path);
    let entry: SourceFile;
    try {
      entry = await readSource(extra.path, externalId);
    } catch {
      throw new CliError(`Cannot read --file ${extra.path}`);
    }
    documents.push(
      looksLikeDocusaurus(entry)
        ? docusaurusDocument(entry, externalId, () => extra.url)
        : plainDocument(entry, externalId, extra.url),
    );
  }
  return documents;
}

function assertUniqueIds(documents: PushDocument[]): void {
  const seen = new Set<string>();
  for (const doc of documents) {
    if (typeof doc.externalId !== "string") continue;
    const id = doc.externalId.trim();
    if (seen.has(id)) {
      throw new CliError(
        `Duplicate document ID "${id}": a --file has the same ID as another document`,
      );
    }
    seen.add(id);
  }
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
  let docusaurus = false;
  if (options.json !== undefined) {
    documents = await loadFromJson(options.json, options.baseUrl);
  } else if (options.dir !== undefined || (options.files?.length ?? 0) > 0) {
    documents = [];
    if (options.dir !== undefined) {
      if (!options.baseUrl) {
        throw new CliError("--base-url is required when pushing a Markdown folder");
      }
      const loaded = await loadFromDir(
        options.dir,
        options.baseUrl,
        options.include ?? [],
        options.exclude ?? [],
      );
      documents = loaded.documents;
      docusaurus = loaded.docusaurus;
    }
    documents.push(...(await loadExtraFiles(options.files ?? [])));
    assertUniqueIds(documents);
  } else {
    throw new CliError("Provide a content directory, --file <path>=<url> or --json <file>");
  }

  const target = options.source !== undefined ? { source: options.source } : {};
  if (docusaurus) {
    deps.log("Docusaurus content found: using its URLs, titles and cleanup");
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
      deps.log(
        options.source !== undefined
          ? `Would prune documents of source "${options.source}" not in the ${documents.length}-document pushed set`
          : `Would prune documents not in the ${documents.length}-document pushed set`,
      );
    }
    return;
  }

  if (!options.ingestKey) {
    throw new CliError("Missing SOLV_INGEST_KEY environment variable");
  }

  const endpoint = normalizeEndpoint(options.endpoint);
  const url = `${endpoint}/v1/ingest/${encodeURIComponent(options.assistant)}/documents`;
  const authHeader = `Bearer ${options.ingestKey}`;
  assertValidHeaderValue("Authorization", authHeader, "SOLV_INGEST_KEY");
  const headers = {
    Authorization: authHeader,
    "Content-Type": "application/json",
  };

  let written = 0;
  let unchanged = 0;

  for (let i = 0; i < documents.length; i += BATCH_SIZE) {
    const batch = documents.slice(i, i + BATCH_SIZE);
    const body =
      options.sourceId !== undefined
        ? { sourceId: options.sourceId, documents: batch }
        : { ...target, documents: batch };
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
    const pruneBody =
      options.sourceId !== undefined
        ? { sourceId: options.sourceId, prune: true, keep }
        : { ...target, prune: true, keep };
    const res = await requestJson<IngestCounts>(
      deps.fetchImpl,
      url,
      { method: "DELETE", headers, body: JSON.stringify(pruneBody) },
      "SOLV_INGEST_KEY",
    );
    deps.log(`Pruned ${res.deleted} documents`);
  }
}
