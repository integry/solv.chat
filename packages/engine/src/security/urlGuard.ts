import { BadRequest } from "../admin/errors.js";

/**
 * Thrown when an owner-supplied URL violates the specification's outbound fetch
 * policy (non-https, private/loopback address, redirect cap, size cap, or timeout).
 * Extends `BadRequest` so admin routes return 400 without leaking internals.
 */
export class UnsafeUrlError extends BadRequest {
  constructor(message: string) {
    super([`url: ${message}`]);
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function isPrivateOrReservedIpv4(octets: [number, number, number, number]): boolean {
  const [a, b, c] = octets;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local / metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24, 192.0.2.0/24
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24
  if (a >= 224) return true; // 224.0.0.0/4 multicast & 240.0.0.0/4 reserved
  return false;
}

function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    nums.push(n);
  }
  return nums as [number, number, number, number];
}

function parseIpv6Groups(raw: string): number[] | null {
  // Strip zone index if present (e.g. fe80::1%eth0)
  const zoneIdx = raw.indexOf("%");
  const addr = zoneIdx === -1 ? raw : raw.slice(0, zoneIdx);

  const halves = addr.split("::");
  if (halves.length > 2) return null;

  const parseSide = (side: string): number[] | null => {
    if (side === "") return [];
    const tokens = side.split(":");
    const out: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i] ?? "";
      if (token.includes(".")) {
        // Embedded IPv4 must be the last token of the address
        if (i !== tokens.length - 1) return null;
        const ipv4 = parseIpv4(token);
        if (!ipv4) return null;
        out.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(token)) return null;
        out.push(Number.parseInt(token, 16));
      }
    }
    return out;
  };

  const left = parseSide(halves[0] ?? "");
  if (!left) return null;

  if (halves.length === 1) {
    return left.length === 8 ? left : null;
  }

  const right = parseSide(halves[1] ?? "");
  if (!right) return null;

  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;

  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function isPrivateOrReservedIpv6(groups: number[]): boolean {
  const allZeroExceptLast =
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0 &&
    groups[6] === 0;
  // :: (unspecified) and ::1 (loopback)
  if (allZeroExceptLast && (groups[7] === 0 || groups[7] === 1)) return true;

  // ::ffff:0:0/96 (IPv4-mapped IPv6)
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    const g6 = groups[6] ?? 0;
    const g7 = groups[7] ?? 0;
    return isPrivateOrReservedIpv4([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
  }

  const first = groups[0] ?? 0;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 (unique local)
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 (link-local)
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 (multicast)
  return false;
}

/**
 * Validates that an owner-supplied URL uses `https:` and does not target
 * localhost, private networks, link-local metadata endpoints, or loopback IPs.
 *
 * Shared across sitemap fetches and MCP server URL checks so one policy
 * governs every outbound request the Worker makes to an owner-supplied URL.
 */
export function assertPublicHttpsUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new UnsafeUrlError("must be a valid URL");
  }

  if (url.protocol !== "https:") {
    throw new UnsafeUrlError("must use https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new UnsafeUrlError("must not include credentials");
  }

  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (!host) {
    throw new UnsafeUrlError("must include a host");
  }

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".arpa")
  ) {
    throw new UnsafeUrlError("must not point to a private or loopback address");
  }

  const ipv4 = parseIpv4(host);
  if (ipv4) {
    if (isPrivateOrReservedIpv4(ipv4)) {
      throw new UnsafeUrlError("must not point to a private or loopback address");
    }
    return url;
  }

  if (host.includes(":")) {
    const ipv6 = parseIpv6Groups(host);
    if (!ipv6 || isPrivateOrReservedIpv6(ipv6)) {
      throw new UnsafeUrlError("must not point to a private or loopback address");
    }
    return url;
  }

  if (!host.includes(".")) {
    throw new UnsafeUrlError("must not point to a private or loopback address");
  }

  return url;
}

export interface FollowOptions {
  maxRedirects: number;
  timeoutMs: number;
  accept?: string;
  signal?: AbortSignal;
}

export interface FetchCappedOptions extends FollowOptions {
  maxBytes: number;
}

function linkAbortSignal(signal?: AbortSignal): {
  controller: AbortController;
  cleanup: () => void;
} {
  const controller = new AbortController();
  if (!signal) {
    return { controller, cleanup: () => {} };
  }
  if (signal.aborted) {
    controller.abort();
    return { controller, cleanup: () => {} };
  }
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  return {
    controller,
    cleanup: () => signal.removeEventListener("abort", onAbort),
  };
}

