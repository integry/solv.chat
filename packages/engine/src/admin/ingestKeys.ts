import { newId } from "@solvchat/core";

const encoder = new TextEncoder();

/** Returns the lowercase SHA-256 hex digest of `value`. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Returns the plaintext once and the hash to store. The plaintext is never
 * persisted and never logged: an owner who loses it rotates rather than
 * recovers, which is the only design where a database read cannot leak it.
 */
export async function mintIngestKey(): Promise<{ key: string; hash: string }> {
  // Reuse the core id generator: already uniform random and reviewed, so there
  // is no second entropy path to audit.
  const key = `ik_${newId("src").slice(4)}${newId("src").slice(4)}`;
  return { key, hash: await sha256Hex(key) };
}
