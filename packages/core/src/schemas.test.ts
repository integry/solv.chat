import { describe, expect, it } from "vitest";
import {
  CHAT_PROTOCOL_VERSION,
  type ChatEvent,
  CONFIG_LIMITS,
  checkOrigin,
  defaultVersionConfig,
  Errors,
  fail,
  MAX_ACTION_DESCRIPTION_LENGTH,
  MAX_ACTION_NAME_LENGTH,
  MAX_ACTION_RESULT_BYTES,
  MAX_ACTION_SCHEMA_BYTES,
  MAX_CHAT_HISTORY_TURNS,
  MAX_DOCUMENT_MARKDOWN_BYTES,
  MAX_PAGE_ACTIONS,
  ok,
  parseAssistantInput,
  parseChatEventLine,
  parseChatRequest,
  parseDocumentInput,
  parseFeedbackRequest,
  parseSourceInput,
  parseVersionConfig,
  SUPPORTED_CHAT_PROTOCOLS,
  serializeChatEvent,
} from "./index.js";

describe("result", () => {
  it("constructs ok and fail results and collects field-prefixed errors", () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
    expect(fail("name: bad")).toEqual({ ok: false, errors: ["name: bad"] });

    const errors = new Errors();
    expect(errors.failed).toBe(false);
    errors.add("name", "must be 1 to 80 characters");
    expect(errors.failed).toBe(true);
    expect(errors.list).toEqual(["name: must be 1 to 80 characters"]);
  });
});

describe("parseAssistantInput", () => {
  it("parses a valid assistant, normalises and de-duplicates origins, and drops unknown keys", () => {
    const input = {
      name: "  Docs Helper  ",
      allowedOrigins: ["https://a.com/", "https://a.com", "http://localhost:3000/"],
      role: "admin",
    };
    const res = parseAssistantInput(input);
    expect(res).toEqual({
      ok: true,
      value: {
        name: "Docs Helper",
        allowedOrigins: ["https://a.com", "http://localhost:3000"],
      },
    });
    if (res.ok) {
      expect(res.value).not.toBe(input);
      expect("role" in res.value).toBe(false);
    }
  });

  it("rejects missing required fields with field names", () => {
    const res = parseAssistantInput({});
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.startsWith("name:"))).toBe(true);
      expect(res.errors.some((e) => e.startsWith("allowedOrigins:"))).toBe(true);
    }
  });

  it("rejects relative URLs, paths, queries, fragments, file:, and wildcards in allowedOrigins", () => {
    const bad = [
      "/relative",
      "https://a.com/docs",
      "https://a.com?x=1",
      "https://a.com#top",
      "file:///etc/passwd",
      "https://*",
      "https://*.example.com",
      "*",
    ];
    for (const origin of bad) {
      const res = parseAssistantInput({ name: "Bot", allowedOrigins: [origin] });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors[0]).toMatch(/^allowedOrigins\[0\]:/);
      }
    }
  });
});

