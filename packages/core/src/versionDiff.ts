import type { VersionConfig } from "./schemas/versionConfig.js";

/**
 * What changed between two stored version configs, worded for the owner.
 *
 * One table names every setting a version stores: where it lives in the
 * config, the label the admin shows for it, the screen it is edited on and how
 * its values are compared and shown. A setting with no entry fails the
 * schema-walking test in `versionDiff.test.ts` rather than silently missing
 * from the diff.
 */

/** The admin screen a setting is edited on; changes are grouped in this order. */
export type DiffScreen = "Behaviour" | "Widget" | "Tools" | "Tests" | "Spending";

export const DIFF_SCREENS: readonly DiffScreen[] = [
  "Behaviour",
  "Widget",
  "Tools",
  "Tests",
  "Spending",
];

/**
 * - `text`: a short value shown whole, old and new.
 * - `longText`: shown as a word-level diff.
 * - `list`: items added and removed (and whether only the order changed).
 * - `colour`: a hex colour, shown as text beside a swatch.
 * - `boolean`: "On" or "Off".
 * - `secret`: never shown; only that it changed.
 */
export type DiffFieldKind = "text" | "longText" | "list" | "colour" | "boolean" | "secret";

export interface DiffField {
  /** Dot path into `VersionConfig`, such as `behaviour.greeting`. */
  path: string;
  /** The label the admin shows for the setting, in sentence case. */
  label: string;
  screen: DiffScreen;
  kind: DiffFieldKind;
  /** Words for a `text` value, where the stored value is a code (such as `left`). */
  format?: (value: unknown) => string;
}

const POSITION_LABELS: Record<string, string> = {
  right: "Bottom right",
  left: "Bottom left",
};

/** Formats the daily spend cap like the Overview screen (US dollars; 0 is no cap). */
function formatSpendCap(value: unknown): string {
  if (typeof value !== "number" || value <= 0) return "No cap";
  return `$${(value / 1_000_000).toFixed(2)} a day`;
}

/**
 * Every setting a version stores. Labels follow the admin screens; tool
 * credentials are kept on the tool server, not in a version, so no entry is
 * `secret` today (the kind is still handled, and tested, for when one is).
 * Tests are kept per assistant, not per version, so no entry is on Tests.
 */
export const VERSION_DIFF_FIELDS: readonly DiffField[] = [
  { path: "behaviour.greeting", label: "Greeting", screen: "Behaviour", kind: "text" },
  { path: "behaviour.persona", label: "Tone", screen: "Behaviour", kind: "longText" },
  {
    path: "behaviour.fallbackText",
    label: "When it does not know",
    screen: "Behaviour",
    kind: "longText",
  },
  {
    path: "behaviour.suggestedQuestions",
    label: "Suggested questions",
    screen: "Behaviour",
    kind: "list",
  },
  { path: "widget.title", label: "Title", screen: "Widget", kind: "text" },
  { path: "widget.accentColor", label: "Accent colour", screen: "Widget", kind: "colour" },
  {
    path: "widget.position",
    label: "Position",
    screen: "Widget",
    kind: "text",
    format: (value) => POSITION_LABELS[String(value)] ?? String(value),
  },
  { path: "actions.builtins", label: "Help on the page", screen: "Widget", kind: "boolean" },
  {
    path: "actions.allowedOrigins",
    label: "Other sites it may send visitors to",
    screen: "Widget",
    kind: "list",
  },
  { path: "allowedTools", label: "Tools visitors can use", screen: "Tools", kind: "list" },
  {
    path: "limits.dailyCostCapMicros",
    label: "Daily spend cap",
    screen: "Spending",
    kind: "text",
    format: formatSpendCap,
  },
];

/** One run of words in a long-text diff. */
export interface WordPart {
  type: "same" | "added" | "removed";
  text: string;
}

interface ChangeBase {
  path: string;
  label: string;
  screen: DiffScreen;
}

export type ConfigChange =
  | (ChangeBase & { kind: "text" | "colour" | "boolean"; before: string; after: string })
  | (ChangeBase & { kind: "longText"; before: string; after: string; words: WordPart[] })
  | (ChangeBase & {
      kind: "list";
      before: string[];
      after: string[];
      added: string[];
      removed: string[];
      /** Same items, different order. */
      reordered: boolean;
    })
  // No values at all: a credential is never part of a diff.
  | (ChangeBase & { kind: "secret"; summary: string });

export interface ConfigChangeGroup {
  screen: DiffScreen;
  changes: ConfigChange[];
}

