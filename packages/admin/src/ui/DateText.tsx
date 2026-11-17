import {
  type DateFormatOptions,
  type DateInput,
  formatDateTime,
  formatRelative,
} from "./format.js";

export interface RelativeTimeProps extends DateFormatOptions {
  value: DateInput;
  now?: DateInput;
}

function toIso(value: DateInput): string | undefined {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** "3 hours ago", with the full date and time as its tooltip. */
export function RelativeTime({ value, now, ...options }: RelativeTimeProps) {
  return (
    <time dateTime={toIso(value)} title={formatDateTime(value, options)}>
      {formatRelative(value, { ...options, now })}
    </time>
  );
}