describe("parseVersionConfig", () => {
  it("returns defaults for an empty object and does not return caller object by reference", () => {
    const input = {};
    const res = parseVersionConfig(input);
    expect(res).toEqual({ ok: true, value: defaultVersionConfig() });
    if (res.ok) {
      expect(res.value).not.toBe(input);
    }
  });

  it("merges partial sections over defaults and drops unknown keys", () => {
    const input = {
      behaviour: { greeting: "Hi there", extra: true },
      widget: { title: "Support", accentColor: "#112233" },
      unknownTopLevel: "ignored",
    };
    const res = parseVersionConfig(input);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const defaults = defaultVersionConfig();
      expect(res.value.behaviour).toEqual({
        ...defaults.behaviour,
        greeting: "Hi there",
      });
      expect(res.value.widget).toEqual({
        ...defaults.widget,
        title: "Support",
        accentColor: "#112233",
      });
      expect(res.value.limits).toEqual(defaults.limits);
      expect(res.value.allowedTools).toEqual([]);
      expect("unknownTopLevel" in res.value).toBe(false);
      expect("extra" in res.value.behaviour).toBe(false);
    }
  });

  it("merges partial sections over a provided base without mutating the base", () => {
    const base = {
      ...defaultVersionConfig(),
      behaviour: {
        greeting: "Custom greeting",
        persona: "Helpful guide",
        fallbackText: "Custom fallback",
        suggestedQuestions: ["How do I start?"],
      },
      widget: {
        title: "Docs Bot",
        accentColor: "#112233",
        position: "left" as const,
      },
      limits: { dailyCostCapMicros: 500 },
      allowedTools: ["search_docs"],
    };
    const res = parseVersionConfig({ behaviour: { greeting: "Welcome" } }, base);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.behaviour).toEqual({
        greeting: "Welcome",
        persona: "Helpful guide",
        fallbackText: "Custom fallback",
        suggestedQuestions: ["How do I start?"],
      });
      expect(res.value.widget).toEqual(base.widget);
      expect(res.value.limits).toEqual({ dailyCostCapMicros: 500 });
      expect(res.value.allowedTools).toEqual(["search_docs"]);
    }
    expect(base.behaviour.greeting).toBe("Custom greeting");
  });

  it("rejects bad hex colour, bad position, negative cap, and over-cap suggestedQuestions", () => {
    const res = parseVersionConfig({
      behaviour: {
        suggestedQuestions: ["q1", "q2", "q3", "q4", "q5", "q6", "q7"],
      },
      widget: {
        accentColor: "red",
        position: "center",
      },
      limits: {
        dailyCostCapMicros: -1,
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.startsWith("behaviour.suggestedQuestions:"))).toBe(true);
      expect(res.errors.some((e) => e.startsWith("widget.accentColor:"))).toBe(true);
      expect(res.errors.some((e) => e.startsWith("widget.position:"))).toBe(true);
      expect(res.errors.some((e) => e.startsWith("limits.dailyCostCapMicros:"))).toBe(true);
    }
  });

  it("parses actions section with origin normalisation and rejects invalid origins", () => {
    const valid = parseVersionConfig({
      actions: {
        builtins: true,
        allowedOrigins: ["https://shop.example.com/", "https://shop.example.com"],
      },
    });
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.value.actions).toEqual({
        builtins: true,
        allowedOrigins: ["https://shop.example.com"],
      });
    }

    const invalid = parseVersionConfig({
      actions: {
        builtins: "yes",
        allowedOrigins: ["https://example.com/path", "https://*.example.com", "ftp://example.com"],
      },
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.errors.some((e) => e.startsWith("actions.builtins:"))).toBe(true);
      expect(invalid.errors.some((e) => e.startsWith("actions.allowedOrigins[0]:"))).toBe(true);
      expect(invalid.errors.some((e) => e.startsWith("actions.allowedOrigins[1]:"))).toBe(true);
      expect(invalid.errors.some((e) => e.startsWith("actions.allowedOrigins[2]:"))).toBe(true);
    }
  });
});

describe("parseSourceInput", () => {
  it("parses valid push, entry, and sitemap sources and drops unknown keys", () => {
    const push = parseSourceInput({ kind: "push", label: "CLI", extra: 1 });
    expect(push).toEqual({ ok: true, value: { kind: "push", label: "CLI", settings: {} } });

    const entry = parseSourceInput({ kind: "entry", label: "FAQ", settings: { ignored: true } });
    expect(entry).toEqual({ ok: true, value: { kind: "entry", label: "FAQ", settings: {} } });

    const sitemap = parseSourceInput({
      kind: "sitemap",
      label: "Site",
      settings: { url: "https://example.com/sitemap.xml", ignored: true },
    });
    expect(sitemap).toEqual({
      ok: true,
      value: {
        kind: "sitemap",
        label: "Site",
        settings: { url: "https://example.com/sitemap.xml" },
      },
    });
  });

  it("rejects missing required fields and non-https sitemap urls", () => {
    const missing = parseSourceInput({});
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.errors.some((e) => e.startsWith("kind:"))).toBe(true);
      expect(missing.errors.some((e) => e.startsWith("label:"))).toBe(true);
    }

    const httpSitemap = parseSourceInput({
      kind: "sitemap",
      label: "Site",
      settings: { url: "http://example.com/sitemap.xml" },
    });
    expect(httpSitemap.ok).toBe(false);
    if (!httpSitemap.ok) {
      expect(httpSitemap.errors.some((e) => e.startsWith("settings.url:"))).toBe(true);
    }
  });
});

