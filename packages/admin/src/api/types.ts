import type {
  AnswerOutcome,
  McpAuthKind,
  OverviewAttention,
  OverviewPeriod,
  OverviewSetup,
  ResponseTimePeriod,
  ReviewFailure,
  SourceKind,
  SourceSyncStatus,
  TestExpectation,
  ToolCredentialSource,
  TopicItem,
  TopicsReport,
  VersionConfig,
} from "@solvchat/core";

// Overview and Reports shapes are declared once, in core, beside the engine's.
export type {
  AnswerOutcome,
  OverviewAttention,
  OverviewPeriod,
  OverviewSetup,
  PeriodFigures,
  ResponseTimeFigures,
  ResponseTimePeriod,
  ResponseTimeStatus,
  TopicItem,
  TopicReportRow,
  TopicsReport,
} from "@solvchat/core";

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
  /** A sitemap source's sync schedule and latest run. Absent for other kinds and older engines. */
  sync?: SourceSyncStatus;
  /** Blocks of text left out because they repeat across most of the source's pages. */
  repeatedBlockCount?: number;
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
  /** A reply found nothing, and was not reviewed as off topic or asking for a person. */
  hasUnanswered: boolean;
  /** A reply the answer check found off topic (what the "Off topic" filter finds). */
  hasOffTopic?: boolean;
  /** A visitor asked for a person (what the "Asked for a person" filter finds). */
  hasAskedForPerson?: boolean;
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
  /** While `searchPending`: how many messages are still to be prepared. */
  searchRemaining?: number;
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
  /**
   * False when the visitor saw no list of sources under the answer (sources
   * linked in the text without the list, or none): `citations` then lists the
   * content the answer used. Absent means shown.
   */
  citationsShown?: boolean;
  toolCalls?: ConversationToolCall[] | null;
  answered: boolean;
  /** For a reply, what the answer review decided; null or absent when it was not reviewed. */
  outcome?: AnswerOutcome | null;
  createdAt: number;
  feedback: ConversationFeedback[];
  answerDocumentId: string | null;
  /** For a reply, the question it answered; null for questions and older rows. */
  replyTo: string | null;
}

/** Why retrieved content was not given to the model. */
export type TraceDropReason = "below_floor" | "not_found" | "duplicate" | "document_cap" | "rank";

export interface AnswerTraceCandidate {
  chunkId: string;
  score: number;
  used: boolean;
  dropped?: TraceDropReason;
  /** The content as it is now; null when it has changed or been removed since. */
  content: {
    documentId: string;
    title: string;
    url: string;
    sourceKind: "push" | "sitemap" | "entry";
    headingPath: string;
    excerpt: string;
  } | null;
}

export interface AnswerTracePart {
  kind: "answer" | "resume";
  stop: "complete" | "length" | "tool" | "refused" | "spend_cap" | "error" | "paused";
  version: {
    id: string;
    state: "published" | "draft";
    current: {
      state: "draft" | "published" | "archived";
      createdAt: number;
      publishedAt: number | null;
    } | null;
  };
  model: {
    provider: "anthropic" | "openai" | "openrouter";
    id: string;
    keySource: "stored" | "environment" | "managed";
  } | null;
  retrieval: {
    floor: number;
    ms: number;
    candidates: AnswerTraceCandidate[];
    /** Matches whose content was gone; null (or absent) on older answers. */
    stale?: number | null;
    /** Whether it searched again because of them. */
    searchedAgain?: boolean | null;
  };
  timing: { firstTokenMs: number | null; totalMs: number };
  tools: { rounds: number; ms: number };
}

/** `GET /api/admin/conversations/:id/messages/:messageId/trace`. */
export interface AnswerTrace {
  messageId: string;
  /** A visitor reply, or a "Try it" or test-run answer (which stores no message). */
  source: "visitor" | "try_it" | "test_run";
  tokensIn: number;
  tokensOut: number;
  costMicros: number | null;
  firstTokenMs: number | null;
  totalMs: number | null;
  /** Null when no details were recorded (answers from before traces existed). */
  trace: { parts: AnswerTracePart[]; truncated: boolean } | null;
  /** Why the answer check gave no result, as a fixed code; null or absent when it did. */
  reviewFailure?: ReviewFailure | null;
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
  /** Asks where no content was found. */
  noContentTimes?: number;
  /** Asks where content was found but the reply still could not answer. */
  declinedTimes?: number;
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

/** A "Most often unanswered" row, with the topic of its latest tagged ask. */
export interface TopGap extends TopQuestion {
  /** Absent from an engine older than topics. */
  topic?: { id: string; name: string } | null;
}

/** `GET …/topics`: the assistant's topics and the "Review answers" switch. */
export interface TopicsList {
  topics: TopicItem[];
  reviewAnswers: boolean;
}

/** A document of the assistant's content, as the Reports usage lists give it. */
export interface ReportContent {
  /** Optional so a report from an engine older than content usage still renders. */
  documentId?: string;
  /** `answer`: written in the admin; its `url` is its place in Sources, not a public address. */
  kind?: "page" | "answer";
  url: string;
  /** For a written answer, its question. */
  title: string;
}

export interface SourceCitationCount extends ReportContent {
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
  topGaps: TopGap[];
  /** Optional so a report from an engine older than topics still renders. */
  topics?: TopicsReport;
  topSources: SourceCitationCount[];
  uncitedSources: ReportContent[];
  uncitedTotal: number;
  /** Optional so a report from an engine older than the figure still renders. */
  responseTime?: ResponseTimePeriod;
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
  responseTime?: ResponseTimePeriod;
}

export interface InstallInfo {
  assistantId: string;
  publicKey: string;
  allowedOrigins: string[];
  snippet: string;
  /** Page and time of the newest conversation; null until a visitor writes. */
  lastSeen?: { pageUrl: string; at: number } | null;
  /** Directives a host site's Content-Security-Policy must allow. */
  hostPolicy?: { directive: string; value: string }[];
  visitorCheck?: VisitorCheckStatus;
}

/** What is missing when the visitor check is half set up. */
export type VisitorCheckMissing = "site_key" | "secret" | "secret_key";

/** Whether visitor chat runs the security check (Cloudflare Turnstile). */
export interface VisitorCheckStatus {
  state: "on" | "off" | "test_keys" | "misconfigured";
  missing: VisitorCheckMissing[];
}

export type { McpAuthKind } from "@solvchat/core";

export interface McpServerSummary {
  id: string;
  assistantId: string;
  label: string;
  url: string;
  authKind: McpAuthKind;
  headerName: string | null;
  hasSecret: boolean;
  credentialSource?: ToolCredentialSource;
  pageHeaderName?: string;
  hasTestSecret?: boolean;
  enabled: boolean;
  /**
   * "Send conversation context". Optional so a host serving an older engine,
   * whose response lacks it, reads it as off.
   */
  sendConversationContext?: boolean;
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
  /** How this test's answer was made (`preview-traces/:id`); absent on older runs. */
  traceId?: string;
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
    /** "Review answers"; absent from an engine without answer review. */
    reviewAnswers?: ResolvedSetting<boolean>;
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
