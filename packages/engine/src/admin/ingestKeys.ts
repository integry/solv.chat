import { newId } from "@solvchat/core";
import { sha256Hex } from "../util/crypto.js";

export { sha256Hex };

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
