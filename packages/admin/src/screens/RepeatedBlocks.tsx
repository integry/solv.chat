import type { RepeatedBlocks } from "@solvchat/core";
import { useResource } from "../api/useResource.js";
import { ErrorState } from "../ui/ErrorState.js";
import { Skeleton } from "../ui/Skeleton.js";

/** "3 repeated parts left out", for the Status column. */
export function repeatedBlocksText(count: number): string {
  return count === 1 ? "1 repeated part left out" : `${count} repeated parts left out`;
}

/**
 * The text left out of a source's pages because it is on most of them (a
 * footer, a cookie notice, a "related" box), with the start of each, so the
 * owner can see what the assistant does not read. Shown under the source's
 * documents.
 */
export function RepeatedBlocksList({ sourceId, count }: { sourceId: string; count: number }) {
  const res = useResource<RepeatedBlocks>(
    count > 0 ? `/api/admin/sources/${encodeURIComponent(sourceId)}/repeated-blocks` : null,
  );
  if (count === 0) return null;
  return (
    <section className="repeated-blocks stack" aria-labelledby={`repeated-${sourceId}`}>
      <h3 id={`repeated-${sourceId}`} className="repeated-blocks-heading">
        Left out: text on most pages
      </h3>
      <p className="field-hint">
        This text is on most pages of this source, like a footer or a cookie notice, so your
        assistant does not read it. A page that is mostly this text keeps it.
      </p>
      {res.status === "error" && res.value === undefined ? (
        <ErrorState
          title="Could not load the left-out text."
          detail={res.error}
          onRetry={res.reload}
        />
      ) : res.value === undefined ? (
        <Skeleton label="Loading left-out text…" lines={2} />
      ) : (
        <ul className="repeated-block-list">
          {res.value.blocks.map((block, i) => (
            // Blocks have no id of their own; the list is read-only and
            // replaced as a whole.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            <li key={i} className="repeated-block-item">
              <span className="repeated-block-text">
                {block.text === null ? (
                  <span className="muted">Text not available</span>
                ) : (
                  `${block.text}${block.truncated ? "…" : ""}`
                )}
              </span>
              <span className="muted repeated-block-pages">
                {block.pages === 1 ? "1 page" : `${block.pages} pages`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
