import type { SourceKind, TestExpectation, VersionConfig } from "@solvchat/core";

export interface Assistant {
  id: string;
  orgId: string;
  name: string;
  publicKey: string;
  allowedOrigins: string[];
  hasIngestKey: boolean;
  createdAt: number;
}

export type VersionState = "draft" | "published" | "archived";

export interface VersionRow {
  id: string;
  orgId: string;
  assistantId: string;
  state: VersionState;
  config: VersionConfig;
  createdAt: number;
  publishedAt: number | null;
}

export interface SourceSummary {
  id: string;
  orgId: string;
  assistantId: string;
  kind: SourceKind;
  label: string;
  settings: Record<string, unknown>;
  createdAt: number;
  documentCount: number;
  lastUpdatedAt: number | null;
  /** Documents not searchable yet. Absent from engines older than this admin. */
  indexingCount?: number;
  /** Documents that could not be indexed. */
  failedCount?: number;
  /** Failed documents that are tried again automatically, so may still recover. */
  retryingCount?: number;
  /** Why (one of the failed documents), as a code the admin words. */
  indexError?: IndexErrorCode | null;
}

export type IndexErrorCode = "too_long" | "missing_body" | "embedding_failed";

export interface DocumentSummary {
  id: string;
  sourceId: string;
  externalId: string;
  url: string;
  title: string;
  updatedAt: number;
}

export interface ConversationSummary {
  id: string;
  assistantId: string;
  visitorId: string;
  startedAt: number;
  pageUrl: string;
  firstQuestion: string | null;
  turnCount: number;
  hasUnanswered: boolean;
  hasNotHelpful?: boolean;
  usedTool?: boolean;
  lastMessageAt?: number;
}

export interface ConversationsPage {
  conversations: ConversationSummary[];
  total: number;
  limit: number;
  offset: number;
  /**
   * The engine is still preparing older messages for search, so it did not
   * search: the list is empty and the same request should be sent again.
   */
  searchPending?: boolean;
}

export interface ConversationFeedback {
  id: string;
  value: "up" | "down";
  note: string;
  createdAt: number;
}

export interface Citation {
  url: string;
  title: string;
}

export interface ConversationToolCall {
  callId: string;
  name: string;
  kind: "mcp" | "action";
  ok: boolean;
  pending?: boolean;
}

export interface ConversationTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
  toolCalls?: ConversationToolCall[] | null;
  answered: boolean;
  createdAt: number;
  feedback: ConversationFeedback[];
  answerDocumentId: string | null;
  /** For a reply, the question it answered; null for questions and older rows. */
  replyTo: string | null;
}

export interface ConversationDetail {
  conversation: {
    id: string;
    assistantId: string;
    visitorId: string;
    startedAt: number;
    pageUrl: string;
  };
  turns: ConversationTurn[];
}

export interface GapSummary {
  question: string;
  displayQuestion: string;
  times: number;
  lastAsked: number;
  exampleMessageId: string;
  handled: boolean;
  documentId: string | null;
}

export interface GapsPage {
  gaps: GapSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface TopQuestion {
  question: string;
  count: number;
}

export interface SourceCitationCount {
  url: string;
  title: string;
  count: number;
}

export interface AssistantReport {
  days: 7 | 30 | 90;
  from: string;
  to: string;
  questions: number;
  replies: number;
  answeredShare: number;
  thumbsDownShare: number;
  costMicros: number;
  topQuestions: TopQuestion[];
  topGaps: TopQuestion[];
  topSources: SourceCitationCount[];
  uncitedSources: Array<{ url: string; title: string }>;
  uncitedTotal: number;
}

export interface PeriodFigures {
  from: string;
  to: string;
  questions: number;
  replies: number;
  answeredShare: number;
  thumbsDownShare: number;
  costMicros: number;
}

export interface OverviewPeriod extends PeriodFigures {
  days: number;
  previous: PeriodFigures;
}

export interface OverviewSetup {
  hasContent: boolean;
  tried: boolean;
  published: boolean;
  installed: boolean;
  visitorQuestion: boolean;
}

export interface OverviewAttention {
  openGaps: number;
  failingTests: number;
  notIndexed: Array<{ sourceId: string; label: string; documents: number }>;
}

export interface AssistantOverview {
  topQuestions: TopQuestion[];
  todayCostMicros: number;
  todayCostUnknown?: boolean;
  dailyCostCapMicros?: number;
  costUnit?: "usd" | "credits";
  configError?: string | null;
  period?: OverviewPeriod;
  daily?: Array<{ day: string; questions: number }>;
  setup?: OverviewSetup;
  attention?: OverviewAttention;
}

export interface InstallInfo {
  assistantId: string;
  publicKey: string;
  allowedOrigins: string[];
  snippet: string;
  /** Page and time of the newest conversation; null until a visitor writes. */
  lastSeen?: { pageUrl: string; at: number } | null;
}

export type McpAuthKind = "none" | "static_header";

export interface McpServerSummary {
  id: string;
  assistantId: string;
  label: string;
  url: string;
  authKind: McpAuthKind;
  headerName: string | null;
  hasSecret: boolean;
  enabled: boolean;
  createdAt: number;
  toolCount: number;
  allowedCount: number;
}

export interface McpToolView {
  id: string;
  serverId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  allowed: boolean;
}

export type TestOutcome = "passed" | "failed" | "not_run";

export interface TestResult {
  testId: string;
  question: string;
  expectation: TestExpectation;
  outcome: TestOutcome;
  reason: string;
  excerpt: string;
}

export interface AnswerTest {
  id: string;
  orgId: string;
  assistantId: string;
  question: string;
  expectation: TestExpectation;
  createdAt: number;
  latestResult?: TestResult | null;
}

export interface TestRunSummary {
  id: string;
  results: TestResult[];
  stopped?: string | null;
}

export interface TestRunRow {
  id: string;
  versionId: string;
  startedAt: number;
  results: TestResult[];
  passed: boolean;
}

export interface TestRunResponse {
  runId: string;
  passed: boolean;
  results: TestResult[];
  stopped?: string | undefined;
}

export type LlmProviderName = "anthropic" | "openai" | "openrouter";
export type EmbeddingsProviderName = "openai" | "openrouter";
export type LlmTier = "fast" | "balanced";
export type SettingSource = "stored" | "environment" | "none";

export interface ResolvedSetting<T> {
  value: T;
  source: SettingSource;
}

export interface ProviderKeyStatus {
  source: SettingSource;
  updatedAt: number | null;
  unreadable: boolean;
}

export interface ProviderSettingsView {
  settings: {
    llmProvider: ResolvedSetting<LlmProviderName>;
    llmTier: ResolvedSetting<LlmTier>;
    llmModel: ResolvedSetting<string | null>;
    embeddingsProvider: ResolvedSetting<EmbeddingsProviderName>;
  };
  keysManaged: boolean;
  /** With managed keys: whether the owner may still enter their own. */
  ownKeysAllowed?: boolean;
  keys: Record<LlmProviderName, ProviderKeyStatus>;
  configError: string | null;
}

export interface KeyTestResult {
  ok: boolean;
  category: "ok" | "unauthorised" | "rate_limited" | "unreachable" | "missing" | "unreadable";
  message: string;
}
