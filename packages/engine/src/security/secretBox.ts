// AES-256-GCM sealing for stored tool credentials.
//
// Source for the WebCrypto subset available on Workers (importKey, deriveBits
// with HKDF, encrypt/decrypt with AES-GCM):
// https://developers.cloudflare.com/workers/runtime-apis/web-crypto/ — checked 2026-11-15

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Version prefix of the stored form, so the format can change later. */
const FORMAT = "v1";
/** GCM's standard nonce length; a different length is a different format. */
const NONCE_BYTES = 12;
/**
 * A static header value, not a document. Bounded so a mistake in the admin
 * cannot put kilobytes into a column read on every tool call.
 */
export const MAX_SECRET_LENGTH = 4096;

/**
 * Labels that keep the two uses of SOLV_SECRET_KEY apart. Changing a label
 * invalidates everything derived under it, so they are constants, not
 * parameters.
 */
export const SESSION_KEY_INFO = "solv.chat session cookie v1";
export const SECRET_BOX_KEY_INFO = "solv.chat stored credential v1";

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new SecretBoxError();
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Derives `length` bytes from the Worker secret under `info`.
 *
 * HKDF rather than the raw secret: SOLV_SECRET_KEY is a value a person chose
 * or generated with `openssl rand -base64 32`, so it is neither 32 bytes nor
 * uniform, and AES-256 needs exactly that. The info label is what makes the
 * session key and the credential key independent.
 */
export async function deriveKeyBits(
  secret: string,
  info: string,
  length = 32,
): Promise<ArrayBuffer> {
  if (secret.length === 0) throw new SecretBoxError();
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
    "deriveBits",
  ]);
  return crypto.subtle.deriveBits(
    // No salt: the only input an attacker lacks is the secret itself, and a
    // stored salt would add a field without adding that.
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(info) },
    material,
    length * 8,
  );
}

async function aesKey(secret: string): Promise<CryptoKey> {
  const bits = await deriveKeyBits(secret, SECRET_BOX_KEY_INFO);
  return crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Thrown when a stored value cannot be opened. Never names the value. */
export class SecretBoxError extends Error {
  constructor(message = "stored credential could not be read") {
    super(message);
    this.name = "SecretBoxError";
  }
}

/** Encrypts a credential for storage. The result is safe to put in D1. */
export async function sealSecret(secret: string, plaintext: string): Promise<string> {
  if (plaintext.length === 0) throw new SecretBoxError("credential must not be empty");
  if (plaintext.length > MAX_SECRET_LENGTH) {
    throw new SecretBoxError(`credential must be at most ${MAX_SECRET_LENGTH} characters`);
  }
  // A fresh nonce per seal. Reusing one under the same key is the one mistake
  // that breaks GCM outright, so it is generated here and never cached.
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    await aesKey(secret),
    encoder.encode(plaintext),
  );
  return [FORMAT, base64urlEncode(nonce), base64urlEncode(new Uint8Array(sealed))].join(".");
}

/**
 * Decrypts a stored credential. Called only inside the Worker, at the moment
 * an outbound tool call is built; the plaintext never leaves that call.
 */
export async function openSecret(secret: string, stored: string): Promise<string> {
  const parts = stored.split(".");
  // Shape first, so a truncated or foreign row costs no crypto and produces
  // the same error as a wrong key.
  if (parts.length !== 3 || parts[0] !== FORMAT) throw new SecretBoxError();
  let nonce: Uint8Array<ArrayBuffer>;
  let body: Uint8Array<ArrayBuffer>;
  try {
    nonce = base64urlDecode(parts[1] ?? "");
    body = base64urlDecode(parts[2] ?? "");
  } catch {
    throw new SecretBoxError();
  }
  if (nonce.byteLength !== NONCE_BYTES || body.byteLength <= 16) throw new SecretBoxError();
  try {
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce },
      await aesKey(secret),
      body,
    );
    return decoder.decode(opened);
  } catch {
    // One message for tampering, truncation and the wrong key alike: telling
    // them apart would tell a prober which of the three happened.
    throw new SecretBoxError();
  }
}
