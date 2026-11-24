import { CHAT_PROTOCOL_VERSION, isPlainObject } from "@solvchat/core";
import { BadRequest, NotFound } from "../admin/errors.js";
import {
  type AdminOperationName,
  type AdminRouteDeps,
  adminOperations,
  runAdminOperation,
} from "../admin/router.js";
import { MAX_BATCH_DOCUMENTS } from "../ingest/documents.js";
import type { IngestRouteDeps } from "../ingest/router.js";
import type { AuthProvider, OperatorPrincipal } from "../seams/types.js";
import { type CliOperation, runCliOperation } from "./cli.js";

export interface OperatorToolSchema {
  type: string | string[];
  description?: string;
  enum?: readonly (string | number)[];
  properties?: Record<string, OperatorToolSchema>;
  required?: readonly string[];
  items?: OperatorToolSchema;
  maxItems?: number;
  additionalProperties?: boolean;
  writeOnly?: boolean;
}

const string = { type: "string" } as const;
const bool = { type: "boolean" } as const;
const integer = { type: "integer" } as const;
const object = { type: "object" } as const;
const strings = { type: "array", items: string } as const;
const nullableString: OperatorToolSchema = { type: ["string", "null"] };
const secret: OperatorToolSchema = { ...nullableString, writeOnly: true };
const choice = (...values: string[]): OperatorToolSchema => ({ type: "string", enum: values });
const shape = (
  properties: Record<string, OperatorToolSchema>,
  required: string[] = [],
): OperatorToolSchema => ({
  ...object,
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});
const page = {
  limit: { ...integer, description: "Page size, subject to the admin API limit." },
  offset: integer,
};
const entry = shape({ question: string, answer: string }, ["question", "answer"]);
const assistant = shape({ name: string, allowedOrigins: strings }, ["name", "allowedOrigins"]);
const server = {
  label: string,
  url: string,
  authKind: choice("none", "static_header"),
  credentialSource: choice("owner", "page"),
  headerName: nullableString,
  headerValue: secret,
  pageHeaderName: string,
  testKey: secret,
  sendConversationContext: bool,
};
const test = shape({
  question: string,
  expectation: {
    ...shape(
      { kind: choice("cites", "contains", "notContains", "declines"), url: string, phrase: string },
      ["kind"],
    ),
  },
});
const scopes = choice("read", "full");

const objects = { type: "array", items: object } as const;
const pageOutput = { limit: integer, offset: integer, total: integer };
const entryOutput = { documentId: string, sourceId: string, url: string, counts: object };
const traceOutput = { messageId: string, source: string, trace: { type: ["object", "null"] } };
const runOutput = { runId: string, results: objects, passed: bool };
const providerOutput = { settings: object, keys: object, keysManaged: bool, ownKeysAllowed: bool };
const keyOutput = { ok: bool, provider: string, status: object };

interface AdminToolInfo {
  description: string;
  output?: Record<string, OperatorToolSchema>;
  body?: OperatorToolSchema;
  optionalBody?: boolean;
  query?: Record<string, OperatorToolSchema>;
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
}

