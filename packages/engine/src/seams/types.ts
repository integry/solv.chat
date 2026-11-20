import type { AnswerOutcome } from "@solvchat/core";

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
 * - `queued_ingest`: an ingest Queue message, or a scheduled sync run; its
 *   `orgId` was written by the engine (into the message, or the `sources`
 *   row) from an org this seam resolved, and is re-checked here. Answering
 *   null for a suspended org stops both its queued work and its syncs.
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

/**
 * Thrown by a KeyProvider when a stored key exists for the org/provider
 * but cannot be decrypted (for example, SOLV_SECRET_KEY is missing or rotated).
 * Callers must not fall back to environment secrets when this is thrown.
 */
export class StoredKeyError extends Error {
  readonly provider: LlmProviderName;
  constructor(provider: LlmProviderName, message = `stored ${provider} key could not be read`) {
    super(message);
    this.name = "StoredKeyError";
    this.provider = provider;
  }
}

export interface KeyProvider {
  /**
   * True when the host layer supplies and manages provider keys itself, so
   * the admin hides key-entry fields.
   */
  readonly managed?: boolean | undefined;
  /**
   * Only read when `managed` is true. True lets an owner store their own
   * keys anyway (the admin offers "Use my own key"); `modelKey` must then
   * prefer a stored key. False or absent keeps key entry refused.
   */
  readonly ownKeysAllowed?: boolean | undefined;
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
  /**
   * Set on the event that reports a reviewed answer's outcome (see "Answer
   * review" in docs/architecture.md). That event counts nothing: `messages`,
   * tokens and cost are all 0, as the review's model call reported its own
   * usage in an event of its own (`messages: 0`). The open `usageDaily`
   * ignores it, and `messages` (the count a host bills on) is unchanged by
   * review; a host can read this to apply a rule of its own.
   */
  review?: ReviewOutcomeEvent | undefined;
}

export interface ReviewOutcomeEvent {
  /** The assistant reply that was reviewed. */
  messageId: string;
  outcome: AnswerOutcome;
  /** 0 to 1, or null when the reviewer cannot give one. */
  confidence: number | null;
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
  | { kind: "ingest" }
  /**
   * The answer review that runs after a visitor's answer (no IP: it is the
   * engine's own deferred work). It spends model budget, so it is refused
   * once the daily spend cap is reached; it is never rate limited.
   */
  | { kind: "review" };

export type LimitDecision = { ok: true } | { ok: false; reason: "spend_cap" | "rate_limit" };

/**
 * The answer before a scheduled sync of one source. `maxPages` (pages fetched
 * in this run) and `maxDocuments` (documents the source may hold) can only
 * lower the engine's own caps, never raise them.
 */
export type SyncLimitDecision =
  | { ok: true; maxPages?: number | undefined; maxDocuments?: number | undefined }
  | { ok: false; reason: "suspended" | "plan_limit" };

export interface SyncLimitRequest {
  sourceId: string;
}

export interface Limits {
  check(orgId: string, assistantId: string, action: LimitAction): Promise<LimitDecision>;
  /**
   * Asked before every scheduled sync run. Optional so hosts written before
   * scheduled sync keep compiling: when absent, every run may go ahead with
   * the engine's caps. A refusal records the run as failed (`limit_refused`)
   * without fetching anything.
   */
  checkSync?(
    orgId: string,
    assistantId: string,
    request: SyncLimitRequest,
  ): Promise<SyncLimitDecision>;
}

/**
 * Validators from an earlier fetch of the same URL. Sent as `If-None-Match`
 * and `If-Modified-Since`; a server that still has that version answers 304.
 */
export interface PageValidators {
  etag?: string | null | undefined;
  lastModified?: string | null | undefined;
}

interface PageFetchFields {
  /** The URL that answered, after redirects. */
  finalUrl: string;
  /** The HTTP status of that answer. */
  status: number;
  /** Validators to send next time; null when the server sent none. */
  etag: string | null;
  lastModified: string | null;
}

/** The page changed (or no validators were sent) and has text to index. */
export interface PageContent extends PageFetchFields {
  kind: "page";
  notModified: false;
  title: string;
  /** Never empty: a page with no text is a `PageNoContent` instead. */
  markdown: string;
}

/** The server answered 304: the copy fetched with these validators is current. */
export interface PageNotModified extends PageFetchFields {
  kind: "not_modified";
  notModified: true;
  title: null;
  markdown: null;
}

/**
 * Nothing to index. `not_html` is a response that is not a web page or text
 * (a PDF, an image, JSON); its body is not read. `empty` is a page whose
 * extraction left no text; `title` is what the page would have been called.
 * Neither should be indexed as a document.
 */
export interface PageNoContent extends PageFetchFields {
  kind: "no_content";
  notModified: false;
  reason: "not_html" | "empty";
  /** The response's `content-type`, or null when it had none. */
  contentType: string | null;
  title: string | null;
  markdown: null;
}

export type PageFetchResult = PageContent | PageNotModified | PageNoContent;

/**
 * Turns one https URL into Markdown. The open build's `plainPageFetcher` uses
 * Workers `fetch`; a host may render pages some other way (a headless browser
 * behind a REST API, say). An implementation must refuse, by throwing, any URL
 * or redirect hop that is not https or that resolves to a private, loopback or
 * link-local address, and must cap the response size and the time spent. A
 * thrown error means the page could not be fetched; its message must not
 * carry secrets.
 */
export interface PageFetcher {
  fetchPage(url: string, validators?: PageValidators): Promise<PageFetchResult>;
}

/**
 * The Cloudflare Turnstile keys for the visitor check (see "Visitor check"
 * in docs/architecture.md). Either may be absent; the engine decides what
 * that means.
 */
export interface VisitorCheckKeys {
  /** The widget's site key: public, rendered in the check frame. */
  siteKey?: string | undefined;
  /** The widget's secret key: sent only to Turnstile's `siteverify`, never to a browser or a log. */
  secret?: string | undefined;
}

/**
 * Where the visitor check's keys come from. The open build reads
 * `SOLV_TURNSTILE_SITE_KEY` and `SOLV_TURNSTILE_SECRET` from the Worker's
 * configuration and treats "neither set" as "run without the check". A host
 * that must never run unprotected sets `required`: then a missing key is a
 * configuration error and the public chat refuses every request.
 */
export interface VisitorCheckProvider {
  readonly required?: boolean | undefined;
  keys(): VisitorCheckKeys | Promise<VisitorCheckKeys>;
}

export interface Seams {
  auth: AuthProvider;
  keys: KeyProvider;
  usage: UsageSink;
  limits: Limits;
  /** Optional so hosts written before this seam keep working: `createApp` applies `plainPageFetcher`. */
  pages?: PageFetcher | undefined;
  /**
   * Optional so hosts written before it keep working: left out, the keys are
   * read from the Worker's configuration and the check is not required.
   */
  visitorCheck?: VisitorCheckProvider | undefined;
}