function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: () => Promise<void> | void,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.resolve(onAbort()).then(() => {
      throw new UnsafeUrlError("request timed out");
    });
  }
  return new Promise<T>((resolve, reject) => {
    let aborted = false;
    const handleAbort = () => {
      aborted = true;
      Promise.resolve(onAbort()).finally(() => {
        reject(new UnsafeUrlError("request timed out"));
      });
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    promise.then(
      (val) => {
        signal.removeEventListener("abort", handleAbort);
        if (!aborted && !signal.aborted) {
          resolve(val);
        }
      },
      (err) => {
        signal.removeEventListener("abort", handleAbort);
        if (aborted) return;
        if (signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
          aborted = true;
          Promise.resolve(onAbort()).finally(() => {
            reject(new UnsafeUrlError("request timed out"));
          });
        } else {
          reject(err);
        }
      },
    );
  });
}

/**
 * Fetches `target` with `redirect: "manual"` and validates every redirect hop
 * through `assertPublicHttpsUrl` so a public URL cannot bounce to a private or
 * link-local address. Enforces both redirect and time budgets.
 */
export async function followCheckingEachHop(
  target: URL,
  fetchImpl: typeof fetch,
  options: FollowOptions,
): Promise<Response> {
  const { controller, cleanup } = linkAbortSignal(options.signal);
  const timer = options.signal
    ? undefined
    : setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    let current = assertPublicHttpsUrl(target.href);

    for (let redirects = 0; ; redirects++) {
      if (controller.signal.aborted) {
        throw new UnsafeUrlError("request timed out");
      }
      const response = await fetchImpl(current.href, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: options.accept ? { accept: options.accept } : {},
      });

      if (REDIRECT_STATUSES.has(response.status)) {
        // Cancel the redirect body so connections are not held open.
        await response.body?.cancel().catch(() => {});
        if (redirects >= options.maxRedirects) {
          throw new UnsafeUrlError(`exceeded ${options.maxRedirects} redirects`);
        }
        const location = response.headers.get("location");
        if (!location) {
          throw new UnsafeUrlError("redirect missing location header");
        }
        let nextUrl: URL;
        try {
          nextUrl = new URL(location, current);
        } catch {
          throw new UnsafeUrlError("redirect target is not a valid URL");
        }
        current = assertPublicHttpsUrl(nextUrl.href);
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new UnsafeUrlError(`upstream returned HTTP ${response.status}`);
      }

      return response;
    }
  } catch (err) {
    if (err instanceof UnsafeUrlError) throw err;
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new UnsafeUrlError("request timed out");
    }
    if (controller.signal.aborted) {
      throw new UnsafeUrlError("request timed out");
    }
    throw new UnsafeUrlError("could not fetch URL");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    cleanup();
  }
}

/**
 * Reads a response body up to `maxBytes`, aborting early if `Content-Length`,
 * the streamed byte count, or the optional `signal` deadline is exceeded.
 */
export async function readCapped(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) {
    await response.body?.cancel().catch(() => {});
    throw new UnsafeUrlError("request timed out");
  }

  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new UnsafeUrlError(`response exceeds ${maxBytes} bytes`);
    }
  }

  if (!response.body) {
    const buffer = await raceWithAbort(response.arrayBuffer(), signal, () => {});
    if (buffer.byteLength > maxBytes) {
      throw new UnsafeUrlError(`response exceeds ${maxBytes} bytes`);
    }
    return new TextDecoder().decode(buffer);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await raceWithAbort(reader.read(), signal, () =>
        reader.cancel().catch(() => {}),
      );
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new UnsafeUrlError(`response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Lock may already be released after cancellation.
    }
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

/**
 * Follows redirects with `followCheckingEachHop` and reads the response body
 * with `readCapped` under a single shared timeout budget, so stalled
 * response bodies are aborted and cancelled on timeout.
 */
export async function fetchCapped(
  target: URL,
  fetchImpl: typeof fetch,
  options: FetchCappedOptions,
): Promise<{ response: Response; body: string }> {
  const { controller, cleanup } = linkAbortSignal(options.signal);
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await followCheckingEachHop(target, fetchImpl, {
      ...options,
      signal: controller.signal,
    });
    const body = await readCapped(response, options.maxBytes, controller.signal);
    return { response, body };
  } finally {
    clearTimeout(timer);
    cleanup();
  }
}
