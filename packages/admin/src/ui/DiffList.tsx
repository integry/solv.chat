import { type ConfigChange, groupChanges, type WordPart } from "@solvchat/core";

export interface DiffListProps {
  changes: readonly ConfigChange[];
  /** Shown instead of the list when there is nothing to show. */
  emptyText?: string;
  /** Level of the per-screen headings (default 3, under a dialog or panel heading). */
  headingLevel?: 3 | 4;
}

/** "Was" / "Now" pair, so a change never depends on colour or position alone. */
function WasNow({
  before,
  after,
  swatch = false,
}: {
  before: string;
  after: string;
  swatch?: boolean;
}) {
  return (
    <dl className="diff-was-now">
      <div>
        <dt>Was</dt>
        <dd>
          {swatch && (
            <span className="diff-swatch" style={{ background: before }} aria-hidden="true" />
          )}
          {before === "" ? <span className="muted">(empty)</span> : before}
        </dd>
      </div>
      <div>
        <dt>Now</dt>
        <dd>
          {swatch && (
            <span className="diff-swatch" style={{ background: after }} aria-hidden="true" />
          )}
          {after === "" ? <span className="muted">(empty)</span> : after}
        </dd>
      </div>
    </dl>
  );
}

/**
 * Word-level diff. Removed words are struck through inside `<del>` and added
 * words underlined inside `<ins>`, each with hidden "removed"/"added" words
 * for screen readers, so the change is not carried by colour alone.
 */
function WordDiff({ words }: { words: readonly WordPart[] }) {
  return (
    <p className="diff-words">
      {words.map((part, i) => {
        // Index keys: the parts are a fixed rendering of one diff and never reorder.
        const key = `${i}-${part.type}`;
        if (part.type === "removed") {
          return (
            <del key={key}>
              <span className="sr-only">[removed: </span>
              {part.text}
              <span className="sr-only">]</span>
            </del>
          );
        }
        if (part.type === "added") {
          return (
            <ins key={key}>
              <span className="sr-only">[added: </span>
              {part.text}
              <span className="sr-only">]</span>
            </ins>
          );
        }
        return <span key={key}>{part.text}</span>;
      })}
    </p>
  );
}

function ListChange({ change }: { change: Extract<ConfigChange, { kind: "list" }> }) {
  if (change.reordered) {
    return (
      <>
        <p className="diff-note">Same items, new order.</p>
        <WasNow before={change.before.join(", ")} after={change.after.join(", ")} />
      </>
    );
  }
  return (
    <ul className="diff-items">
      {change.added.map((item) => (
        <li key={`added-${item}`} className="diff-item-added">
          <span className="diff-mark">Added:</span> {item}
        </li>
      ))}
      {change.removed.map((item) => (
        <li key={`removed-${item}`} className="diff-item-removed">
          <span className="diff-mark">Removed:</span> {item}
        </li>
      ))}
    </ul>
  );
}

function ChangeBody({ change }: { change: ConfigChange }) {
  switch (change.kind) {
    case "secret":
      // Only the fact of the change: a credential's value is never shown.
      return <p className="diff-note">{change.summary}</p>;
    case "list":
      return <ListChange change={change} />;
    case "longText":
      return <WordDiff words={change.words} />;
    case "colour":
      return <WasNow before={change.before} after={change.after} swatch />;
    default:
      return <WasNow before={change.before} after={change.after} />;
  }
}

/** The changes between two versions, grouped by the screen each setting is on. */
export function DiffList({
  changes,
  emptyText = "Nothing has changed.",
  headingLevel = 3,
}: DiffListProps) {
  if (changes.length === 0) return <p className="muted diff-empty">{emptyText}</p>;
  const Heading = headingLevel === 4 ? "h4" : "h3";
  return (
    <div className="diff-list">
      {groupChanges(changes).map((group) => (
        <section key={group.screen} className="diff-group" aria-label={group.screen}>
          <Heading className="diff-group-heading">{group.screen}</Heading>
          <ul className="diff-changes">
            {group.changes.map((change) => (
              <li key={change.path} className="diff-change">
                <span className="diff-label">{change.label}</span>
                <ChangeBody change={change} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