const adminToolInfo: Record<AdminOperationName, AdminToolInfo> = {
  list_assistants: {
    description:
      "List assistants and their IDs. Start here when you only know a site or assistant name.",
    output: { assistants: { type: "array", items: object } },
  },
  create_assistant: {
    output: { assistant: object, ingestKey: string },
    description:
      "Create an assistant and its first draft. Returns the new assistant and its one-time ingest key.",
    body: assistant,
  },
  get_assistant: {
    description: "Read one assistant’s name, public widget key, and allowed websites.",
    output: { assistant: object },
  },
  update_assistant: {
    output: { assistant: object },
    description:
      "Set the assistant’s name and allowed websites. Include the complete list of websites to keep.",
    body: assistant,
    destructive: true,
    idempotent: true,
  },
  rotate_ingest_key: {
    description:
      "Invalidate the assistant’s current CLI ingest key and return a replacement once. Update every script that uses the old key.",
    destructive: true,
    output: { ingestKey: string },
  },
  list_versions: {
    description:
      "Read the draft, live version, and recent publish history. Use archived version IDs to roll back.",
    output: { versions: { type: "array", items: object } },
  },
  get_draft: {
    description:
      "Read the unpublished configuration and its revision. Use this before editing or confirming a publish.",
    output: { draft: object, revision: string },
  },
  update_draft: {
    output: { draft: object },
    description:
      "Save configuration to the draft. Accepts the same partial config as the admin API and leaves the live assistant untouched.",
    body: {
      ...object,
      properties: {
        behaviour: object,
        widget: object,
        allowedTools: strings,
        pageToolServers: { type: "array", items: object },
      },
    },
    destructive: true,
    idempotent: true,
  },
  publish_draft: {
    output: { version: object },
    description:
      "Run the draft’s tests and make it live if they pass. Use the draft ID and revision to publish the changes you reviewed. Force can publish after a failed run.",
    body: shape({
      force: bool,
      runId: string,
      expected: shape({ draftId: string, revision: string }, ["draftId", "revision"]),
    }),
    optionalBody: true,
    destructive: true,
  },
  rollback_version: {
    output: { version: object },
    description:
      "Make a previously published version live again. Review the version history before rolling back.",
    destructive: true,
  },
  list_sources: {
    description:
      "List the assistant’s content sources, including sitemap sync details and source IDs.",
    output: { sources: { type: "array", items: object } },
  },
  get_content_status: {
    description: "Check whether recent content changes are still being indexed or settling.",
    output: { settling: bool, indexing: integer },
  },
  get_reindex_status: {
    description: "Count documents that still use an older indexing version.",
    output: { outdated: integer },
  },
  start_reindex: {
    output: { queued: integer, remaining: integer },
    description:
      "Queue a rebuild of outdated documents from stored content. Check reindex status for what remains.",
  },
  create_source: {
    output: { source: object },
    description:
      "Create a sitemap or written-answer source. Use push_documents to create a source for pushed content.",
    body: shape({ kind: choice("sitemap", "entry"), label: string, settings: object }, [
      "kind",
      "label",
    ]),
  },
  update_source: {
    output: { source: object },
    description:
      "Change a sitemap or written-answer source’s label. For sitemaps, you can also change the sync frequency, removal limit, and recheck period.",
    body: shape({ label: string, settings: object }),
    idempotent: true,
  },
  delete_source: {
    output: { deleted: bool },
    description:
      "Delete a sitemap or written-answer source and all its documents. Use prune_pushed_documents to clear pushed content.",
    destructive: true,
    idempotent: true,
  },
  list_documents: {
    description:
      "Page through a source’s document metadata. Use document IDs to read Markdown or edit written entries.",
    query: page,
    output: {
      documents: { type: "array", items: object },
      total: integer,
      limit: integer,
      offset: integer,
    },
  },
  get_document: {
    description:
      "Read the stored Markdown and metadata for a page, pushed document, or written entry.",
    output: { document: object, markdown: string },
  },
  delete_document: {
    output: { deleted: integer },
    description:
      "Delete one stored document or written entry from a source. A subsequent sitemap sync or push can add a page again.",
    destructive: true,
    idempotent: true,
  },
  create_entry: {
    destructive: true,
    output: entryOutput,
    description:
      "Add a written question and answer to the assistant’s default written-answer source.",
    body: entry,
  },
  create_source_entry: {
    destructive: true,
    output: entryOutput,
    description: "Add a written question and answer to a specific written-answer source.",
    body: entry,
  },
  update_entry: {
    output: entryOutput,
    description:
      "Replace the question and answer of an existing written entry with the supplied text.",
    body: entry,
    destructive: true,
  },
  preview_sitemap: {
    description: "Fetch a sitemap’s page URLs so you can choose what to import.",
    body: shape({ url: string }, ["url"]),
    readOnly: true,
    output: { urls: strings },
  },
  import_sitemap: {
    destructive: true,
    output: {
      source: object,
      written: integer,
      unchanged: integer,
      total: integer,
      skipped: integer,
    },
    description:
      "Import selected HTTPS page URLs into a new or existing sitemap source and queue them for indexing.",
    body: shape({ sitemapUrl: string, label: string, sourceId: string, urls: strings }, ["urls"]),
  },
  get_repeated_blocks: {
    description:
      "Read repeated text samples and how many pages contain each. Use this to inspect boilerplate the index detects.",
    output: { blocks: { type: "array", items: object } },
  },
  get_sync_status: {
    output: { sync: object },
    description:
      "Read the sitemap source’s schedule, latest outcome, progress, and next scheduled time.",
  },
  start_sync: {
    output: { sync: object },
    description:
      "Start a sitemap sync that can add, update, or remove pages. Pass allowRemovals only after reviewing the number withheld by the removal guard.",
    body: shape({ allowRemovals: integer }),
    optionalBody: true,
    destructive: true,
  },
  list_tool_servers: {
    description:
      "List tool servers the assistant can use and see which are enabled. Credential fields show status only.",
    output: { servers: { type: "array", items: object } },
  },
  add_tool_server: {
    output: { server: object, tools: objects },
    description:
      "Add an HTTPS MCP server the assistant can call, and discover its tools. Supplied credentials are write-only.",
    body: shape({ ...server, lookupKey: { ...string, writeOnly: true } }, ["label", "url"]),
  },
  update_tool_server: {
    output: { server: object },
    description:
      "Change an assistant tool server’s settings, enable it, or replace or clear a credential. Supplied credentials are write-only.",
    body: shape({ ...server, enabled: bool }),
    destructive: true,
  },
  remove_tool_server: {
    output: { deleted: bool },
    description: "Remove a tool server, its discovered tools, and its stored credentials.",
    destructive: true,
    idempotent: true,
  },
  refresh_tools: {
    output: { tools: objects },
    description:
      "Refresh the discovered tool catalog for a server. Tools the server removed can be dropped from the allowlist.",
    body: shape({ lookupKey: { ...string, writeOnly: true } }),
    optionalBody: true,
    destructive: true,
  },
  list_tools: {
    description: "List a server’s discovered tools and which are allowed for the assistant.",
    output: { tools: { type: "array", items: object } },
  },
  set_tool_allowed: {
    output: { tool: object },
    description:
      "Allow or disallow one tool in the assistant’s draft. Publish the draft to apply the change to visitors.",
    body: shape({ allowed: bool }, ["allowed"]),
    idempotent: true,
  },
  get_provider_settings: {
    output: providerOutput,
    description:
      "Read provider and model choices, whether review is enabled, and provider key status.",
  },
  update_provider_settings: {
    output: providerOutput,
    description:
      "Change the organization’s model, embedding provider, or answer review setting. Use null to restore a default.",
    body: shape({
      llmProvider: nullableString,
      llmTier: nullableString,
      llmModel: nullableString,
      embeddingsProvider: nullableString,
      reviewAnswers: { type: ["boolean", "null"] },
    }),
    idempotent: true,
  },
  set_provider_key: {
    output: keyOutput,
    description:
      "Store a new API key for a provider, replacing any previously stored key. The key is write-only.",
    body: shape({ key: { ...string, writeOnly: true } }, ["key"]),
    destructive: true,
  },
  remove_provider_key: {
    output: keyOutput,
    description: "Delete a provider’s stored API key. An environment key may then take effect.",
    destructive: true,
    idempotent: true,
  },
  test_provider_key: {
    output: { ok: bool, message: string },
    description:
      "Check whether the configured provider key works. Returns a status without revealing the key.",
    readOnly: true,
  },
  list_tests: {
    description: "List saved answer tests and their expectations.",
    output: { tests: { type: "array", items: object } },
  },
  create_test: {
    output: { test: object },
    description:
      "Save a question and expectation for checking the assistant’s answers before publishing.",
    body: { ...test, required: ["question", "expectation"] },
  },
  update_test: {
    output: { test: object },
    description: "Change a saved test’s question or expectation.",
    body: test,
    destructive: true,
    idempotent: true,
  },
  delete_test: {
    output: { deleted: bool },
    description: "Delete a saved answer test. Previous runs remain available.",
    destructive: true,
    idempotent: true,
  },
  run_tests: {
    output: runOutput,
    description:
      "Run saved answer tests against the current draft and record the results. This is the test command without a config file.",
  },
  list_test_runs: {
    description: "Read recent test runs with pass or fail results and preview trace IDs.",
    output: { runs: { type: "array", items: object } },
  },
  get_overview: {
    output: {
      topQuestions: objects,
      period: object,
      daily: objects,
      setup: object,
      attention: object,
      responseTime: object,
    },
    description:
      "Read the assistant’s recent activity, setup progress, and items that need attention.",
  },
  get_report: {
    output: {
      days: integer,
      topQuestions: objects,
      topGaps: objects,
      topics: object,
      topSources: objects,
      responseTime: object,
    },
    description:
      "Analyze activity, coverage, topics, content, and answer performance for the same reporting periods as the admin.",
    query: { days: { ...integer, enum: [7, 30, 90] } },
  },
  list_conversations: {
    output: { ...pageOutput, conversations: objects, searchPending: bool },
    description:
      "Search and page through visitor conversations by message text, outcome, grouped question, or topic. Retry if searchPending is true.",
    query: {
      ...page,
      days: { ...integer, enum: [1, 7, 30, 90] },
      q: string,
      filter: {
        ...string,
        description:
          "Comma-separated: unanswered, not_helpful, used_tool, could_not_answer, asked_for_person, off_topic.",
      },
      question: string,
      topic: string,
      askedFrom: {
        ...string,
        description: "Inclusive UTC day (YYYY-MM-DD) when filtering by question or topic.",
      },
      askedTo: {
        ...string,
        description: "Inclusive UTC day (YYYY-MM-DD) when filtering by question or topic.",
      },
    },
  },
  get_conversation: {
    output: { conversation: object, turns: objects },
    description:
      "Read the messages, citations, linked written answers and visitor feedback in one conversation.",
  },
  get_answer_trace: {
    output: traceOutput,
    description:
      "Inspect retrieval and model details for one assistant reply in a visitor conversation.",
  },
  get_preview_trace: {
    output: traceOutput,
    description:
      "Inspect retrieval and model details from a preview or test answer using its trace ID.",
  },
  list_gaps: {
    output: { ...pageOutput, gaps: objects },
    description:
      "Page through groups of unanswered questions. Use status open to focus on gaps still needing an answer.",
    query: { ...page, status: choice("open") },
  },
  dismiss_gap: {
    output: { question: string, dismissed: bool },
    description: "Hide a grouped unanswered question until a visitor asks it again.",
    body: shape({ question: string }, ["question"]),
  },
  restore_gap: {
    output: { question: string, dismissed: bool },
    description: "Undo a gap dismissal so the group can appear again.",
    body: shape({ question: string }, ["question"]),
    idempotent: true,
  },
  list_topics: {
    output: { topics: objects, reviewAnswers: bool },
    description: "List the topics used to group the assistant’s visitor questions.",
  },
  rename_topic: {
    output: { topic: object },
    description: "Set a topic’s display name without changing its linked questions.",
    body: shape({ name: string }, ["name"]),
    idempotent: true,
  },
  delete_topic: {
    output: { deleted: bool },
    description: "Delete a topic and clear its assignment from visitor questions.",
    destructive: true,
    idempotent: true,
  },
  merge_topic: {
    output: { topic: object },
    description: "Move a topic’s questions into another topic and delete the original topic.",
    body: shape({ into: string }, ["into"]),
    destructive: true,
    idempotent: true,
  },
  write_answer: {
    destructive: true,
    output: entryOutput,
    description:
      "Save the right answer for a gap, linking it to the visitor message that raised it.",
    body: shape({ question: string, answer: string, fromMessageId: string }, [
      "question",
      "answer",
      "fromMessageId",
    ]),
  },
  get_install_snippet: {
    output: {
      assistantId: string,
      publicKey: string,
      allowedOrigins: strings,
      snippet: string,
      hostPolicy: objects,
    },
    description:
      "Get the site’s widget embed code, allowed websites, and required Content-Security-Policy directives.",
  },
  preview_answer: {
    description:
      "Try a question against the current draft. Returns answer events and a preview trace ID without storing a visitor conversation.",
    body: shape(
      {
        assistant: { ...string, description: "Public widget key of the assistant." },
        message: string,
        history: {
          type: "array",
          items: shape({ role: choice("user", "assistant"), content: string }, ["role", "content"]),
        },
        visitorId: string,
        conversationId: string,
        pageUrl: string,
      },
      ["assistant", "message"],
    ),
    output: { answer: string, events: { type: "array", items: object } },
  },
  list_operator_access: {
    description:
      "List personal tokens and connected clients with their scopes and last use. Token values are never listed.",
    output: { access: { type: "array", items: object } },
  },
  create_personal_token: {
    output: { id: string, token: string, name: string, scope: string, createdAt: integer },
    description:
      "Create a named personal token. Returns the secret once. Revoking the credential used for this call also revokes the new token.",
    body: shape({ name: string, scope: scopes }, ["name", "scope"]),
  },
  revoke_operator_access: {
    output: { revoked: bool },
    description:
      "Revoke a personal token or client connection immediately, including tokens delegated from it.",
    destructive: true,
    idempotent: true,
  },
};

