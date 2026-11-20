import type { SourceKind, SourceSyncStatus, SyncSchedule } from "@solvchat/core";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ApiError, deleteJson, getJson, patchJson, postJson } from "../api/client.js";
import type { DocumentSummary, IndexErrorCode, SourceSummary } from "../api/types.js";
import { useResource } from "../api/useResource.js";
import { ScreenLink } from "../routing.js";
import { CopyButton } from "../ui/CopyButton.js";
import { DataTable, type DataTableColumn } from "../ui/DataTable.js";
import { RelativeTime } from "../ui/DateText.js";
import { ConfirmDialog } from "../ui/Dialog.js";
import { EmptyState } from "../ui/EmptyState.js";
import { ErrorState } from "../ui/ErrorState.js";
import { formatDateTime } from "../ui/format.js";
import { Icon, type IconName } from "../ui/Icon.js";
import { PageHeader } from "../ui/PageHeader.js";
import { RowMenu, type RowMenuItem } from "../ui/RowMenu.js";
import { Skeleton } from "../ui/Skeleton.js";
import { StatusBadge, type StatusTone } from "../ui/StatusBadge.js";
import { useToast } from "../ui/Toast.js";
import { cliPushCommand } from "./cliCommand.js";
import { EntryEditor } from "./EntryEditor.js";
import { RebuildNotice } from "./RebuildNotice.js";
import { RecentChangesNotice } from "./RecentChangesNotice.js";
import { RepeatedBlocksList, repeatedBlocksText } from "./RepeatedBlocks.js";
import {
  isSyncing,
  SyncCell,
  SyncingStatus,
  syncCountsText,
  syncErrorText,
  withheldRemovals,
} from "./SourceSync.js";

export interface SourcesProps {
  assistantId: string;
}

const DOCS_PAGE_SIZE = 20;
const MAX_IMPORT_URLS = 100;
// The engine imports at most this many pages per request so one request
// stays inside the Workers subrequest limit; a selection goes in batches.
export const IMPORT_BATCH_URLS = 5;
/** How often the list is checked while something is being indexed, retried or synced. */
export const INDEXING_POLL_MS = 5000;

const KIND_TEXT: Record<SourceKind, { icon: IconName; type: string }> = {
  push: { icon: "terminal", type: "Pushed with the CLI" },
  entry: { icon: "pencil", type: "Written here" },
  sitemap: { icon: "globe", type: "Imported from a sitemap" },
};

const INDEX_ERROR_TEXT: Record<IndexErrorCode, string> = {
  too_long: "a page is too long to index. Split it into smaller pages.",
  missing_body: "a page's text is missing. Push or save it again.",
  embedding_failed: "the search service did not answer. It will try again.",
};

type AddChoice = "write" | "sitemap" | "cli";

function formatCount(count: number): string {
  return count === 1 ? "1 document" : `${count} documents`;
}

function formatPages(count: number): string {
  return count === 1 ? "1 page" : `${count} pages`;
}

/** The row's name: a pushed source's stored label ("Push") says nothing on its own. */
function sourceName(source: SourceSummary): string {
  if (source.kind === "push" && source.label === "Push") return "Your site";
  return source.label;
}

function stripLeadingHeading(markdown: string, title: string): string {
  const prefix = `# ${title}\n\n`;
  if (markdown.startsWith(prefix)) {
    return markdown.slice(prefix.length);
  }
  return markdown;
}

export interface IndexStatus {
  tone: StatusTone;
  label: string;
  hint: string | null;
}

/** Whether a failed source can still turn Ready without the owner doing anything. */
function mayRecover(source: SourceSummary): boolean {
  if ((source.failedCount ?? 0) === 0) return false;
  // Engines older than `retryingCount` only give one error code for the source.
  if (source.retryingCount === undefined) return source.indexError !== "too_long";
  return source.retryingCount > 0;
}

/** "Indexing…", "Ready" or "Failed: reason", from a source's counts. */
export function indexStatus(source: SourceSummary): IndexStatus {
  const failed = source.failedCount ?? 0;
  const indexing = source.indexingCount ?? 0;
  if (failed > 0) {
    const reason = source.indexError ? INDEX_ERROR_TEXT[source.indexError] : null;
    return {
      tone: "danger",
      label: "Failed",
      hint: `${failed === 1 ? "1 page" : `${failed} pages`} could not be indexed${
        reason ? `: ${reason}` : "."
      }`,
    };
  }
  if (indexing > 0) {
    return {
      tone: "info",
      label: "Indexing…",
      hint: `${formatPages(indexing)} not searchable yet. This usually takes a minute or two.`,
    };
  }
  if (source.documentCount === 0) {
    return { tone: "neutral", label: "Empty", hint: null };
  }
  return { tone: "success", label: "Ready", hint: null };
}

/**
 * Imports `urls` into a sitemap source in batches, reporting progress. Throws
 * on the first failed batch; `onBatchDone` has already been called for the
 * ones that finished, so a retry can skip them.
 */
