export interface Principal {
  orgId: string;
  userId: string;
  role: "owner";
}

export interface AuthProvider {
  /**
   * Returns null rather than throwing so one router branch answers 401 for
   * every admin route in one place.
   */
  authenticate(request: Request): Promise<Principal | null>;
  login(request: Request): Promise<Response>;
  logout(request: Request): Promise<Response>;
}

export interface KeyProvider {
  modelKey(orgId: string, provider: "anthropic" | "openai"): Promise<string>;
  embeddingKey(orgId: string): Promise<string>;
}

export interface UsageEvent {
  orgId: string;
  assistantId: string;
  at: number;
  messages: number;
  tokensIn: number;
  tokensOut: number;
  costMicros: number;
}

export interface UsageSink {
  record(event: UsageEvent): Promise<void>;
}

export type LimitAction = { kind: "chat"; ip: string } | { kind: "ingest" };

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