const sourceTarget = {
  source: { ...string, description: "Name of the push source." },
  sourceId: string,
};
const cliTools: Record<
  CliOperation,
  { description: string; properties: Record<string, OperatorToolSchema>; required: string[] }
> = {
  apply_config: {
    description:
      "Apply a solv.config.json object like solv apply. Validate before saving the draft, replacing declared tests, or applying declared tool-server context settings.",
    properties: { config: object },
    required: ["config"],
  },
  push_documents: {
    description:
      "Push Markdown documents to a named, explicit, or default push source. Set prune only when this batch contains the entire source. For several batches, prune separately with the complete keep list.",
    properties: {
      ...sourceTarget,
      documents: {
        type: "array",
        maxItems: MAX_BATCH_DOCUMENTS,
        items: shape({ externalId: string, url: string, title: string, markdown: string }, [
          "externalId",
          "markdown",
        ]),
      },
      prune: bool,
    },
    required: ["documents"],
  },
  prune_pushed_documents: {
    description:
      "Delete pushed documents missing from the complete list of external IDs to keep. Use after the last successful push when uploading multiple batches.",
    properties: { ...sourceTarget, keep: strings },
    required: ["keep"],
  },
  delete_pushed_documents: {
    description:
      "Delete pushed documents by external ID from one named, explicit, or default push source.",
    properties: { ...sourceTarget, externalIds: { ...strings, maxItems: MAX_BATCH_DOCUMENTS } },
    required: ["externalIds"],
  },
  run_declared_tests: {
    description:
      "Replace the saved tests with the supplied solv.config.json tests array, then run them against the draft like solv test with a file.",
    properties: { tests: { type: "array", items: test } },
    required: ["tests"],
  },
};

