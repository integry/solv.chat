import type { SourceKind } from "@solvchat/core";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ApiError, deleteJson, getJson, postJson } from "../api/client.js";
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

export interface SourcesProps {
  assistantId: string;
}

const DOCS_PAGE_SIZE = 20;
const MAX_IMPORT_URLS = 100;
// The engine imports at most this many pages per request so one request
// stays inside the Workers subrequest limit; a selection goes in batches.
export const IMPORT_BATCH_URLS = 5;
/** How often the list is checked while something is being indexed. */
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
}: {
  assistantId: string;
  onImported: () => void;
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
        Lists the pages in a sitemap so you can choose which to copy in. This is a one-off import,
        not a crawl: run it again from the source's menu when the pages change.
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
    text: "Copy pages from your site once.",
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
  const sources = sourcesRes.value?.sources ?? [];
  const anyIndexing = sources.some((s) => (s.indexingCount ?? 0) > 0);

  const [addChoice, setAddChoice] = useState<AddChoice | null>(null);
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
  useEffect(() => {
    if (!anyIndexing || !sourcesReady) return;
    const timer = setTimeout(reloadSources, INDEXING_POLL_MS);
    return () => clearTimeout(timer);
  }, [anyIndexing, sourcesReady, reloadSources]);

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

  function chooseAdd(choice: AddChoice) {
    setAddChoice(choice);
    requestAnimationFrame(() => addPanelRef.current?.focus());
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
      const preview = await postJson<{ urls: string[] }>(
        `/api/admin/assistants/${assistantId}/sitemap-preview`,
        { url },
      );
      const urls = preview.urls.slice(0, MAX_IMPORT_URLS);
      if (urls.length === 0) {
        setActionError(`No pages found in ${url}.`);
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

  if (sourcesRes.status === "loading" && !sourcesRes.value) {
    return (
      <div className="screen">
        <PageHeader title="Sources" description="Where your assistant's answers come from." />
        <Skeleton label="Loading sources…" lines={4} />
      </div>
    );
  }
  if (sourcesRes.status === "error") {
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
            <StatusBadge tone="info">Reading sitemap…</StatusBadge>
          ) : (
            <ImportProgress done={reimport.done} total={reimport.total} label="Re-importing" />
          );
        }
        const status = indexStatus(source);
        return (
          <div className="source-status">
            <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
            {status.hint && <span className="source-status-hint">{status.hint}</span>}
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
            disabled: reimport !== null,
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
            aria-expanded={addChoice !== null}
            aria-controls="add-content"
            onClick={() => (addChoice === null ? chooseAdd("write") : setAddChoice(null))}
          >
            <Icon name="plus" />
            Add content
          </button>
        }
      />

      {actionError && (
        <p className="error-text" role="alert">
          {actionError}
        </p>
      )}

      {sources.length === 0 ? (
        addChoice === null && (
          <EmptyState
            icon="sources"
            title="No sources yet"
            description="Write an answer, import pages from a sitemap, or push them from your site's build."
            action={
              <button type="button" className="btn btn-primary" onClick={() => chooseAdd("write")}>
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

      {addChoice !== null && (
        <section
          ref={addPanelRef}
          id="add-content"
          className="source-card stack add-content"
          aria-labelledby="add-content-heading"
          tabIndex={-1}
        >
          <div className="source-row-header">
            <h2 id="add-content-heading" className="section-heading">
              Add content
            </h2>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setAddChoice(null)}
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
                  onChange={() => setAddChoice(choice.id)}
                />
                <Icon name={choice.icon} size={20} />
                <span className="choice-card-text">
                  <span className="choice-card-title">{choice.title}</span>
                  <span className="choice-card-hint">{choice.text}</span>
                </span>
              </label>
            ))}
          </fieldset>

          {addChoice === "write" && (
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
          )}
          {addChoice === "sitemap" && (
            <SitemapImport assistantId={assistantId} onImported={() => sourcesRes.reload()} />
          )}
          {addChoice === "cli" && <CliInstructions assistantId={assistantId} />}
        </section>
      )}

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
