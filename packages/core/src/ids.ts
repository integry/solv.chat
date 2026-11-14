/** Prefixes for the identifiers used across the engine. */
export type IdPrefix =
  | "org"
  | "ast"
  | "ver"
  | "src"
  | "doc"
  | "chk"
  | "cnv"
  | "msg"
  | "fbk"
  | "mcp"
  | "tst";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const BODY_LENGTH = 20;

/** Returns a random identifier such as `ast_4k2…`, safe to expose in URLs. */
export function newId(prefix: IdPrefix): string {
  let body = "";
  while (body.length < BODY_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(BODY_LENGTH))) {
      // 252 is the largest multiple of 36 that fits in a byte; skipping the
      // values above it keeps every character equally likely.
      if (byte < 252 && body.length < BODY_LENGTH) body += ALPHABET[byte % ALPHABET.length];
    }
  }
  return `${prefix}_${body}`;
}

/** True when `value` is a well-formed identifier with the given prefix. */
export function isId(value: unknown, prefix: IdPrefix): value is string {
  return (
    typeof value === "string" && new RegExp(`^${prefix}_[0-9a-z]{${BODY_LENGTH}}$`).test(value)
  );
}