export interface OperationContext {
  request: Request;
  resource: string;
  operator: OperatorPrincipal;
  admin: AdminRouteDeps;
  ingest: Omit<IngestRouteDeps, "auth">;
}

export interface OperatorTool {
  name: string;
  description: string;
  inputSchema: OperatorToolSchema;
  outputSchema: OperatorToolSchema;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

/** A host tool using the same transport, scope filter, and operation policy. */
export interface HostedOperatorTool extends OperatorTool {
  run(args: Record<string, unknown>, operator: OperatorPrincipal): Response | Promise<Response>;
}

export function mountOperatorTools(additional: readonly HostedOperatorTool[] = []) {
  const catalog = new Map(
    operatorTools.map((tool) => [
      tool.name,
      { tool, run: undefined as HostedOperatorTool["run"] | undefined },
    ]),
  );
  for (const { run, ...tool } of additional) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name) || catalog.has(tool.name)) {
      throw new Error("Hosted operator tools need a valid, unique name.");
    }
    catalog.set(tool.name, { tool, run });
  }
  return catalog;
}

const pathFields = (path: string) =>
  path
    .split("/")
    .filter((part) => part.startsWith(":"))
    .map((param) => param.slice(1));

function adminTool(operation: (typeof adminOperations)[number]): OperatorTool {
  const info = adminToolInfo[operation.name];
  const params = pathFields(operation.path);
  const readOnly = info.readOnly ?? operation.method === "GET";
  return {
    name: operation.name,
    description: info.description,
    inputSchema: shape(
      {
        ...Object.fromEntries(params.map((param) => [param, string])),
        ...info.query,
        ...(info.body ? { body: info.body } : {}),
      },
      [...params, ...(info.body && !info.optionalBody ? ["body"] : [])],
    ),
    // https://modelcontextprotocol.io/specification/2025-11-25/server/tools#structured-content
    outputSchema: {
      ...object,
      ...(info.output ? { properties: info.output, required: Object.keys(info.output) } : {}),
    },
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: info.destructive ?? false,
      idempotentHint: readOnly || (info.idempotent ?? false),
      openWorldHint: true,
    },
  };
}

