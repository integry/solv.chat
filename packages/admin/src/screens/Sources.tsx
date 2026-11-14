import type { SourceKind } from "@solvchat/core";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ApiError, deleteJson, getJson, postJson } from "../api/client.js";
import type { DocumentSummary, SourceSummary } from "../api/types.js";
import { useResource } from "../api/useResource.js";
import { EntryEditor } from "./EntryEditor.js";

export interface SourcesProps {
  assistantId: string;
}

const DOCS_PAGE_SIZE = 20;

const KIND_LABELS: Record<SourceKind, string> = {
  push: "Pushed from your site",
  entry: "Answers you wrote",
  sitemap: "Imported once from a sitemap",
};

function formatCount(count: number): string {
  return count === 1 ? "1 document" : `${count} documents`;
}

function formatDate(timestamp: number | null): string {
  if (timestamp === null) return "Never";
  return new Date(timestamp).toLocaleString();
}

function stripLeadingHeading(markdown: string, title: string): string {
  const prefix = `# ${title}\n\n`;
  if (markdown.startsWith(prefix)) {
    return markdown.slice(prefix.length);
  }
  return markdown;
}

function SitemapImport({
  assistantId,
  onImported,
}: {
  assistantId: string;
  onImported: () => void;
}) {
  const [sitemapUrl, setSitemapUrl] = useState("");
  const [previewUrls, setPreviewUrls] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [fetching, setFetching] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function handlePreview(event: FormEvent) {
    event.preventDefault();
    if (fetching || importing) return;
    setFetching(true);
    setError(null);
    setNotice(null);

    try {
      const res = await postJson<{ urls: string[] }>(
        `/api/admin/assistants/${assistantId}/sitemap-preview`,
        { url: sitemapUrl },
      );
      setPreviewUrls(res.urls);
      setSelected(new Set(res.urls));
      if (res.urls.length === 0) {
        setNotice("No pages found in that sitemap.");
      }
    } catch (err) {
      setPreviewUrls(null);
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
    if (importing || !previewUrls || selected.size === 0) return;
    setImporting(true);
    setError(null);
    setNotice(null);

    try {
      const chosen = previewUrls.filter((u) => selected.has(u));
      const res = await postJson<{ total: number }>(
        `/api/admin/assistants/${assistantId}/sitemap-import`,
        { sitemapUrl, urls: chosen },
      );
      setPreviewUrls(null);
      setSelected(new Set());
      setSitemapUrl("");
      setNotice(res.total === 1 ? "Imported 1 page." : `Imported ${res.total} pages.`);
      onImported();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.fields.urls ?? err.fields.url ?? err.message);
      } else {
        setError("Could not import those pages. Try again.");
      }
    } finally {
      setImporting(false);
    }
  }

  return (
    <section className="source-card stack" aria-labelledby="sitemap-import-heading">
      <div>
        <h2 id="sitemap-import-heading" className="section-heading">
          Import once from a sitemap
        </h2>
        <p className="field-hint">
          Enter a sitemap URL to list its pages and choose which ones to import once. This is a
          one-off import, not a crawl.
        </p>
      </div>

      <form className="stack" onSubmit={(e) => void handlePreview(e)}>
        <div className="field">
          <label htmlFor="sitemap-url">Sitemap URL</label>
          <input
            id="sitemap-url"
            type="url"
            value={sitemapUrl}
            disabled={fetching || importing}
            onChange={(e) => setSitemapUrl(e.target.value)}
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

      {previewUrls && previewUrls.length > 0 && (
        <div className="stack">
          <div className="sitemap-toolbar">
            <span className="muted">
              {selected.size} of {previewUrls.length} selected
            </span>
            <div className="actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={importing}
                onClick={() => setSelected(new Set(previewUrls))}
              >
                Select all
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={importing}
                onClick={() => setSelected(new Set())}
              >
                Clear all
              </button>
            </div>
          </div>

          <ul className="sitemap-url-list">
            {previewUrls.map((url) => (
              <li key={url} className="sitemap-url-item">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={selected.has(url)}
                    disabled={importing}
                    onChange={() => toggleUrl(url)}
                  />
                  <span>{url}</span>
                </label>
              </li>
            ))}
          </ul>

          <div className="actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={importing || selected.size === 0}
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
    </section>
  );
}

export function Sources({ assistantId }: SourcesProps) {
  const sourcesRes = useResource<{ sources: SourceSummary[] }>(
    `/api/admin/assistants/${assistantId}/sources`,
  );
  const sources = sourcesRes.value?.sources ?? [];

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

  const [editingEntry, setEditingEntry] = useState<{
    sourceId: string;
    documentId: string;
    question: string;
    answer: string;
  } | null>(null);

  const [busySourceId, setBusySourceId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    void assistantId;
    docsRequestRef.current?.controller.abort();
    docsRequestRef.current = null;
    docsRequestSeqRef.current++;
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
    };
  }, []);

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

  function handleToggleDocuments(sourceId: string) {
    if (expandedSourceId === sourceId) {
      docsRequestRef.current?.controller.abort();
      docsRequestRef.current = null;
      docsRequestSeqRef.current++;
      setExpandedSourceId(null);
      return;
    }
    setExpandedSourceId(sourceId);
    void loadDocuments(sourceId, 0);
  }

  async function handleEditEntry(sourceId: string, doc: DocumentSummary) {
    setActionError(null);
    try {
      const res = await getJson<{ document: DocumentSummary; markdown: string }>(
        `/api/admin/sources/${sourceId}/documents/${doc.id}`,
      );
      setEditingEntry({
        sourceId,
        documentId: doc.id,
        question: res.document.title,
        answer: stripLeadingHeading(res.markdown, res.document.title),
      });
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not load entry.");
    }
  }

  async function handleDeleteSource(sourceId: string) {
    if (busySourceId !== null) return;
    setBusySourceId(sourceId);
    setActionError(null);
    try {
      await deleteJson(`/api/admin/sources/${sourceId}`);
      if (expandedSourceId === sourceId) {
        docsRequestRef.current?.controller.abort();
        docsRequestRef.current = null;
        docsRequestSeqRef.current++;
        setExpandedSourceId(null);
      }
      if (editingEntry?.sourceId === sourceId) setEditingEntry(null);
      sourcesRes.reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not delete source.");
    } finally {
      setBusySourceId(null);
    }
  }

  if (sourcesRes.status === "loading" && !sourcesRes.value) {
    return <p className="muted">Loading sources…</p>;
  }
  if (sourcesRes.status === "error") {
    return (
      <p className="error-text" role="alert">
        {sourcesRes.error}
      </p>
    );
  }

  return (
    <div className="screen">
      <div className="screen-header">
        <div>
          <h1>Sources</h1>
          <p className="muted">Where your assistant&apos;s answers come from.</p>
        </div>
      </div>

      {actionError && (
        <p className="error-text" role="alert">
          {actionError}
        </p>
      )}

      {sources.length === 0 ? (
        <p className="muted">
          No sources yet. Push your site with <code>solv push</code>, write an answer below, or
          import once from a sitemap.
        </p>
      ) : (
        <ul className="source-list">
          {sources.map((source) => {
            const expanded = expandedSourceId === source.id;
            const isPush = source.kind === "push";
            return (
              <li key={source.id} className="source-card stack">
                <div className="source-row-header">
                  <div>
                    <div className="source-kind">{KIND_LABELS[source.kind]}</div>
                    <div className="source-label">{source.label}</div>
                    <div className="muted">
                      {formatCount(source.documentCount)} · Updated{" "}
                      {formatDate(source.lastUpdatedAt)}
                    </div>
                  </div>
                  <div className="actions">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => handleToggleDocuments(source.id)}
                    >
                      {expanded ? "Hide documents" : "View documents"}
                    </button>
                    {!isPush && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={busySourceId === source.id}
                        onClick={() => void handleDeleteSource(source.id)}
                      >
                        {busySourceId === source.id ? "Deleting…" : "Delete"}
                      </button>
                    )}
                  </div>
                </div>

                {isPush && (
                  <p className="field-hint">
                    Read-only. Update pushed pages from your site with <code>solv push</code>.
                  </p>
                )}

                {expanded &&
                  (() => {
                    const activeDocs = docsState.sourceId === source.id ? docsState : null;
                    const start = activeDocs ? activeDocs.offset + 1 : 0;
                    const end = activeDocs ? activeDocs.offset + activeDocs.documents.length : 0;
                    const hasPrev = activeDocs ? activeDocs.offset > 0 : false;
                    const hasNext = activeDocs ? end < activeDocs.total : false;
                    return (
                      <div className="source-docs stack">
                        {!activeDocs ||
                        (activeDocs.loading && activeDocs.documents.length === 0) ? (
                          <p className="muted">Loading documents…</p>
                        ) : activeDocs.error ? (
                          <p className="error-text" role="alert">
                            {activeDocs.error}
                          </p>
                        ) : activeDocs.documents.length === 0 ? (
                          <p className="muted">No documents in this source yet.</p>
                        ) : (
                          <>
                            <ul className="source-doc-list">
                              {activeDocs.documents.map((doc) => (
                                <li key={doc.id} className="source-doc-item">
                                  <div>
                                    <div className="source-doc-title">{doc.title}</div>
                                    <div className="muted">
                                      {doc.url} · {formatDate(doc.updatedAt)}
                                    </div>
                                  </div>
                                  {source.kind === "entry" && (
                                    <button
                                      type="button"
                                      className="btn btn-secondary btn-sm"
                                      onClick={() => void handleEditEntry(source.id, doc)}
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
                                        source.id,
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
                                      void loadDocuments(
                                        source.id,
                                        activeDocs.offset + DOCS_PAGE_SIZE,
                                      )
                                    }
                                  >
                                    Next
                                  </button>
                                </div>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })()}
              </li>
            );
          })}
        </ul>
      )}

      <EntryEditor
        assistantId={assistantId}
        sourceId={editingEntry?.sourceId}
        documentId={editingEntry?.documentId}
        initialQuestion={editingEntry?.question}
        initialAnswer={editingEntry?.answer}
        onCancel={editingEntry ? () => setEditingEntry(null) : undefined}
        onSaved={(result) => {
          setEditingEntry(null);
          sourcesRes.reload();
          if (expandedSourceId === result.sourceId) {
            void loadDocuments(
              result.sourceId,
              docsState.sourceId === result.sourceId ? docsState.offset : 0,
            );
          }
        }}
      />

      <SitemapImport
        assistantId={assistantId}
        onImported={() => {
          sourcesRes.reload();
        }}
      />
    </div>
  );
}
