import { describe, expect, it, vi } from "vitest";
import {
  MAX_SECRET_LENGTH,
  openSecret,
  SecretBoxError,
  sealSecret,
} from "../../src/security/secretBox.js";

// A test value, not a key: 32 bytes of obvious filler so nobody mistakes it
// for a real secret if it is ever grepped out of the repository.
const SECRET = "test-secret-key-aaaaaaaaaaaaaaaa";
const OTHER = "test-secret-key-bbbbbbbbbbbbbbbb";

describe("secretBox", () => {
  it("round-trips a credential, including multi-byte characters", async () => {
    const value = "Bearer tok_\u00e9\u00fc_\u2603_1234";
    expect(await openSecret(SECRET, await sealSecret(SECRET, value))).toBe(value);
  });

  it("rejects an empty credential", async () => {
    await expect(sealSecret(SECRET, "")).rejects.toBeInstanceOf(SecretBoxError);
  });

  it("uses a fresh nonce, so two seals of one value differ and both open", async () => {
    const [a, b] = [await sealSecret(SECRET, "same"), await sealSecret(SECRET, "same")];
    expect(a).not.toBe(b);
    expect(await openSecret(SECRET, a)).toBe("same");
    expect(await openSecret(SECRET, b)).toBe("same");
  });

  it.each(["nonce", "body"] as const)("refuses a tampered %s", async (part) => {
    const sealed = await sealSecret(SECRET, "value");
    const parts = sealed.split(".");
    const index = part === "nonce" ? 1 : 2;
    // Flip one character: GCM authenticates, so this must fail rather than
    // decrypt to something that would be sent as an HTTP header.
    const target = parts[index] ?? "";
    parts[index] = (target[0] === "A" ? "B" : "A") + target.slice(1);
    await expect(openSecret(SECRET, parts.join("."))).rejects.toBeInstanceOf(SecretBoxError);
  });

  it("refuses truncated, malformed, and non-base64 values", async () => {
    const sealed = await sealSecret(SECRET, "value");
    const parts = sealed.split(".");

    await expect(openSecret(SECRET, "")).rejects.toBeInstanceOf(SecretBoxError);
    await expect(openSecret(SECRET, `v2.${parts[1]}.${parts[2]}`)).rejects.toBeInstanceOf(
      SecretBoxError,
    );
    await expect(openSecret(SECRET, `${parts[0]}.${parts[1]}`)).rejects.toBeInstanceOf(
      SecretBoxError,
    );
    await expect(openSecret(SECRET, sealed.slice(0, -4))).rejects.toBeInstanceOf(SecretBoxError);
    await expect(
      openSecret(SECRET, `v1.${parts[1]?.slice(0, -2)}.${parts[2]}`),
    ).rejects.toBeInstanceOf(SecretBoxError);
    await expect(openSecret(SECRET, "v1.not!base64.not!base64")).rejects.toBeInstanceOf(
      SecretBoxError,
    );
    await expect(openSecret(SECRET, `v1.${parts[1]}.abc+def/ghi=`)).rejects.toBeInstanceOf(
      SecretBoxError,
    );
  });

  it("refuses a value sealed under a different key without naming either", async () => {
    const sealed = await sealSecret(OTHER, "value");
    await expect(openSecret(SECRET, sealed)).rejects.toSatisfy((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      return (
        err instanceof SecretBoxError &&
        !message.includes(SECRET) &&
        !message.includes(OTHER) &&
        !message.includes(sealed)
      );
    });
  });

  it("refuses a value longer than MAX_SECRET_LENGTH before any crypto call", async () => {
    const encryptSpy = vi.spyOn(crypto.subtle, "encrypt");
    const deriveSpy = vi.spyOn(crypto.subtle, "deriveBits");
    try {
      await expect(sealSecret(SECRET, "a".repeat(MAX_SECRET_LENGTH + 1))).rejects.toBeInstanceOf(
        SecretBoxError,
      );
      expect(encryptSpy).not.toHaveBeenCalled();
      expect(deriveSpy).not.toHaveBeenCalled();
    } finally {
      encryptSpy.mockRestore();
      deriveSpy.mockRestore();
    }

    const atLimit = "a".repeat(MAX_SECRET_LENGTH);
    expect(await openSecret(SECRET, await sealSecret(SECRET, atLimit))).toBe(atLimit);
  });
});
