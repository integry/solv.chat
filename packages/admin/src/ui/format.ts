/**
 * One date format for the whole admin: `16 Nov 2026`, `16 Nov 2026, 23:10`
 * and "3 hours ago". Month names follow the browser's locale; the order is
 * always day, month, year and the clock is always 24-hour, so a date is never
 * shown in the ambiguous US numeric style (`11/16/2026`).
 */

export type DateInput = Date | number | string;

export interface DateFormatOptions {
  /** Defaults to the browser's locale. */
  locale?: string | readonly string[] | undefined;
  /** Defaults to the browser's time zone. Ignored for date-only strings. */
  timeZone?: string | undefined;
}

export interface RelativeFormatOptions extends DateFormatOptions {
  /** The moment to measure from. Defaults to now. */
  now?: DateInput | undefined;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

interface ParsedDate {
  date: Date;
  /** Date-only strings name a calendar day, not an instant: format them in UTC. */
  dateOnly: boolean;
}

function parse(input: DateInput): ParsedDate | null {
  if (typeof input === "string") {
    const match = DATE_ONLY.exec(input.trim());
    if (match) {
      const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
      return Number.isNaN(date.getTime()) ? null : { date, dateOnly: true };
    }
  }
  const date = input instanceof Date ? input : new Date(input);
  return Number.isNaN(date.getTime()) ? null : { date, dateOnly: false };
}

function locales(options: DateFormatOptions): string[] | undefined {
  if (options.locale === undefined) return undefined;
  return typeof options.locale === "string" ? [options.locale] : [...options.locale];
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((p) => p.type === type)?.value ?? "";
}

function datePart({ date, dateOnly }: ParsedDate, options: DateFormatOptions): string {
  const parts = new Intl.DateTimeFormat(locales(options), {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: dateOnly ? "UTC" : options.timeZone,
  }).formatToParts(date);
  return `${part(parts, "day")} ${part(parts, "month")} ${part(parts, "year")}`;
}

function timePart(date: Date, options: DateFormatOptions): string {
  const parts = new Intl.DateTimeFormat(locales(options), {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: options.timeZone,
  }).formatToParts(date);
  return `${part(parts, "hour")}:${part(parts, "minute")}`;
}

/** `16 Nov 2026`. Returns an empty string for an invalid date. */
export function formatDate(input: DateInput, options: DateFormatOptions = {}): string {
  const parsed = parse(input);
  return parsed ? datePart(parsed, options) : "";
}

/** `16 Nov 2026, 23:10`. A date-only string has no time, so only the date is shown. */
export function formatDateTime(input: DateInput, options: DateFormatOptions = {}): string {
  const parsed = parse(input);
  if (!parsed) return "";
  if (parsed.dateOnly) return datePart(parsed, options);
  return `${datePart(parsed, options)}, ${timePart(parsed.date, options)}`;
}

const UNITS: Array<{ unit: Intl.RelativeTimeFormatUnit; seconds: number }> = [
  { unit: "year", seconds: 365 * 24 * 3600 },
  { unit: "month", seconds: 30 * 24 * 3600 },
  { unit: "week", seconds: 7 * 24 * 3600 },
  { unit: "day", seconds: 24 * 3600 },
  { unit: "hour", seconds: 3600 },
  { unit: "minute", seconds: 60 },
];

/**
 * "3 hours ago", "in 2 days", "yesterday", "now". Pair it with the full date
 * (see `RelativeTime`), since "3 weeks ago" alone is vague.
 */
export function formatRelative(input: DateInput, options: RelativeFormatOptions = {}): string {
  const parsed = parse(input);
  const now = parse(options.now ?? Date.now());
  if (!parsed || !now) return "";
  const diffSeconds = (parsed.date.getTime() - now.date.getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locales(options), { numeric: "auto" });
  const abs = Math.abs(diffSeconds);
  for (const { unit, seconds } of UNITS) {
    if (abs >= seconds) {
      return rtf.format(Math.trunc(diffSeconds / seconds), unit);
    }
  }
  return rtf.format(0, "second");
}
