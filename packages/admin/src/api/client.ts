type UnauthorizedListener = () => void;

const unauthorizedListeners = new Set<UnauthorizedListener>();

/** Registers a listener invoked whenever an authenticated API call returns 401. */
export function subscribeUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener);
  return () => {
    unauthorizedListeners.delete(listener);
  };
}

function notifyUnauthorized(): void {
  for (const listener of unauthorizedListeners) {
    listener();
  }
}

/** Parses `"field: message"` strings from the API into a field map. */
export function parseFieldErrors(fields: readonly string[] | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!fields) return result;
  for (const entry of fields) {
    const idx = entry.indexOf(":");
    if (idx === -1) continue;
    const field = entry.slice(0, idx).trim();
    const message = entry.slice(idx + 1).trim();
    if (field && message && !(field in result)) {
      result[field] = message;
    }
  }
  return result;
}

/** Error returned by the admin API, carrying optional per-field validation messages. */
export class ApiError extends Error {
  readonly status: number;
  readonly fields: Record<string, string>;
  readonly rawFields: string[];

  constructor(status: number, message: string, rawFields: string[] = []) {
    super(message);
    this.status = status;
    this.rawFields = rawFields;
    this.fields = parseFieldErrors(rawFields);
  }
}

async function readErrorBody(response: Response): Promise<{ message: string; fields: string[] }> {
  try {
    const data = (await response.json()) as { error?: unknown; fields?: unknown };
    const message =
      typeof data.error === "string" && data.error.trim() !== ""
        ? data.error
        : `Request failed (${response.status}).`;
    const fields = Array.isArray(data.fields)
      ? data.fields.filter((f): f is string => typeof f === "string")
      : [];
    return { message, fields };
  } catch {
    return { message: `Request failed (${response.status}).`, fields: [] };
  }
}

/**
 * Fetches an authenticated admin API endpoint. Any 401 response clears the
 * active session via `subscribeUnauthorized` so the owner returns to login.
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  });

  if (response.status === 401) {
    notifyUnauthorized();
    throw new ApiError(401, "Sign in first.");
  }

  if (!response.ok) {
    const { message, fields } = await readErrorBody(response);
    throw new ApiError(response.status, message, fields);
  }

  return (await response.json()) as T;
}

export function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  return apiFetch<T>(path, signal ? { method: "GET", signal } : { method: "GET" });
}

export function postJson<T>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "POST",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

export function putJson<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export function patchJson<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

/**
 * Signs in with the admin password. Does not trigger the global 401 redirect
 * on failure so the login screen can show the plain error message directly.
 */
export async function loginRequest(password: string): Promise<void> {
  const response = await fetch("/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ password }),
  });

  if (!response.ok) {
    const { message } = await readErrorBody(response);
    throw new ApiError(response.status, message);
  }
}

export async function logoutRequest(): Promise<void> {
  const response = await fetch("/api/admin/logout", {
    method: "POST",
    credentials: "same-origin",
  });

  if (!response.ok) {
    const { message } = await readErrorBody(response);
    throw new ApiError(response.status, message);
  }
}
