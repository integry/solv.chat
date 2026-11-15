/**
 * Fields a spreadsheet would treat as a formula. A visitor's question is
 * arbitrary text and it lands in this file, so a leading one of these is
 * prefixed. Not theoretical: the point of the export is that someone opens it
 * in a spreadsheet.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

function escapeField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '""';
  const text = typeof value === "number" ? String(value) : value;
  // The single quote keeps the text readable while stopping evaluation.
  const safe = FORMULA_START.test(text) ? `'${text}` : text;
  // Always quoted, quotes doubled: a question may contain a comma, a quote or
  // a newline, and quoting unconditionally removes the judgement call.
  return `"${safe.replace(/"/g, '""')}"`;
}

export interface CsvSection {
  title: string;
  header: readonly string[];
  rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>;
}

/**
 * Builds a CSV from titled sections. CRLF endings, because that is what
 * spreadsheet software expects on every platform and the file is for them, not
 * for a terminal.
 */
export function buildCsv(sections: readonly CsvSection[]): string {
  const lines: string[] = [];
  for (const section of sections) {
    if (lines.length > 0) lines.push("");
    lines.push(escapeField(section.title));
    lines.push(section.header.map(escapeField).join(","));
    for (const row of section.rows) lines.push(row.map(escapeField).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