async function importInBatches(
  assistantId: string,
  sitemapUrl: string,
  sourceId: string,
  urls: readonly string[],
  onBatchDone: (batch: string[], done: number) => void,
): Promise<{ written: number; unchanged: number; total: number }> {
  let written = 0;
  let unchanged = 0;
  let total = 0;
  for (let at = 0; at < urls.length; at += IMPORT_BATCH_URLS) {
    const batch = urls.slice(at, at + IMPORT_BATCH_URLS);
    const res = await postJson<{ total: number; written?: number; unchanged?: number }>(
      `/api/admin/assistants/${assistantId}/sitemap-import`,
      { sitemapUrl, urls: batch, sourceId },
    );
    total += res.total;
    written += res.written ?? res.total;
    unchanged += res.unchanged ?? 0;
    onBatchDone(batch, at + batch.length);
  }
  return { written, unchanged, total };
}

/** The engine returns at most this many documents per page. */
const SOURCE_PAGE_LIST_LIMIT = 100;

/** Every page address already in a source, in the order the engine lists them. */
async function listSourcePageUrls(sourceId: string): Promise<string[]> {
  const urls: string[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (;;) {
    const page = await getJson<{ documents: DocumentSummary[]; total: number }>(
      `/api/admin/sources/${sourceId}/documents?limit=${SOURCE_PAGE_LIST_LIMIT}&offset=${offset}`,
    );
    for (const doc of page.documents) {
      if (doc.url && !seen.has(doc.url)) {
        seen.add(doc.url);
        urls.push(doc.url);
      }
    }
    offset += page.documents.length;
    if (page.documents.length === 0 || offset >= page.total) return urls;
  }
}

function importSummary(result: { written: number; unchanged: number; total: number }): string {
  const head = `Imported ${formatPages(result.total)}.`;
  if (result.unchanged === 0) return head;
  return `${head} ${result.written} new or changed, ${result.unchanged} unchanged.`;
}

function ImportProgress({ done, total, label }: { done: number; total: number; label: string }) {
  return (
    <div className="import-progress" role="status">
      <span>
        {label} {done} of {formatPages(total)}…
      </span>
      <progress max={total} value={done} aria-label={label} />
    </div>
  );
}

function SitemapImport({
  assistantId,
  onImported,
  onImportingChange,
}: {
  assistantId: string;
  onImported: () => void;
  /** Tells the Add content panel to stay on this choice until the import ends. */
  onImportingChange: (importing: boolean) => void;
}) {
  const [sitemapUrl, setSitemapUrl] = useState("");
  const [preview, setPreview] = useState<{ url: string; urls: string[] } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importSourceId, setImportSourceId] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const importing = progress !== null;

  useEffect(() => {
    onImportingChange(importing);
  }, [importing, onImportingChange]);

  async function handlePreview(event: FormEvent) {
    event.preventDefault();
    if (fetching || importing) return;
    const targetUrl = sitemapUrl.trim();
    setFetching(true);
    setError(null);
    setNotice(null);
    setPreview(null);
    setSelected(new Set());
    setImportSourceId(null);

    try {
      const res = await postJson<{ urls: string[] }>(
        `/api/admin/assistants/${assistantId}/sitemap-preview`,
        { url: targetUrl },
      );
      setPreview({ url: targetUrl, urls: res.urls });
      setSelected(new Set(res.urls.slice(0, MAX_IMPORT_URLS)));
      if (res.urls.length === 0) {
        setNotice("No pages found in that sitemap.");
      }
    } catch (err) {
      setPreview(null);
      setSelected(new Set());
      if (err instanceof ApiError) {
        setError(err.fields.url ?? err.message);
      } else {
        setError("Could not read that sitemap. Try again.");
      }
    } finally {
      setFetching(false);
    }
  }

  function toggleUrl(url: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(url)) {
        next.delete(url);
      } else {
        next.add(url);
      }
      return next;
    });
  }

  async function handleImport() {
    if (fetching || importing || !preview || selected.size === 0) return;
    const chosen = preview.urls.filter((u) => selected.has(u));
    setProgress({ done: 0, total: chosen.length });
    setError(null);
    setNotice(null);

    try {
      let sourceId = importSourceId;
      if (sourceId === null) {
        const targetUrl = preview.url || chosen[0] || "";
        let label = "Sitemap";
        try {
          label = new URL(targetUrl).hostname.slice(0, 80) || "Sitemap";
        } catch {
          // Let server validation report the invalid URL.
        }
        const created = await postJson<{ source: SourceSummary }>(
          `/api/admin/assistants/${assistantId}/sources`,
          { kind: "sitemap", label, settings: { url: targetUrl } },
        );
        sourceId = created.source.id;
        setImportSourceId(sourceId);
        // The new source shows in the list straight away, marked as indexing.
        onImported();
      }

      const result = await importInBatches(
        assistantId,
        preview.url,
        sourceId,
        chosen,
        (batch, done) => {
          setProgress({ done, total: chosen.length });
          // A failure later on leaves only the pages not yet imported selected,
          // so trying again does not fetch the finished ones twice.
          setSelected((prev) => {
            const next = new Set(prev);
            for (const url of batch) next.delete(url);
            return next;
          });
        },
      );
      setPreview(null);
      setSelected(new Set());
      setImportSourceId(null);
      setSitemapUrl("");
      setNotice(
        `${importSummary(result)} Your assistant can use them once indexing finishes, usually within a few minutes.`,
      );
      onImported();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(
          err.fields.urls ??
            err.fields.url ??
            err.fields["settings.url"] ??
            err.fields.label ??
            err.message,
        );
      } else {
        setError("Could not import those pages. Try again.");
      }
    } finally {
      setProgress(null);
    }
  }

  return (
    <div className="stack">
      <p className="field-hint">
        Lists the pages in a sitemap so you can choose which to copy in. Only the pages it lists are
        read; links on them are not followed. When those pages change, choose Re-import from the
        source's menu, or set the source to sync with its sitemap every day or week.
      </p>

      <form className="stack" onSubmit={(e) => void handlePreview(e)}>
        <div className="field">
          <label htmlFor="sitemap-url">Sitemap URL</label>
          <input
            id="sitemap-url"
            type="url"
            value={sitemapUrl}
            disabled={fetching || importing}
            onChange={(e) => {
              setSitemapUrl(e.target.value);
              setPreview(null);
              setSelected(new Set());
              setImportSourceId(null);
              setError(null);
              setNotice(null);
            }}
            placeholder="https://example.com/sitemap.xml"
          />
        </div>
        <div className="actions">
          <button
            type="submit"
            className="btn btn-secondary"
            disabled={fetching || importing || sitemapUrl.trim() === ""}
          >
            {fetching ? "Fetching URLs…" : "Fetch URLs"}
          </button>
        </div>
      </form>

      {preview && preview.urls.length > 0 && (
        <div className="stack">
          <div className="sitemap-toolbar">
            <span className="muted">
              {selected.size} of {preview.urls.length} selected · Up to {MAX_IMPORT_URLS} pages per
              import
            </span>
            <div className="actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={fetching || importing}
                onClick={() => setSelected(new Set(preview.urls.slice(0, MAX_IMPORT_URLS)))}
              >
                Select all
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={fetching || importing}
                onClick={() => setSelected(new Set())}
              >
                Clear all
              </button>
            </div>
          </div>

          <ul className="sitemap-url-list">
            {preview.urls.map((url) => (
              <li key={url} className="sitemap-url-item">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={selected.has(url)}
                    disabled={fetching || importing}
                    onChange={() => toggleUrl(url)}
                  />
                  <span>{url}</span>
                </label>
              </li>
            ))}
          </ul>

          {progress && (
            <ImportProgress done={progress.done} total={progress.total} label="Importing" />
          )}

          <div className="actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={fetching || importing || selected.size === 0}
              onClick={() => void handleImport()}
            >
              {importing ? "Importing…" : "Import selected"}
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice-text" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}

function CliInstructions({ assistantId }: { assistantId: string }) {
  return (
    <div className="stack">
      <p className="field-hint">
        Send pages from your site's build, so the assistant stays in step with every deploy. Each
        push replaces what changed and leaves the rest.
      </p>
      <ol className="numbered-steps">
        <li>
          Keep your ingest key as a secret in your build, named <code>SOLV_INGEST_KEY</code>. You
          can rotate it on <ScreenLink to="install">Install</ScreenLink>, under "For developers".
        </li>
        <li>
          After your site builds, push its folder of Markdown files:
          <pre className="code-block">
            <code>{cliPushCommand(assistantId)}</code>
          </pre>
          <CopyButton value={cliPushCommand(assistantId)} label="Copy command" />
        </li>
      </ol>
    </div>
  );
}

const ADD_CHOICES: ReadonlyArray<{ id: AddChoice; icon: IconName; title: string; text: string }> = [
  {
    id: "write",
    icon: "pencil",
    title: "Write an answer",
    text: "A question and its answer, in your own words.",
  },
  {
    id: "sitemap",
    icon: "globe",
    title: "Import from a sitemap",
    text: "Copy in the pages your sitemap lists.",
  },
  {
    id: "cli",
    icon: "terminal",
    title: "Push from your build",
    text: "Keep pages in step with every deploy.",
  },
];

export function Sources({ assistantId }: SourcesProps) {
  const toast = useToast();
  const sourcesRes = useResource<{ sources: SourceSummary[] }>(
    `/api/admin/assistants/${assistantId}/sources`,
  );
  // A failed background check must not unmount the editors below the list and
  // lose what the owner is typing: keep showing the last list that loaded.
  const lastSourcesRef = useRef<{ assistantId: string; sources: SourceSummary[] } | null>(null);
  if (sourcesRes.status === "ready" && sourcesRes.value) {
    lastSourcesRef.current = { assistantId, sources: sourcesRes.value.sources };
  }
  const lastSources =
    lastSourcesRef.current?.assistantId === assistantId ? lastSourcesRef.current.sources : null;
  const loadedSources = sourcesRes.value?.sources ?? lastSources;
  const sources = loadedSources ?? [];
  // Also keep checking while a failure is retried: the Queue can still index it.
  // And while a sync runs, so its progress and outcome show without a reload.
  const anyIndexing = sources.some(
    (s) => (s.indexingCount ?? 0) > 0 || mayRecover(s) || isSyncing(s),
  );

  // The chosen way to add stays set after Close, so reopening shows the same one.
  const [addChoice, setAddChoice] = useState<AddChoice>("write");
  // Mounted from the first open on and only hidden after that: switching
  // choices or closing never throws away a draft answer or a sitemap selection.
  const [addMounted, setAddMounted] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  // While pages are importing, the panel stays open on the sitemap choice so
  // its progress and any error with a retry stay on screen.
  const [sitemapImporting, setSitemapImporting] = useState(false);
  const [expandedSourceId, setExpandedSourceId] = useState<string | null>(null);
  const [docsState, setDocsState] = useState<{
    sourceId: string | null;
    documents: DocumentSummary[];
    total: number;
    offset: number;
    loading: boolean;
    error: string | null;
  }>({ sourceId: null, documents: [], total: 0, offset: 0, loading: false, error: null });

  const docsRequestRef = useRef<{ id: number; controller: AbortController } | null>(null);
  const docsRequestSeqRef = useRef(0);
  const entryRequestRef = useRef<{
    id: number;
    sourceId: string;
    controller: AbortController;
  } | null>(null);
  const entryRequestSeqRef = useRef(0);
  const docsPanelRef = useRef<HTMLElement>(null);
  const addPanelRef = useRef<HTMLElement>(null);

  function cancelEntryLoad(onlySourceId?: string) {
    if (onlySourceId !== undefined && entryRequestRef.current?.sourceId !== onlySourceId) {
      return;
    }
    entryRequestRef.current?.controller.abort();
    entryRequestRef.current = null;
    entryRequestSeqRef.current++;
  }

  const [editingEntry, setEditingEntry] = useState<{
    sourceId: string;
    documentId: string;
    question: string;
    answer: string;
  } | null>(null);
  const editingEntryRef = useRef(editingEntry);
  editingEntryRef.current = editingEntry;

  const [confirmDelete, setConfirmDelete] = useState<SourceSummary | null>(null);
  const [busySourceId, setBusySourceId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Schedule changes and Sync now requests in flight, by source. Each source's
  // controls are locked only while its own request runs, so other sources stay
  // usable. The ref is the guard (state lags a render behind a quick second
  // action); the state drives what is disabled.
  const syncBusyRef = useRef<ReadonlySet<string>>(new Set());
  const [syncBusyIds, setSyncBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  function claimSyncBusy(sourceId: string): boolean {
    if (syncBusyRef.current.has(sourceId)) return false;
    syncBusyRef.current = new Set(syncBusyRef.current).add(sourceId);
    setSyncBusyIds(syncBusyRef.current);
    return true;
  }
  // A request finishing closes only its own source's confirm, not one the
  // user has since opened for another source.
  function closeConfirmSyncFor(sourceId: string) {
    setConfirmSync((current) => (current?.source.id === sourceId ? null : current));
    setConfirmAnyway((current) => (current?.source.id === sourceId ? null : current));
  }
  function releaseSyncBusy(sourceId: string) {
    const next = new Set(syncBusyRef.current);
    next.delete(sourceId);
    syncBusyRef.current = next;
    setSyncBusyIds(next);
  }
  // A source's first sync brings in every page its sitemap lists: asked first.
  const [confirmSync, setConfirmSync] = useState<{
    source: SourceSummary;
    action: "now" | Exclude<SyncSchedule, "off">;
  } | null>(null);
  // "Sync anyway" after a sync kept pages it would have removed: asked first,
  // with the number that goes.
  const [confirmAnyway, setConfirmAnyway] = useState<{
    source: SourceSummary;
    removals: number;
  } | null>(null);
  const [reimport, setReimport] = useState<{
    sourceId: string;
    done: number;
    total: number;
  } | null>(null);

  useEffect(() => {
    void assistantId;
    docsRequestRef.current?.controller.abort();
    docsRequestRef.current = null;
    docsRequestSeqRef.current++;
    entryRequestRef.current?.controller.abort();
    entryRequestRef.current = null;
    entryRequestSeqRef.current++;
    setExpandedSourceId(null);
    setEditingEntry(null);
    setDocsState({
      sourceId: null,
      documents: [],
      total: 0,
      offset: 0,
      loading: false,
      error: null,
    });
  }, [assistantId]);

  useEffect(() => {
    return () => {
      docsRequestRef.current?.controller.abort();
      entryRequestRef.current?.controller.abort();
    };
  }, []);

  // New content is not searchable for a short while: check again until it is.
  const reloadSources = sourcesRes.reload;
  const sourcesReady = sourcesRes.status === "ready";
  // Each answer is a new value, so every check schedules the next one even when
  // the status never visibly left "ready" (a fast answer batches both updates).
  const sourcesValue = sourcesRes.value;
  useEffect(() => {
    if (!anyIndexing || !sourcesReady || sourcesValue === undefined) return;
    const timer = setTimeout(reloadSources, INDEXING_POLL_MS);
    return () => clearTimeout(timer);
  }, [anyIndexing, sourcesReady, sourcesValue, reloadSources]);

  async function loadDocuments(sourceId: string, offset = 0) {
    docsRequestRef.current?.controller.abort();
    const requestId = ++docsRequestSeqRef.current;
    const controller = new AbortController();
    docsRequestRef.current = { id: requestId, controller };

    setDocsState((prev) => ({
      sourceId,
      documents: prev.sourceId === sourceId ? prev.documents : [],
      total: prev.sourceId === sourceId ? prev.total : 0,
      offset,
      loading: true,
      error: null,
    }));

    try {
      const data = await getJson<{ documents: DocumentSummary[]; total: number; offset?: number }>(
        `/api/admin/sources/${sourceId}/documents?limit=${DOCS_PAGE_SIZE}&offset=${offset}`,
        controller.signal,
      );
      if (docsRequestSeqRef.current !== requestId || controller.signal.aborted) {
        return;
      }
      setDocsState({
        sourceId,
        documents: data.documents,
        total: data.total,
        offset: data.offset ?? offset,
        loading: false,
        error: null,
      });
    } catch (err) {
      if (docsRequestSeqRef.current !== requestId || controller.signal.aborted) {
        return;
      }
      setDocsState((prev) => ({
        sourceId,
        documents: prev.sourceId === sourceId ? prev.documents : [],
        total: prev.sourceId === sourceId ? prev.total : 0,
        offset,
        loading: false,
        error: err instanceof ApiError ? err.message : "Could not load documents.",
      }));
    }
  }

  function closeDocuments() {
    docsRequestRef.current?.controller.abort();
    docsRequestRef.current = null;
    docsRequestSeqRef.current++;
    setExpandedSourceId(null);
  }

  function showDocuments(sourceId: string) {
    if (expandedSourceId === sourceId) {
      docsPanelRef.current?.focus();
      return;
    }
    setExpandedSourceId(sourceId);
    void loadDocuments(sourceId, 0);
    requestAnimationFrame(() => docsPanelRef.current?.focus());
  }

  function openAdd() {
    setAddMounted(true);
    setAddOpen(true);
    requestAnimationFrame(() => addPanelRef.current?.focus());
  }

  function closeAdd() {
    if (sitemapImporting) return;
    setAddOpen(false);
  }

  function chooseAdd(choice: AddChoice) {
    if (sitemapImporting && choice !== "sitemap") return;
    setAddChoice(choice);
  }

  async function handleEditEntry(sourceId: string, doc: DocumentSummary) {
    cancelEntryLoad();
    const requestId = ++entryRequestSeqRef.current;
    const controller = new AbortController();
    entryRequestRef.current = { id: requestId, sourceId, controller };

    setActionError(null);
    try {
      const res = await getJson<{ document: DocumentSummary; markdown: string }>(
        `/api/admin/sources/${sourceId}/documents/${doc.id}`,
        controller.signal,
      );
      if (entryRequestSeqRef.current !== requestId || controller.signal.aborted) {
        return;
      }
      entryRequestRef.current = null;
      setEditingEntry({
        sourceId,
        documentId: doc.id,
        question: res.document.title,
        answer: stripLeadingHeading(res.markdown, res.document.title),
      });
    } catch (err) {
      if (entryRequestSeqRef.current !== requestId || controller.signal.aborted) {
        return;
      }
      entryRequestRef.current = null;
      setActionError(err instanceof ApiError ? err.message : "Could not load entry.");
    }
  }

  async function handleDeleteSource(source: SourceSummary) {
    if (busySourceId !== null) return;
    const sourceId = source.id;
    setBusySourceId(sourceId);
    setDeleteError(null);
    try {
      await deleteJson(`/api/admin/sources/${sourceId}`);
      if (expandedSourceId === sourceId) closeDocuments();
      cancelEntryLoad(sourceId);
      setEditingEntry((prev) => (prev?.sourceId === sourceId ? null : prev));
      setConfirmDelete(null);
      toast.success(`Deleted ${sourceName(source)}.`);
      sourcesRes.reload();
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : "Could not delete source.");
    } finally {
      setBusySourceId(null);
    }
  }

  async function handleReimport(source: SourceSummary) {
    const url = typeof source.settings.url === "string" ? source.settings.url : "";
    if (reimport !== null || url === "") return;
    setActionError(null);
    setReimport({ sourceId: source.id, done: 0, total: 0 });
    try {
      // Refresh the pages the owner chose, not whatever the sitemap lists now:
      // pages they left out stay out, and every chosen page is fetched again.
      const urls = await listSourcePageUrls(source.id);
      if (urls.length === 0) {
        setActionError(
          `${sourceName(source)} has no pages to re-import. Use Add content to import some.`,
        );
        return;
      }
      setReimport({ sourceId: source.id, done: 0, total: urls.length });
      const result = await importInBatches(assistantId, url, source.id, urls, (_batch, done) =>
        setReimport({ sourceId: source.id, done, total: urls.length }),
      );
      toast.success(`${sourceName(source)}: ${importSummary(result)}`);
      sourcesRes.reload();
      if (expandedSourceId === source.id) void loadDocuments(source.id, 0);
    } catch (err) {
      setActionError(
        err instanceof ApiError
          ? `Could not re-import ${sourceName(source)}: ${err.fields.url ?? err.fields.urls ?? err.message}`
          : `Could not re-import ${sourceName(source)}. Try again.`,
      );
      sourcesRes.reload();
    } finally {
      setReimport(null);
    }
  }

  async function saveSchedule(source: SourceSummary, schedule: SyncSchedule) {
    if (!claimSyncBusy(source.id)) return;
    setActionError(null);
    try {
      await patchJson(`/api/admin/sources/${source.id}`, { settings: { sync: schedule } });
      toast.success(
        schedule === "off"
          ? `${sourceName(source)} now syncs only when you choose Sync now.`
          : `${sourceName(source)} now syncs with its sitemap every ${schedule === "daily" ? "day" : "week"}.`,
      );
      closeConfirmSyncFor(source.id);
      sourcesRes.reload();
    } catch (err) {
      closeConfirmSyncFor(source.id);
      setActionError(
        err instanceof ApiError
          ? `Could not change how often ${sourceName(source)} syncs: ${err.fields["settings.sync"] ?? err.message}`
          : `Could not change how often ${sourceName(source)} syncs. Try again.`,
      );
    } finally {
      releaseSyncBusy(source.id);
    }
  }

  async function startSync(source: SourceSummary, allowRemovals?: number) {
    if (!claimSyncBusy(source.id)) return;
    setActionError(null);
    try {
      const res = await postJson<{ sync: SourceSyncStatus }>(
        `/api/admin/sources/${source.id}/sync`,
        allowRemovals !== undefined ? { allowRemovals } : undefined,
      );
      const last = res.sync.last;
      if (last?.outcome === "failed") {
        toast.error(`${sourceName(source)} did not sync: ${syncErrorText(last.error, source)}`);
      } else if (last?.outcome === "succeeded" || last?.outcome === "partial") {
        toast.success(`${sourceName(source)} synced: ${syncCountsText(last.counts)}.`);
      } else {
        toast.success(`Syncing ${sourceName(source)}…`);
      }
      closeConfirmSyncFor(source.id);
    } catch (err) {
      closeConfirmSyncFor(source.id);
      setActionError(
        err instanceof ApiError
          ? `Could not sync ${sourceName(source)}: ${err.message}`
          : `Could not sync ${sourceName(source)}. Try again.`,
      );
    } finally {
      releaseSyncBusy(source.id);
      sourcesRes.reload();
    }
  }

  function handleScheduleChange(source: SourceSummary, schedule: SyncSchedule) {
    if (schedule !== "off" && source.sync?.last === null) {
      setConfirmSync({ source, action: schedule });
      return;
    }
    void saveSchedule(source, schedule);
  }

  function handleSyncNow(source: SourceSummary) {
    if (source.sync?.last === null) {
      setConfirmSync({ source, action: "now" });
      return;
    }
    void startSync(source);
  }

  if (sourcesRes.status === "loading" && loadedSources === null) {
    return (
      <div className="screen">
        <PageHeader title="Sources" description="Where your assistant's answers come from." />
        <Skeleton label="Loading sources…" lines={4} />
      </div>
    );
  }
  if (sourcesRes.status === "error" && loadedSources === null) {
    return (
      <div className="screen">
        <PageHeader title="Sources" description="Where your assistant's answers come from." />
        <ErrorState
          title="Could not load your sources."
          detail={sourcesRes.error}
          onRetry={sourcesRes.reload}
        />
      </div>
    );
  }

  const columns: DataTableColumn<SourceSummary>[] = [
    {
      key: "name",
      header: "Source",
      render: (source) => (
        <div className="source-name-cell">
          <span className="source-type-icon" aria-hidden="true">
            <Icon name={KIND_TEXT[source.kind].icon} />
          </span>
          <span>
            <span className="source-label">{sourceName(source)}</span>
            <span className="source-type">{KIND_TEXT[source.kind].type}</span>
          </span>
        </div>
      ),
    },
    {
      key: "documents",
      header: "Documents",
      align: "end",
      render: (source) => source.documentCount.toLocaleString(),
    },
    {
      key: "status",
      header: "Status",
      render: (source) => {
        if (reimport?.sourceId === source.id) {
          return reimport.total === 0 ? (
            <StatusBadge tone="info">Getting pages…</StatusBadge>
          ) : (
            <ImportProgress done={reimport.done} total={reimport.total} label="Re-importing" />
          );
        }
        if (source.sync && isSyncing(source)) return <SyncingStatus sync={source.sync} />;
        const status = indexStatus(source);
        const repeated = source.repeatedBlockCount ?? 0;
        return (
          <div className="source-status">
            <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
            {status.hint && <span className="source-status-hint">{status.hint}</span>}
            {repeated > 0 && (
              <button
                type="button"
                className="text-button source-status-hint"
                onClick={() => showDocuments(source.id)}
              >
                {repeatedBlocksText(repeated)}
              </button>
            )}
          </div>
        );
      },
    },
    {
      key: "updated",
      header: "Last updated",
      render: (source) =>
        source.lastUpdatedAt === null ? (
          <span className="muted">Never</span>
        ) : (
          <RelativeTime value={source.lastUpdatedAt} />
        ),
    },
    ...(sources.some((s) => s.sync !== undefined)
      ? [
          {
            key: "sync",
            header: "Sync",
            render: (source: SourceSummary) =>
              source.sync ? (
                <SyncCell
                  source={source}
                  sync={source.sync}
                  name={sourceName(source)}
                  busy={syncBusyIds.has(source.id)}
                  onScheduleChange={(schedule) => handleScheduleChange(source, schedule)}
                  onSyncNow={() => handleSyncNow(source)}
                  onSyncAnyway={() => {
                    const removals = withheldRemovals(source.sync);
                    if (removals > 0) setConfirmAnyway({ source, removals });
                  }}
                />
              ) : null,
          },
        ]
      : []),
    {
      key: "actions",
      header: "Actions",
      hideHeader: true,
      align: "end",
      render: (source) => {
        const items: RowMenuItem[] = [
          { label: "View documents", onSelect: () => showDocuments(source.id) },
        ];
        if (source.kind === "sitemap" && typeof source.settings.url === "string") {
          items.push({
            label: "Re-import",
            disabled: reimport !== null || isSyncing(source),
            onSelect: () => void handleReimport(source),
          });
        }
        if (source.kind !== "push") {
          items.push({
            label: "Delete",
            tone: "danger",
            disabled: busySourceId !== null,
            onSelect: () => {
              setDeleteError(null);
              setConfirmDelete(source);
            },
          });
        }
        return <RowMenu label={`Actions for ${sourceName(source)}`} items={items} />;
      },
    },
  ];

  const expandedSource = sources.find((s) => s.id === expandedSourceId) ?? null;
  const pushSource = sources.find((s) => s.kind === "push" && s.documentCount > 0);

  return (
    <div className="screen">
      <PageHeader
        title="Sources"
        description="Where your assistant's answers come from."
        actions={
          <button
            type="button"
            className="btn btn-primary"
            aria-expanded={addOpen}
            aria-controls="add-content"
            disabled={addOpen && sitemapImporting}
            onClick={() => (addOpen ? closeAdd() : openAdd())}
          >
            <Icon name="plus" />
            Add content
          </button>
        }
      />

      {sourcesRes.status === "error" && (
        <ErrorState
          title="Could not refresh your sources."
          detail={sourcesRes.error}
          onRetry={sourcesRes.reload}
        />
      )}

      {actionError && (
        <p className="error-text" role="alert">
          {actionError}
        </p>
      )}

      <RecentChangesNotice assistantId={assistantId} refresh={sourcesRes.value} />

      <RebuildNotice assistantId={assistantId} onRebuilt={sourcesRes.reload} />

      {sources.length === 0 ? (
        !addOpen && (
          <EmptyState
            icon="sources"
            title="No sources yet"
            description="Write an answer, import pages from a sitemap, or push them from your site's build."
            action={
              <button type="button" className="btn btn-primary" onClick={openAdd}>
                Add content
              </button>
            }
          />
        )
      ) : (
        <>
          <DataTable
            className="sources-table"
            caption="Sources"
            columns={columns}
            rows={sources}
            rowKey={(source) => source.id}
          />
          {pushSource && (
            <p className="field-hint">
              Pages pushed from your site are read-only here. Update them with{" "}
              <code>solv push</code>.
            </p>
          )}
        </>
      )}

      {expandedSource && (
        <section
          ref={docsPanelRef}
          className="source-card stack"
          aria-labelledby="source-docs-heading"
          tabIndex={-1}
        >
          <div className="source-row-header">
            <h2 id="source-docs-heading" className="section-heading">
              Documents in {sourceName(expandedSource)}
            </h2>
            <button type="button" className="btn btn-secondary btn-sm" onClick={closeDocuments}>
              Close
            </button>
          </div>
          {expandedSource.kind === "push" && (
            <p className="field-hint">
              Read-only. Update pushed pages from your site with <code>solv push</code>.
            </p>
          )}
          <RepeatedBlocksList
            key={expandedSource.id}
            sourceId={expandedSource.id}
            count={expandedSource.repeatedBlockCount ?? 0}
          />
          {(() => {
            const activeDocs = docsState.sourceId === expandedSource.id ? docsState : null;
            const start = activeDocs ? activeDocs.offset + 1 : 0;
            const end = activeDocs ? activeDocs.offset + activeDocs.documents.length : 0;
            const hasPrev = activeDocs ? activeDocs.offset > 0 : false;
            const hasNext = activeDocs ? end < activeDocs.total : false;
            if (!activeDocs || (activeDocs.loading && activeDocs.documents.length === 0)) {
              return <Skeleton label="Loading documents…" lines={3} />;
            }
            if (activeDocs.error) {
              return (
                <ErrorState
                  title="Could not load the documents."
                  detail={activeDocs.error}
                  onRetry={() => void loadDocuments(expandedSource.id, activeDocs.offset)}
                />
              );
            }
            if (activeDocs.documents.length === 0) {
              return <p className="muted">No documents in this source yet.</p>;
            }
            return (
              <>
                <ul className="source-doc-list">
                  {activeDocs.documents.map((doc) => (
                    <li key={doc.id} className="source-doc-item">
                      <div>
                        <div className="source-doc-title">{doc.title}</div>
                        <div className="muted source-doc-meta">
                          {doc.url} · {formatDateTime(doc.updatedAt)}
                        </div>
                      </div>
                      {expandedSource.kind === "entry" && (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          aria-label={`Edit ${doc.title}`}
                          onClick={() => void handleEditEntry(expandedSource.id, doc)}
                        >
                          Edit
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
                {(activeDocs.total > DOCS_PAGE_SIZE || hasPrev) && (
                  <div className="sitemap-toolbar">
                    <span className="muted">
                      Showing {start}–{end} of {activeDocs.total}
                    </span>
                    <div className="actions">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={activeDocs.loading || !hasPrev}
                        onClick={() =>
                          void loadDocuments(
                            expandedSource.id,
                            Math.max(0, activeDocs.offset - DOCS_PAGE_SIZE),
                          )
                        }
                      >
                        Previous
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={activeDocs.loading || !hasNext}
                        onClick={() =>
                          void loadDocuments(expandedSource.id, activeDocs.offset + DOCS_PAGE_SIZE)
                        }
                      >
                        Next
                      </button>
                    </div>
                  </div>
                )}
              </>
            );
          })()}
        </section>
      )}

      {editingEntry && (
        <EntryEditor
          assistantId={assistantId}
          sourceId={editingEntry.sourceId}
          documentId={editingEntry.documentId}
          initialQuestion={editingEntry.question}
          initialAnswer={editingEntry.answer}
          onCancel={() => {
            cancelEntryLoad();
            setEditingEntry(null);
          }}
          onSaved={(result, session) => {
            if (session.assistantId !== assistantId) return;
            const current = editingEntryRef.current;
            if (
              current?.sourceId === session.sourceId &&
              current?.documentId === session.documentId
            ) {
              setEditingEntry(null);
            }
            sourcesRes.reload();
            if (expandedSourceId === result.sourceId) {
              void loadDocuments(
                result.sourceId,
                docsState.sourceId === result.sourceId ? docsState.offset : 0,
              );
            }
          }}
        />
      )}

      {addMounted && (
        <section
          ref={addPanelRef}
          id="add-content"
          className="source-card stack add-content"
          aria-labelledby="add-content-heading"
          tabIndex={-1}
          hidden={!addOpen}
        >
          <div className="source-row-header">
            <h2 id="add-content-heading" className="section-heading">
              Add content
            </h2>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={sitemapImporting}
              onClick={closeAdd}
            >
              Close
            </button>
          </div>
          <fieldset className="choice-group">
            <legend className="sr-only">What would you like to add?</legend>
            {ADD_CHOICES.map((choice) => (
              <label
                key={choice.id}
                className={addChoice === choice.id ? "choice-card is-selected" : "choice-card"}
              >
                <input
                  type="radio"
                  name="add-content-choice"
                  value={choice.id}
                  checked={addChoice === choice.id}
                  disabled={sitemapImporting && choice.id !== "sitemap"}
                  onChange={() => chooseAdd(choice.id)}
                />
                <Icon name={choice.icon} size={20} />
                <span className="choice-card-text">
                  <span className="choice-card-title">{choice.title}</span>
                  <span className="choice-card-hint">{choice.text}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {sitemapImporting && (
            <p className="field-hint">You can add something else once the import finishes.</p>
          )}

          <div hidden={addChoice !== "write"}>
            <EntryEditor
              embedded
              assistantId={assistantId}
              onSaved={(result, session) => {
                if (session.assistantId !== assistantId) return;
                sourcesRes.reload();
                if (expandedSourceId === result.sourceId) {
                  void loadDocuments(
                    result.sourceId,
                    docsState.sourceId === result.sourceId ? docsState.offset : 0,
                  );
                }
              }}
            />
          </div>
          <div hidden={addChoice !== "sitemap"}>
            <SitemapImport
              assistantId={assistantId}
              onImported={sourcesRes.reload}
              onImportingChange={setSitemapImporting}
            />
          </div>
          <div hidden={addChoice !== "cli"}>
            <CliInstructions assistantId={assistantId} />
          </div>
        </section>
      )}

      <ConfirmDialog
        open={confirmSync !== null}
        title={
          confirmSync
            ? confirmSync.action === "now"
              ? `Sync ${sourceName(confirmSync.source)} now?`
              : `Sync ${sourceName(confirmSync.source)} every ${confirmSync.action === "daily" ? "day" : "week"}?`
            : "Sync this source?"
        }
        description="Syncing keeps this source in step with its sitemap: every page the sitemap lists is added, not only the ones you chose when importing; changed pages are updated; and pages it no longer lists are removed. A large sitemap is worked through over several syncs."
        confirmLabel={
          confirmSync?.action === "daily"
            ? "Sync every day"
            : confirmSync?.action === "weekly"
              ? "Sync every week"
              : "Sync now"
        }
        busyLabel={confirmSync?.action === "now" ? "Starting…" : "Saving…"}
        busy={confirmSync !== null && syncBusyIds.has(confirmSync.source.id)}
        onCancel={() => setConfirmSync(null)}
        onConfirm={() => {
          if (!confirmSync) return;
          if (confirmSync.action === "now") void startSync(confirmSync.source);
          else void saveSchedule(confirmSync.source, confirmSync.action);
        }}
      />

      <ConfirmDialog
        open={confirmAnyway !== null}
        title={
          confirmAnyway
            ? `Sync ${sourceName(confirmAnyway.source)} and remove ${formatCount(confirmAnyway.removals)}?`
            : "Sync anyway?"
        }
        description={
          confirmAnyway
            ? `The sitemap no longer lists ${formatCount(confirmAnyway.removals)} of this source. This sync removes ${confirmAnyway.removals === 1 ? "it" : "them"} from your assistant's answers. This cannot be undone. Later syncs keep the usual limit.`
            : ""
        }
        confirmLabel="Sync anyway"
        busyLabel="Starting…"
        tone="danger"
        busy={confirmAnyway !== null && syncBusyIds.has(confirmAnyway.source.id)}
        onCancel={() => setConfirmAnyway(null)}
        onConfirm={() => {
          if (confirmAnyway) void startSync(confirmAnyway.source, confirmAnyway.removals);
        }}
      />

      <ConfirmDialog
        open={confirmDelete !== null}
        title={confirmDelete ? `Delete ${sourceName(confirmDelete)}?` : "Delete source?"}
        description={
          confirmDelete
            ? `Its ${formatCount(confirmDelete.documentCount)} stop being used in answers straight away. This cannot be undone.`
            : ""
        }
        confirmLabel="Delete source"
        busyLabel="Deleting…"
        tone="danger"
        busy={confirmDelete !== null && busySourceId === confirmDelete.id}
        error={deleteError}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (confirmDelete) void handleDeleteSource(confirmDelete);
        }}
      />
    </div>
  );
}