export const operatorTools: OperatorTool[] = [
  ...adminOperations.map(adminTool),
  ...Object.entries(cliTools).map(
    ([name, info]): OperatorTool => ({
      name,
      description: info.description,
      inputSchema: shape({ assistantId: string, ...info.properties }, [
        "assistantId",
        ...info.required,
      ]),
      outputSchema: name.endsWith("documents")
        ? {
            ...object,
            properties: { written: integer, unchanged: integer, deleted: integer },
            required: ["written", "unchanged", "deleted"],
          }
        : name === "apply_config"
          ? { ...object, properties: { config: object }, required: ["config"] }
          : { ...object, properties: runOutput, required: Object.keys(runOutput) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: name === "prune_pushed_documents" || name === "delete_pushed_documents",
        openWorldHint: true,
      },
    }),
  ),
].sort((a, b) => a.name.localeCompare(b.name));

export const cliCoverage = {
  apply: ["apply_config"],
  push: ["push_documents", "prune_pushed_documents", "delete_pushed_documents"],
  test: ["run_tests", "run_declared_tests"],
} as const;

export async function allowsAdminOperation(
  auth: AuthProvider,
  principal: OperatorPrincipal["principal"],
  name: string,
): Promise<boolean> {
  return (await auth.authorizeAdmin?.(principal, name)) ?? true;
}