describe("parseSourceInput sync settings", () => {
  it("keeps a valid schedule and removal limit, and leaves both out when not given", () => {
    const daily = parseSourceInput({
      kind: "sitemap",
      label: "Site",
      settings: { url: "https://example.com/sitemap.xml", sync: "daily", maxRemovePercent: 20 },
    });
    expect(daily).toEqual({
      ok: true,
      value: {
        kind: "sitemap",
        label: "Site",
        settings: { url: "https://example.com/sitemap.xml", sync: "daily", maxRemovePercent: 20 },
      },
    });
  });

  it.each([
    [{ sync: "hourly" }, "settings.sync:"],
    [{ sync: true }, "settings.sync:"],
    [{ maxRemovePercent: 0 }, "settings.maxRemovePercent:"],
    [{ maxRemovePercent: 101 }, "settings.maxRemovePercent:"],
    [{ maxRemovePercent: 12.5 }, "settings.maxRemovePercent:"],
    [{ maxRemovePercent: "50" }, "settings.maxRemovePercent:"],
  ])("refuses %o", (extra, field) => {
    const result = parseSourceInput({
      kind: "sitemap",
      label: "Site",
      settings: { url: "https://example.com/sitemap.xml", ...extra },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.startsWith(field))).toBe(true);
  });
});

describe("parseDocumentInput", () => {
  it("parses a valid document and drops unknown keys", () => {
    const input = {
      externalId: "docs/intro",
      url: "https://example.com/docs/intro",
      title: "Introduction",
      markdown: "# Intro",
      extra: "drop-me",
    };
    const res = parseDocumentInput(input);
    expect(res).toEqual({
      ok: true,
      value: {
        externalId: "docs/intro",
        url: "https://example.com/docs/intro",
        title: "Introduction",
        markdown: "# Intro",
      },
    });
    if (res.ok) {
      expect(res.value).not.toBe(input);
      expect("extra" in res.value).toBe(false);
    }
  });

  it("rejects missing required fields, javascript: URLs, and markdown over 1 MiB", () => {
    const missing = parseDocumentInput({});
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.errors.some((e) => e.startsWith("externalId:"))).toBe(true);
      expect(missing.errors.some((e) => e.startsWith("url:"))).toBe(true);
      expect(missing.errors.some((e) => e.startsWith("title:"))).toBe(true);
      expect(missing.errors.some((e) => e.startsWith("markdown:"))).toBe(true);
    }

    const jsUrl = parseDocumentInput({
      externalId: "1",
      url: "javascript:alert(1)",
      title: "Bad",
      markdown: "hi",
    });
    expect(jsUrl.ok).toBe(false);
    if (!jsUrl.ok) {
      expect(jsUrl.errors.some((e) => e.startsWith("url:"))).toBe(true);
    }

    const tooBig = parseDocumentInput({
      externalId: "1",
      url: "https://example.com/big",
      title: "Big",
      markdown: "a".repeat(MAX_DOCUMENT_MARKDOWN_BYTES + 1),
    });
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) {
      expect(tooBig.errors.some((e) => e.startsWith("markdown:"))).toBe(true);
    }
  });
});

