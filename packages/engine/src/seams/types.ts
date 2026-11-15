export interface Principal {
  orgId: string;
  userId: string;
  role: "owner";
}

/**
 * What a request with no session presents. The engine never reads `org_id`
 * from these: it asks the auth seam which org the request belongs to, then
 * looks the credential up only inside that org.
 *
 * - `public_key`: `POST /v1/chat`, `GET /v1/assistants/:key` (the widget's key).
 * - `message`: `POST /v1/feedback` (a message id the engine issued).
 * - `ingest_key`: `/v1/ingest/:assistantId/*` (checked against the hashed key
 *   only after the org is known).
 * - `preflight`: `OPTIONS /v1/chat`, `OPTIONS /v1/feedback` (an Origin, no key).
 * - `queued_ingest`: an ingest Queue message; its `orgId` was written by the
 *   engine from an org this seam resolved, and is re-checked here.
 */
export type ScopeClaim =
  | { kind: "public_key"; publicKey: string }
  | { kind: "message"; messageId: string }
  | { kind: "ingest_key"; assistantId: string }
  | { kind: "preflight"; origin: string }
  | { kind: "queued_ingest"; orgId: string };

export interface AuthProvider {
  /**
   * Returns null rather than throwing so one router branch answers 401 for
   * every admin route in one place.
   */
  authenticate(request: Request): Promise<Principal | null>;
  /**
   * The org a session-less request belongs to, or null to refuse it. This is
   * the only source of `org_id` outside `/api/admin/*`; a null answer gets
   * the same response as an unknown key.
   */
  resolveOrg(claim: ScopeClaim): Promise<string | null>;
  login(request: Request): Promise<Response>;
  logout(request: Request): Promise<Response>;
}

export type LlmProviderName = "anthropic" | "openai" | "openrouter";
export type EmbeddingsProviderName = "openai" | "openrouter";

export interface KeyProvider {
  modelKey(orgId: string, provider: LlmProviderName): Promise<string>;
  embeddingKey(orgId: string, provider?: EmbeddingsProviderName): Promise<string>;
}

export interface UsageEvent {
  orgId: string;
  assistantId: string;
  at: number;
  messages: number;
  tokensIn: number;
  tokensOut: number;
  costMicros: number;
  costUnknown?: boolean | undefined;
}

export interface UsageSink {
  record(event: UsageEvent): Promise<void>;
}

/**
 * `config` is the widget's config read on page load. It is a public request,
 * so it is limited, but it costs nothing and must not spend the visitor's
 * chat budget: an implementation counts it separately from `chat`.
 */
export type LimitAction =
  | { kind: "chat"; ip: string }
  | { kind: "config"; ip: string }
  | { kind: "ingest" };

export type LimitDecision = { ok: true } | { ok: false; reason: "spend_cap" | "rate_limit" };

export interface Limits {
  check(orgId: string, assistantId: string, action: LimitAction): Promise<LimitDecision>;
}

export interface Seams {
  auth: AuthProvider;
  keys: KeyProvider;
  usage: UsageSink;
  limits: Limits;
}
