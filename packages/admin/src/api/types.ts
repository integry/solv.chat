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
}

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
}

export interface ConversationsPage {
  conversations: ConversationSummary[];
  total: number;
  limit: number;
  offset: number;
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

export interface AssistantOverview {
  messages: number;
  answeredShare: number;
  topQuestions: TopQuestion[];
  todayCostMicros: number;
  todayCostUnknown?: boolean;
  dailyCostCapMicros?: number;
  costUnit?: "usd" | "credits";
  configError?: string | null;
}

export interface InstallInfo {
  assistantId: string;
  publicKey: string;
  allowedOrigins: string[];
  snippet: string;
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

export interface TestRunResponse {
  runId: string;
  passed: boolean;
  results: TestResult[];
  stopped?: string | undefined;
}