describe("chat schema and protocol", () => {
  it("exposes protocol version 2 and supports 1 and 2", () => {
    expect(CHAT_PROTOCOL_VERSION).toBe(2);
    expect(SUPPORTED_CHAT_PROTOCOLS).toEqual([1, 2]);
  });

  it("still parses the exact request body the phase 1 widget sends", () => {
    // Copied from packages/widget/src/element.ts as shipped in phase 1. If this
    // ever fails, a deployed widget has stopped working.
    const res = parseChatRequest({
      protocol: 1,
      assistant: "pk_abc123",
      visitorId: "vis_1",
      message: "How do I reset my password?",
      conversationId: "cnv_1",
      pageUrl: "https://example.com/help",
    });
    expect(res.ok).toBe(true);
  });

  it("parses a valid chat request and drops unknown keys", () => {
    const input = {
      protocol: 1,
      assistant: "pk_abc123",
      visitorId: "vis_1",
      message: "How do I reset my password?",
      conversationId: "cnv_123",
      pageUrl: "https://example.com/help",
      target: "draft",
      role: "admin",
    };
    const res = parseChatRequest(input);
    expect(res).toEqual({
      ok: true,
      value: {
        protocol: 1,
        assistant: "pk_abc123",
        visitorId: "vis_1",
        message: "How do I reset my password?",
        conversationId: "cnv_123",
        pageUrl: "https://example.com/help",
        target: "draft",
      },
    });
    if (res.ok) {
      expect(res.value).not.toBe(input);
      expect("role" in res.value).toBe(false);
    }
  });

  it("rejects missing protocol, unsupported protocol, empty/over-cap message, and non-pk_ key", () => {
    const missingProtocol = parseChatRequest({
      assistant: "pk_abc123",
      visitorId: "vis_1",
      message: "hi",
    });
    expect(missingProtocol.ok).toBe(false);
    if (!missingProtocol.ok) {
      expect(missingProtocol.errors).toContain("protocol: is required");
    }

    const unsupportedProtocol = parseChatRequest({
      protocol: 99,
      assistant: "pk_abc123",
      visitorId: "vis_1",
      message: "hi",
    });
    expect(unsupportedProtocol.ok).toBe(false);
    if (!unsupportedProtocol.ok) {
      expect(unsupportedProtocol.errors[0]).toContain("unsupported");
      expect(unsupportedProtocol.errors[0]).toContain("99");
      expect(unsupportedProtocol.errors[0]).toContain("1");
    }

    const badFields = parseChatRequest({
      protocol: 1,
      assistant: "sk_secret",
      visitorId: "",
      message: "   ",
    });
    expect(badFields.ok).toBe(false);
    if (!badFields.ok) {
      expect(badFields.errors.some((e) => e.startsWith("assistant:"))).toBe(true);
      expect(badFields.errors.some((e) => e.startsWith("visitorId:"))).toBe(true);
      expect(badFields.errors.some((e) => e.startsWith("message:"))).toBe(true);
    }

    const overCap = parseChatRequest({
      protocol: 1,
      assistant: "pk_abc123",
      visitorId: "vis_1",
      message: "x".repeat(4001),
    });
    expect(overCap.ok).toBe(false);
    if (!overCap.ok) {
      expect(overCap.errors.some((e) => e.startsWith("message:"))).toBe(true);
    }
  });

  it("parses optional history up to MAX_CHAT_HISTORY_TURNS and rejects invalid or over-cap history", () => {
    const turns = Array.from({ length: MAX_CHAT_HISTORY_TURNS }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `  turn ${i + 1}  `,
    }));
    const valid = parseChatRequest({
      protocol: 1,
      assistant: "pk_abc123",
      visitorId: "vis_1",
      message: "follow-up",
      target: "draft",
      history: turns,
    });
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.value.history).toHaveLength(MAX_CHAT_HISTORY_TURNS);
      expect(valid.value.history?.[0]).toEqual({ role: "user", content: "turn 1" });
    }

    const overCap = parseChatRequest({
      protocol: 1,
      assistant: "pk_abc123",
      visitorId: "vis_1",
      message: "follow-up",
      history: [...turns, { role: "user", content: "extra" }],
    });
    expect(overCap.ok).toBe(false);
    if (!overCap.ok) {
      expect(overCap.errors.some((e) => e.startsWith("history:"))).toBe(true);
    }

    const badTurn = parseChatRequest({
      protocol: 1,
      assistant: "pk_abc123",
      visitorId: "vis_1",
      message: "follow-up",
      history: [{ role: "system", content: "" }],
    });
    expect(badTurn.ok).toBe(false);
    if (!badTurn.ok) {
      expect(badTurn.errors.some((e) => e.startsWith("history[0].role:"))).toBe(true);
      expect(badTurn.errors.some((e) => e.startsWith("history[0].content:"))).toBe(true);
    }
  });

  it("round-trips every ChatEvent through serializeChatEvent and parseChatEventLine", () => {
    const events: ChatEvent[] = [
      { type: "token", text: "Hello " },
      { type: "citation", url: "https://example.com/docs", title: "Docs" },
      { type: "tool", name: "lookup", state: "running" },
      {
        type: "tool",
        name: "lookup_order",
        state: "done",
        callId: "call_1",
        kind: "mcp",
        ok: true,
      },
      {
        type: "action",
        callId: "call_2",
        name: "navigate",
        input: { path: "/billing" },
        confirm: false,
      },
      { type: "done", messageId: "msg_1", conversationId: "cnv_1" },
      {
        type: "done",
        messageId: "msg_2",
        conversationId: "cnv_1",
        awaitingActions: ["call_2"],
      },
      { type: "error", message: "Rate limit exceeded" },
    ];

    for (const event of events) {
      const serialized = serializeChatEvent(event);
      const lines = serialized.trim().split("\n");
      const name = lines[0]?.replace(/^event: /, "") ?? "";
      const data = lines[1]?.replace(/^data: /, "") ?? "";
      expect(parseChatEventLine(name, data)).toEqual(event);
    }
  });

  it("keeps a v2 tool event readable by a v1 reader", () => {
    const line = serializeChatEvent({
      type: "tool",
      name: "lookup_order",
      state: "done",
      callId: "call_1",
      kind: "mcp",
      ok: true,
    });
    const [nameLine, dataLine] = line.trim().split("\n");
    const parsed = parseChatEventLine(
      (nameLine ?? "").replace(/^event: /, ""),
      (dataLine ?? "").replace(/^data: /, ""),
    );
    // A v1 widget reads name and state; the detail is additive.
    expect(parsed).toMatchObject({ type: "tool", name: "lookup_order", state: "done" });
  });

  it("treats an action event as unknown when the reader does not know the name and drops extra keys on known events", () => {
    // The forward-compatibility rule the phase 1 comment promised.
    expect(parseChatEventLine("action_v3", '{"callId":"c1"}')).toEqual({
      type: "unknown",
      name: "action_v3",
    });
    expect(
      parseChatEventLine(
        "action",
        '{"callId":"c1","name":"navigate","input":{"path":"/home"},"confirm":true,"extra":"ignored"}',
      ),
    ).toEqual({
      type: "action",
      callId: "c1",
      name: "navigate",
      input: { path: "/home" },
      confirm: true,
    });
  });

  it("parses, trims, and deduplicates pageActions and rejects over-cap values", () => {
    const valid = parseChatRequest({
      protocol: 2,
      assistant: "pk_abc123",
      visitorId: "vis_1",
      message: "Take me to billing",
      pageActions: [
        {
          name: "  navigate  ",
          description: "  Go to a page  ",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
          confirm: true,
        },
        {
          name: "navigate",
          description: "Duplicate ignored",
          inputSchema: { type: "object" },
          confirm: false,
        },
      ],
    });
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.value.pageActions).toEqual([
        {
          name: "navigate",
          description: "Go to a page",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
          confirm: true,
        },
      ]);
    }

    const tooMany = parseChatRequest({
      protocol: 2,
      assistant: "pk_abc123",
      visitorId: "vis_1",
      message: "hi",
      pageActions: Array.from({ length: MAX_PAGE_ACTIONS + 1 }, (_, i) => ({
        name: `act_${i}`,
        description: "desc",
        inputSchema: { type: "object" },
      })),
    });
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) {
      expect(tooMany.errors.some((e) => e.startsWith("pageActions:"))).toBe(true);
    }

    const badName = parseChatRequest({
      protocol: 2,
      assistant: "pk_abc123",
      visitorId: "vis_1",
      message: "hi",
      pageActions: [
        {
          name: "a".repeat(MAX_ACTION_NAME_LENGTH + 1),
          description: "desc",
          inputSchema: { type: "object" },
        },
      ],
    });
    expect(badName.ok).toBe(false);
    if (!badName.ok) {
      expect(badName.errors.some((e) => e.startsWith("pageActions[0].name:"))).toBe(true);
    }

    const badDesc = parseChatRequest({
      protocol: 2,
      assistant: "pk_abc123",
      visitorId: "vis_1",
      message: "hi",
      pageActions: [
        {
          name: "navigate",
          description: "d".repeat(MAX_ACTION_DESCRIPTION_LENGTH + 1),
          inputSchema: { type: "object" },
        },
      ],
    });
    expect(badDesc.ok).toBe(false);
    if (!badDesc.ok) {
      expect(badDesc.errors.some((e) => e.startsWith("pageActions[0].description:"))).toBe(true);
    }

    const bigSchema = parseChatRequest({
      protocol: 2,
      assistant: "pk_abc123",
      visitorId: "vis_1",
      message: "hi",
      pageActions: [
        {
          name: "navigate",
          description: "desc",
          inputSchema: { pad: "x".repeat(MAX_ACTION_SCHEMA_BYTES) },
        },
      ],
    });
    expect(bigSchema.ok).toBe(false);
    if (!bigSchema.ok) {
      expect(bigSchema.errors.some((e) => e.startsWith("pageActions[0].inputSchema:"))).toBe(true);
    }
  });

  it("requires resumeMessageId with actionResults, allows absent message, rejects neither, and caps result size", () => {
    const neither = parseChatRequest({
      protocol: 2,
      assistant: "pk_abc123",
      visitorId: "vis_1",
    });
    expect(neither.ok).toBe(false);
    if (!neither.ok) {
      expect(neither.errors.some((e) => e.startsWith("message:"))).toBe(true);
    }

    const missingResume = parseChatRequest({
      protocol: 2,
      assistant: "pk_abc123",
      visitorId: "vis_1",
      actionResults: [{ callId: "call_1", ok: true, result: "{}" }],
    });
    expect(missingResume.ok).toBe(false);
    if (!missingResume.ok) {
      expect(missingResume.errors.some((e) => e.startsWith("resumeMessageId:"))).toBe(true);
    }

    const valid = parseChatRequest({
      protocol: 2,
      assistant: "pk_abc123",
      visitorId: "vis_1",
      conversationId: "cnv_1",
      resumeMessageId: "msg_1",
      actionResults: [{ callId: "call_1", ok: true, result: "{}" }],
    });
    expect(valid.ok).toBe(true);
    if (valid.ok) expect(valid.value.message).toBeUndefined();

    const oversizedResult = parseChatRequest({
      protocol: 2,
      assistant: "pk_abc123",
      visitorId: "vis_1",
      conversationId: "cnv_1",
      resumeMessageId: "msg_1",
      actionResults: [
        {
          callId: "call_1",
          ok: true,
          result: "r".repeat(MAX_ACTION_RESULT_BYTES + 1),
        },
      ],
    });
    expect(oversizedResult.ok).toBe(false);
    if (!oversizedResult.ok) {
      expect(oversizedResult.errors.some((e) => e.startsWith("actionResults[0].result:"))).toBe(
        true,
      );
    }
  });

  it("returns unknown for unrecognised event names and malformed data without throwing", () => {
    expect(parseChatEventLine("future_event", '{"kind":"navigate"}')).toEqual({
      type: "unknown",
      name: "future_event",
    });
    expect(parseChatEventLine("token", "{not valid json")).toEqual({
      type: "unknown",
      name: "token",
    });
    expect(parseChatEventLine("token", '{"wrongField":123}')).toEqual({
      type: "unknown",
      name: "token",
    });
  });
});