const cliPermissions: Partial<Record<string, AdminOperationName[]>> = {
  apply_config: ["get_draft", "update_draft", "create_test", "delete_test", "update_tool_server"],
  push_documents: ["create_source", "delete_document"],
  prune_pushed_documents: ["delete_document"],
  delete_pushed_documents: ["delete_document"],
  run_declared_tests: ["create_test", "delete_test", "run_tests"],
};

async function allowsTool(auth: AuthProvider, operator: OperatorPrincipal, name: string) {
  if (
    ["list_operator_access", "create_personal_token", "revoke_operator_access"].includes(name) &&
    !auth.operator?.manage
  )
    return false;

  const permissions = Object.hasOwn(cliPermissions, name) ? cliPermissions[name] : undefined;
  for (const operation of permissions ?? [name]) {
    if (!(await allowsAdminOperation(auth, operator.principal, operation))) return false;
  }
  return true;
}

export async function availableTools(
  auth: AuthProvider,
  operator: OperatorPrincipal,
  candidates = operatorTools,
): Promise<OperatorTool[]> {
  const matches = await Promise.all(
    candidates.map(
      async (tool) =>
        (operator.scope === "full" || tool.annotations.readOnlyHint) &&
        (await allowsTool(auth, operator, tool.name)),
    ),
  );
  return candidates.filter((_, index) => matches[index]);
}

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0)
    throw new BadRequest([`${name}: provide a nonempty string`]);
  return value;
}

export async function callOperatorTool(
  tool: OperatorTool,
  args: Record<string, unknown>,
  context: OperationContext,
): Promise<Response> {
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(tool.inputSchema.properties ?? {}, key)) {
      throw new BadRequest([`${key}: this tool does not take that argument`]);
    }
  }
  const operation = adminOperations.find(({ name }) => name === tool.name);
  const url = new URL(context.resource);
  if (!operation) {
    return runCliOperation(
      tool.name as CliOperation,
      args,
      {
        assistantId: requireString(args, "assistantId"),
        orgId: context.operator.principal.orgId,
      },
      url.origin,
      context.ingest,
    );
  }

  const info = adminToolInfo[operation.name];
  const params = Object.fromEntries(
    pathFields(operation.path).map((param) => [param, requireString(args, param)]),
  );
  for (const key of Object.keys(info.query ?? {})) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== "string" && typeof value !== "number")
      throw new BadRequest([`${key}: provide a value`]);
    url.searchParams.set(key, String(value));
  }
  let body = args.body;
  if (info.body && (!info.optionalBody || body !== undefined) && !isPlainObject(body)) {
    throw new BadRequest(["body: provide a JSON object"]);
  }
  if (operation.name === "preview_answer" && isPlainObject(body)) {
    body = { visitorId: crypto.randomUUID(), ...body, protocol: CHAT_PROTOCOL_VERSION };
  }
  const headers = new Headers({ "content-type": "application/json" });
  const ip = context.request.headers.get("cf-connecting-ip");
  if (ip) headers.set("cf-connecting-ip", ip);
  return runAdminOperation(operation, {
    request: new Request(url, {
      method: operation.method,
      headers,
      ...(info.body && body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    url,
    deps: context.admin,
    params,
  });
}

export function toolException(error: unknown): Record<string, unknown> {
  if (error instanceof BadRequest) return { error: error.message, fields: error.errors };
  if (error instanceof NotFound)
    return { error: "That item was not found. Check its ID using the relevant list tool." };
  return { error: "The operation could not finish. Check its current state before retrying." };
}
