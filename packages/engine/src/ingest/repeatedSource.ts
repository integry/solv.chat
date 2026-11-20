// Keeps a source's pages in step with its repeated blocks (issue #127; see
// "Repeated blocks" in docs/architecture.md). The pure rules are in
// `repeated.ts`; this is the part that reads and writes D1 and the queue.
import type { RepeatedBlock, RepeatedBlocks } from "@solvchat/core";
import type { StoredRepeated } from "../db/blocks.js";
import type { Tenant } from "../db/tenant.js";
import type { IngestQueueMessage } from "./documents.js";
import { normalizeBlock, type PageBlocks, pageBlocks, repeatedKey } from "./repeated.js";

/** The queue pages are sent to when their repeated blocks change. */
export interface RepeatedQueue {
  sendBatch(messages: Array<{ body: IngestQueueMessage }>): Promise<unknown>;
}

// "100 (or 256KB in total)" messages per `sendBatch`.
// Source: https://developers.cloudflare.com/queues/platform/limits/ — checked 2026-11-18
const QUEUE_SEND_BATCH_MESSAGES = 100;
/** Tries at storing a changed set before leaving it to the source's next commit. */
const SWAP_ATTEMPTS = 3;

/** True when the source kind's pages are checked for repeated blocks: never written answers. */
export function checksRepeated(kind: "push" | "sitemap" | "entry"): boolean {
  return kind !== "entry";
}

/** The page just committed, for the check that it was built with the blocks now stored. */
export interface CommittedPage {
  documentId: string;
  contentHash: string;
  page: PageBlocks;
  key: string;
}

/**
 * Brings the source's stored repeated blocks up to date with its counts, and
 * queues every indexed page whose blocks changed status, so a block that
 * crosses the threshold late is cleaned from the pages indexed before it
 * did (and one that falls back under it is given back). Run after every
 * commit of a page and after pages are removed. When `committed` is given
 * and the stored blocks are not the ones it was built with (they changed
 * while it was built), that page is queued too.
 *
 * The hashes whose status changed are stored as pending in the same
 * statement as the new set, and removed only after every send succeeded: a
 * send that fails (or a run that stops) after the set is stored leaves them
 * pending, and the next run, which finds the set unchanged, queues their
 * pages again. Queuing a page twice costs nothing; its key then matches.
 *
 * Each page is then rebuilt from its stored text once by the consumer; a
 * page whose chunks come out the same is not embedded again. With the
 * counts held in `source_blocks`, nothing here reads more than the source's
 * page count, the rows over the threshold, and the pages holding a hash
 * whose status changed or is pending.
 */
export async function reconcileRepeated(
  tenant: Tenant,
  sourceId: string,
  queue: RepeatedQueue,
  orgId: string,
  committed?: CommittedPage,
): Promise<{ queued: number }> {
  let current: Set<string> | null = null;
  // The hashes whose pages this run queues, and the store they were read at.
  let owed: string[] = [];
  let rev = 0;
  for (let attempt = 0; attempt < SWAP_ATTEMPTS; attempt++) {
    const stored = await tenant.blocks.stored(sourceId);
    if (stored === null) return { queued: 0 };
    owed = stored.pending;
    rev = stored.rev;
    const next = await tenant.blocks.compute(sourceId);
    const before = new Set(stored.hashes);
    const after = new Set(next);
    const changed = [
      ...next.filter((hash) => !before.has(hash)),
      ...stored.hashes.filter((hash) => !after.has(hash)),
    ];
    if (changed.length === 0) {
      current = after;
      break;
    }
    // Compare-and-set: two commits that both see a change store it once,
    // and the one that loses reads again.
    if (!(await tenant.blocks.swap(sourceId, stored.raw, next, changed))) continue;
    current = after;
    owed = [...new Set([...stored.pending, ...changed])];
    rev = stored.rev + 1;
    break;
  }
  const toQueue = new Map<string, string>();
  for (const doc of await tenant.blocks.documentsWith(sourceId, owed)) {
    toQueue.set(doc.id, doc.contentHash);
  }
  if (committed !== undefined && current !== null) {
    if ((await repeatedKey(committed.page, current)) !== committed.key) {
      toQueue.set(committed.documentId, committed.contentHash);
    }
  }
  const messages = [...toQueue].map(([documentId, contentHash]) => ({
    body: { orgId, documentId, contentHash },
  }));
  for (let i = 0; i < messages.length; i += QUEUE_SEND_BATCH_MESSAGES) {
    await queue.sendBatch(messages.slice(i, i + QUEUE_SEND_BATCH_MESSAGES));
  }
  await tenant.blocks.settle(sourceId, rev, owed);
  return { queued: messages.length };
}