describe("parseFeedbackRequest", () => {
  it("parses valid feedback with optional note and drops unknown keys", () => {
    const res = parseFeedbackRequest({
      messageId: "msg_1",
      visitorId: "vis_1",
      value: "up",
      note: "  helpful  ",
      extra: true,
    });
    expect(res).toEqual({
      ok: true,
      value: {
        messageId: "msg_1",
        visitorId: "vis_1",
        value: "up",
        note: "helpful",
      },
    });

    const withoutNote = parseFeedbackRequest({
      messageId: "msg_1",
      visitorId: "vis_1",
      value: "down",
    });
    expect(withoutNote).toEqual({
      ok: true,
      value: {
        messageId: "msg_1",
        visitorId: "vis_1",
        value: "down",
        note: "",
      },
    });
  });

  it("rejects invalid vote values and missing fields", () => {
    const res = parseFeedbackRequest({
      messageId: "",
      visitorId: "vis_1",
      value: "meh",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.startsWith("messageId:"))).toBe(true);
      expect(res.errors.some((e) => e.startsWith("value:"))).toBe(true);
    }
  });
});

describe("checkOrigin", () => {
  it("accepts an origin and returns it normalised", () => {
    expect(checkOrigin("  https://Docs.Example.com ")).toEqual({
      ok: true,
      origin: "https://docs.example.com",
    });
  });

  it("returns the same message the API gives, without the field name", () => {
    expect(checkOrigin("docs.example.com")).toEqual({
      ok: false,
      error: "must be an absolute URL such as https://example.com",
    });
    expect(checkOrigin("https://docs.example.com/help")).toEqual({
      ok: false,
      error: "must be an origin only, with no path",
    });
  });
});

describe("CONFIG_LIMITS", () => {
  it("is what the parser enforces", () => {
    const tooLong = "x".repeat(CONFIG_LIMITS.greeting + 1);
    const res = parseVersionConfig({ behaviour: { greeting: tooLong } });
    expect(res.ok).toBe(false);
    const ok = parseVersionConfig({
      behaviour: { greeting: "x".repeat(CONFIG_LIMITS.greeting) },
    });
    expect(ok.ok).toBe(true);
  });
});