function readPath(config: unknown, path: string): unknown {
  let value: unknown = config;
  for (const key of path.split(".")) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function asText(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : String(value);
}

function asList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(asText) : [];
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

/** Splits text into words and the whitespace between them, keeping both. */
function tokenize(text: string): string[] {
  return text.split(/(\s+)/).filter((token) => token !== "");
}

/** Above this many cells the LCS table is skipped and the text shown as replaced whole. */
const MAX_DIFF_CELLS = 4_000_000;

function pushPart(parts: WordPart[], type: WordPart["type"], text: string): void {
  const last = parts[parts.length - 1];
  if (last && last.type === type) last.text += text;
  else parts.push({ type, text });
}

/**
 * Word-level diff of two texts: runs of unchanged, removed and added words,
 * whitespace included, so joining the `same` and `removed` parts gives the old
 * text and joining `same` and `added` gives the new one.
 */
export function diffWords(before: string, after: string): WordPart[] {
  const a = tokenize(before);
  const b = tokenize(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const parts: WordPart[] = [];
  for (let i = 0; i < start; i++) pushPart(parts, "same", a[i] as string);

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) {
    if (n > 0) pushPart(parts, "removed", midA.join(""));
    if (m > 0) pushPart(parts, "added", midB.join(""));
  } else {
    // lcs[i][j]: longest common subsequence of midA[i..] and midB[j..].
    const width = m + 1;
    const lcs = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * width + j] =
          midA[i] === midB[j]
            ? (lcs[(i + 1) * width + j + 1] as number) + 1
            : Math.max(lcs[(i + 1) * width + j] as number, lcs[i * width + j + 1] as number);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        pushPart(parts, "same", midA[i] as string);
        i++;
        j++;
      } else if (
        j >= m ||
        (i < n && (lcs[(i + 1) * width + j] as number) >= (lcs[i * width + j + 1] as number))
      ) {
        pushPart(parts, "removed", midA[i] as string);
        i++;
      } else {
        pushPart(parts, "added", midB[j] as string);
        j++;
      }
    }
  }

  for (let k = endA; k < a.length; k++) pushPart(parts, "same", a[k] as string);
  return parts;
}

function secretSummary(before: unknown, after: unknown): string {
  const had = before !== undefined && before !== null && before !== "" && before !== false;
  const has = after !== undefined && after !== null && after !== "" && after !== false;
  if (had && has) return "Credential replaced";
  return has ? "Credential added" : "Credential removed";
}

function diffField(field: DiffField, beforeRaw: unknown, afterRaw: unknown): ConfigChange | null {
  const base: ChangeBase = { path: field.path, label: field.label, screen: field.screen };
  switch (field.kind) {
    case "secret": {
      if (JSON.stringify(beforeRaw) === JSON.stringify(afterRaw)) return null;
      return { ...base, kind: "secret", summary: secretSummary(beforeRaw, afterRaw) };
    }
    case "list": {
      const before = asList(beforeRaw);
      const after = asList(afterRaw);
      if (sameList(before, after)) return null;
      const added = after.filter((item) => !before.includes(item));
      const removed = before.filter((item) => !after.includes(item));
      return {
        ...base,
        kind: "list",
        before,
        after,
        added,
        removed,
        reordered: added.length === 0 && removed.length === 0,
      };
    }
    case "boolean": {
      const before = beforeRaw === true;
      const after = afterRaw === true;
      if (before === after) return null;
      return {
        ...base,
        kind: "boolean",
        before: before ? "On" : "Off",
        after: after ? "On" : "Off",
      };
    }
    case "longText": {
      const before = asText(beforeRaw);
      const after = asText(afterRaw);
      if (before === after) return null;
      return { ...base, kind: "longText", before, after, words: diffWords(before, after) };
    }
    default: {
      if (beforeRaw === afterRaw) return null;
      const show = field.format ?? asText;
      return { ...base, kind: field.kind, before: show(beforeRaw), after: show(afterRaw) };
    }
  }
}

/**
 * Every setting that differs from `before` to `after`, in field-table order.
 * Pure: reads only the two configs and the table. An empty list means nothing
 * a visitor would notice has changed.
 */
export function diffVersionConfigs(
  before: VersionConfig,
  after: VersionConfig,
  fields: readonly DiffField[] = VERSION_DIFF_FIELDS,
): ConfigChange[] {
  const changes: ConfigChange[] = [];
  for (const field of fields) {
    const change = diffField(field, readPath(before, field.path), readPath(after, field.path));
    if (change) changes.push(change);
  }
  return changes;
}

/** Changes grouped by screen, in `DIFF_SCREENS` order, leaving out screens with none. */
export function groupChanges(changes: readonly ConfigChange[]): ConfigChangeGroup[] {
  return DIFF_SCREENS.map((screen) => ({
    screen,
    changes: changes.filter((change) => change.screen === screen),
  })).filter((group) => group.changes.length > 0);
}

/** One line for a History row, such as "3 changes: greeting, tone, accent colour". */
export function summarizeChanges(changes: readonly ConfigChange[]): string {
  if (changes.length === 0) return "No changes";
  const names = changes.map((change) => change.label.toLowerCase()).join(", ");
  return `${changes.length} ${changes.length === 1 ? "change" : "changes"}: ${names}`;
}
