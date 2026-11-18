/**
 * Topic names for visitor questions (see "Topics" in docs/architecture.md).
 *
 * A topic name is proposed by the answer review's model after it read the
 * visitor's question, so it is untrusted text, and it is shown in the admin and
 * written into the Reports CSV. Owners can rename topics too; their names pass
 * the same checks. A topic must never capture personal data, so anything that
 * looks like a web, email or street address, or a number longer than 6 digits
 * (a phone, card or account number), is refused rather than repaired.
 */

/** Most characters (code points) in a topic name. */
export const TOPIC_NAME_MAX_LENGTH = 40;
/** Most words in a topic name ("2-4 words"; one is allowed for scripts without spaces). */
export const TOPIC_MAX_WORDS = 4;
/**
 * Most topics one assistant may have, not counting `OTHER_TOPIC`: once the
 * list is full the reviewer must pick an existing topic, and a new proposal
 * becomes "Other", which is always available.
 */
export const MAX_TOPICS_PER_ASSISTANT = 40;
/** The topic for a question that fits no other, and the fallback for a refused name. */
export const OTHER_TOPIC = "Other";

// Characters a name may keep once markup is gone: letters, combining marks and
// digits in any script, spaces, and a little punctuation names use ("Returns
// & refunds", "Log-in", "Opening hours/days"). No `.` (a web address), no `@`
// (an email), no `:` or quotes. Checked after NFKC, so full-width forms are
// folded first.
const ALLOWED = /^[\p{L}\p{M}\p{N} &'’/,-]+$/u;
// The first character must be a letter or a digit: a name that opens with `=`,
// `+`, `-` or `@` reads as a formula in a spreadsheet, and the CSV is opened in one.
const STARTS_WELL = /^[\p{L}\p{N}]/u;
const TAG = /<[^>]*>/g;
// Markdown and other markup characters, removed rather than refused: a model
// that bolds its label still named a topic.
const MARKUP = /[*_`~#>|[\]{}()"“”«»<\\]/g;
// Control, format (zero-width, direction overrides), private-use, surrogate
// and unassigned code points.
const CONTROL = /\p{C}/gu;
const EDGE_PUNCTUATION = /^[\s'’,.:;!?/&-]+|[\s'’,.:;!?/&-]+$/gu;
const WEB = /\b(?:https?|www|ftp|mailto)\b/i;
// A number and a street word in one name reads as a street address
// ("12 Baker Street", "Hauptstraße 5"). Postcodes in the UK form are caught
// on their own; others are numbers, under the digit rule.
const STREET_WORDS =
  /(?:^|[\s,/-])(?:street|st|road|rd|avenue|ave|av|lane|ln|drive|dr|boulevard|blvd|court|ct|place|pl|square|sq|way|highway|hwy|terrace|crescent|close|apt|apartment|suite|unit|flat|floor|po box|strasse|straße|str|weg|gasse|platz|allee|ring|rue|avenida|calle|carrer|rua|via|viale|piazza|corso|ulica|ul|straat|laan|plein|gade|gatan|vägen|katu|tie)(?=$|[\s,/-])/iu;
const ADDRESS_SUFFIX =
  /\p{L}(?:strasse|straße|str|weg|gasse|platz|allee|straat|laan|gatan|vägen|katu)(?=$|[\s,/-])/iu;
const UK_POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i;
const DIGIT = /\p{Nd}/u;
const LONG_NUMBER = /\p{Nd}{7,}/u;
// Every non-alphanumeric character `ALLOWED` keeps can group digits
// ("1 234 567", "1'234'567", "1’234’567", "1/234/567", "1&234&567"), so all of
// them are ignored between digits before the length is counted.
const NUMBER_SEPARATOR = /(\p{Nd})[\s&'’/,-]+(?=\p{Nd})/gu;

/** Why a name was refused, for the owner's rename; the reviewer's proposals just fall back. */
export type TopicNameProblem = "empty" | "too_long" | "too_many_words" | "characters" | "personal";

/**
 * A topic name made safe to store and show, or the reason it cannot be. Tags,
 * markup characters, control and format characters are removed; the rest is
 * NFKC-normalised, whitespace collapsed and surrounding punctuation trimmed.
 * What is left must be 1 to `TOPIC_NAME_MAX_LENGTH` characters and at most
 * `TOPIC_MAX_WORDS` words of allowed characters, and must not look like
 * personal data.
 */
export function checkTopicName(
  raw: unknown,
): { ok: true; name: string } | { ok: false; problem: TopicNameProblem } {
  if (typeof raw !== "string") return { ok: false, problem: "empty" };
  // Bounded before any regular expression runs on it.
  const name = raw
    .slice(0, 400)
    .replace(TAG, " ")
    .replace(CONTROL, " ")
    .normalize("NFKC")
    .replace(MARKUP, " ")
    .replace(/\s+/gu, " ")
    .replace(EDGE_PUNCTUATION, "")
    .trim();
  if (name === "") return { ok: false, problem: "empty" };
  if (Array.from(name).length > TOPIC_NAME_MAX_LENGTH) return { ok: false, problem: "too_long" };
  if (name.split(" ").length > TOPIC_MAX_WORDS) return { ok: false, problem: "too_many_words" };
  if (!ALLOWED.test(name) || !STARTS_WELL.test(name)) {
    // `@` and `.` are refused here, which is where an email or a web address
    // would fail; reported as personal data so the owner knows why.
    return { ok: false, problem: /[@.]/.test(raw) ? "personal" : "characters" };
  }
  if (looksPersonal(name)) return { ok: false, problem: "personal" };
  return { ok: true, name };
}

/** A safe topic name, or null: the reviewer's proposal then becomes `OTHER_TOPIC`. */
export function cleanTopicName(raw: unknown): string | null {
  const checked = checkTopicName(raw);
  return checked.ok ? checked.name : null;
}

function looksPersonal(name: string): boolean {
  if (WEB.test(name)) return true;
  if (UK_POSTCODE.test(name)) return true;
  if (LONG_NUMBER.test(name.replace(NUMBER_SEPARATOR, "$1"))) return true;
  if (DIGIT.test(name) && (STREET_WORDS.test(name) || ADDRESS_SUFFIX.test(name))) return true;
  return false;
}

/**
 * How two names are compared: NFKC, lowercase, whitespace collapsed. Unique
 * per assistant (`topics.name_key`), so "Opening hours" and "opening  HOURS"
 * are one topic.
 */
export function topicKey(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

/** The key of `OTHER_TOPIC`. */
export const OTHER_TOPIC_KEY = topicKey(OTHER_TOPIC);