/**
 * True when an indexed page was built with the repeated blocks its source
 * has now: its stored key matches its recorded hashes against the stored
 * set. A page with no recorded blocks is not (it predates them).
 */
export async function builtWithCurrentRepeated(
  tenant: Tenant,
  document: { id: string; sourceId: string; repeatedKey: string | null },
  stored: StoredRepeated | null,
): Promise<boolean> {
  if (document.repeatedKey === null) return false;
  if (stored === null) return true;
  const hashes = await tenant.blocks.forDocument(document.id);
  const repeated = new Set(stored.hashes);
  const page: PageBlocks = { blocks: [], units: [], hashes };
  return (await repeatedKey(page, repeated)) === document.repeatedKey;
}

/** The first characters of a block shown to the owner. */
export const REPEATED_PREVIEW_CHARS = 80;
/** Documents read from R2 to show the blocks; one usually holds them all. */
const MAX_PREVIEW_DOCUMENTS = 5;

/** The heading/list/emphasis markers an owner does not need to see in a preview. */
function previewText(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The repeated blocks left out of a source's pages, for Sources: the
 * paragraphs, lists and code blocks (a heading left out with its body is
 * not listed on its own), with the first `REPEATED_PREVIEW_CHARS` characters
 * of each and on how many pages it is. Nothing of the text is stored for
 * this: it is read back from the stored text of a few pages that hold the
 * blocks (at most `MAX_PREVIEW_DOCUMENTS` R2 reads); a block none of those
 * holds is listed without its text.
 */
export async function repeatedBlocksFor(
  tenant: Tenant,
  docs: Pick<R2Bucket, "get">,
  source: { id: string; kind: "push" | "sitemap" | "entry" },
): Promise<RepeatedBlocks> {
  if (!checksRepeated(source.kind)) return { blocks: [] };
  const stored = await tenant.blocks.stored(source.id);
  const hashes = (stored?.hashes ?? []).filter((hash) => hash.startsWith("b"));
  if (hashes.length === 0) return { blocks: [] };
  const samples = await tenant.blocks.samples(source.id, hashes);

  const texts = new Map<string, string>();
  const documentIds = [
    ...new Set([...samples.values()].map((s) => s.documentId).filter((id) => id !== null)),
  ].sort();
  for (const documentId of documentIds.slice(0, MAX_PREVIEW_DOCUMENTS)) {
    const document = await tenant.documents.get(documentId as string);
    if (document === null || document.bodyKey === null) continue;
    const object = await docs.get(document.bodyKey);
    if (object === null) continue;
    const page = await pageBlocks(await object.text());
    for (const unit of page.units) {
      if (unit.kind !== "b" || texts.has(unit.hash)) continue;
      const block = page.blocks[unit.blocks[0] as number];
      if (block !== undefined) texts.set(unit.hash, previewText(block.text));
    }
  }

  const blocks: RepeatedBlock[] = hashes.map((hash) => {
    const text = texts.get(hash) ?? null;
    const chars = text === null ? [] : [...text];
    return {
      text: text === null ? null : chars.slice(0, REPEATED_PREVIEW_CHARS).join(""),
      truncated: chars.length > REPEATED_PREVIEW_CHARS,
      pages: samples.get(hash)?.pages ?? 0,
    };
  });
  blocks.sort(
    (a, b) =>
      b.pages - a.pages ||
      normalizeBlock(a.text ?? "￿").localeCompare(normalizeBlock(b.text ?? "￿")),
  );
  return { blocks };
}
