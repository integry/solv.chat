import {
  MAX_ACTION_DESCRIPTION_LENGTH,
  MAX_ACTION_NAME_LENGTH,
  MAX_ACTION_RESULT_BYTES,
  MAX_ACTION_SCHEMA_BYTES,
  MAX_PAGE_ACTIONS,
} from "@solvchat/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTION_TIMEOUT_MS,
  clearRegistry,
  listForRequest,
  lookup,
  register,
  runAction,
  unregister,
  validate,
} from "../src/actions.js";

const validAction = {
  name: "open_invoice",
  description: "Open one of the visitor's invoices",
  input: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
  confirm: false,
  run: async ({ id }: Record<string, unknown>) => ({ opened: id }),
};

describe("widget action registry", () => {
  beforeEach(() => {
    clearRegistry();
  });

  describe("register validation", () => {
    it("rejects non-objects", () => {
      expect(() => register(null)).toThrow(/object/);
      expect(() => register("open_invoice")).toThrow(/object/);
      expect(() => register([])).toThrow(/object/);
    });

    it("validates name against the protocol pattern and length limit", () => {
      expect(() => register({ ...validAction, name: "" })).toThrow(/name/);
      expect(() => register({ ...validAction, name: "OpenInvoice" })).toThrow(/name/);
      expect(() => register({ ...validAction, name: "1_bad" })).toThrow(/name/);
      expect(() => register({ ...validAction, name: "bad-name" })).toThrow(/name/);
      expect(() =>
        register({ ...validAction, name: "a".repeat(MAX_ACTION_NAME_LENGTH + 1) }),
      ).toThrow(/name/);
    });

    it("validates description is a string within the length limit", () => {
      expect(() => register({ ...validAction, description: 123 })).toThrow(/description/);
      expect(() =>
        register({
          ...validAction,
          description: "x".repeat(MAX_ACTION_DESCRIPTION_LENGTH + 1),
        }),
      ).toThrow(/description/);
    });

    it("validates run is a function", () => {
      expect(() => register({ ...validAction, run: "not a function" })).toThrow(/run/);
      expect(() => register({ ...validAction, run: undefined })).toThrow(/run/);
    });

    it("validates input is a JSON Schema object within the byte cap", () => {
      expect(() => register({ ...validAction, input: null })).toThrow(/input schema/);
      expect(() => register({ ...validAction, input: [] })).toThrow(/input schema/);
      expect(() => register({ ...validAction, input: "string" })).toThrow(/input schema/);
      expect(() =>
        register({
          ...validAction,
          input: {
            type: "object",
            properties: {
              big: { type: "string", description: "a".repeat(MAX_ACTION_SCHEMA_BYTES) },
            },
          },
        }),
      ).toThrow(/too large/);
    });

    it("rejects unsupported schema validation keywords recursively while allowing annotations", () => {
      expect(() =>
        register({
          ...validAction,
          input: {
            type: "object",
            properties: {
              quantity: { type: "integer", minimum: 1, maximum: 10 },
            },
          },
        }),
      ).toThrow(/unsupported keyword minimum/);

      expect(() =>
        register({
          ...validAction,
          input: {
            type: "object",
            properties: {
              nested: {
                type: "object",
                properties: {
                  code: { type: "string", pattern: "^[A-Z]+$" },
                },
              },
            },
          },
        }),
      ).toThrow(/unsupported keyword pattern/);

      expect(() =>
        register({
          ...validAction,
          input: {
            type: "object",
            properties: {
              tags: {
                type: "array",
                items: { type: "string", minLength: 2 },
              },
            },
          },
        }),
      ).toThrow(/unsupported keyword minLength/);

      expect(() =>
        register({
          ...validAction,
          input: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            title: "InvoiceInput",
            description: "Select an invoice",
            type: "object",
            properties: {
              id: { type: "string", title: "ID", examples: ["inv_1"] },
            },
            required: ["id"],
          },
        }),
      ).not.toThrow();
    });
  });

  it("replaces an existing action on re-registration and supports unregister", () => {
    register(validAction);
    register({
      ...validAction,
      description: "Updated description",
      confirm: true,
    });

    const list = listForRequest();
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      name: "open_invoice",
      description: "Updated description",
      inputSchema: validAction.input,
      confirm: true,
    });

    unregister("open_invoice");
    expect(lookup("open_invoice")).toBeUndefined();
    expect(listForRequest()).toEqual([]);
  });

  it("sorts and caps pageActions at MAX_PAGE_ACTIONS", () => {
    for (let i = MAX_PAGE_ACTIONS + 3; i >= 1; i--) {
      const suffix = String(i).padStart(2, "0");
      register({
        ...validAction,
        name: `action_${suffix}`,
      });
    }
    const list = listForRequest();
    expect(list).toHaveLength(MAX_PAGE_ACTIONS);
    expect(list[0]?.name).toBe("action_01");
    expect(list[MAX_PAGE_ACTIONS - 1]?.name).toBe(`action_${MAX_PAGE_ACTIONS}`);
  });
});

describe("action schema validator", () => {
  it("validates required fields and primitive types", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: "integer" },
        amount: { type: "number" },
        active: { type: "boolean" },
      },
      required: ["name", "count"],
    };

    expect(validate(schema, { name: "Ada", count: 3, amount: 12.5, active: true })).toBeNull();
    expect(validate(schema, { name: "Ada" })).toBe("missing count");
    expect(validate(schema, { name: "Ada", count: undefined })).toBe("missing count");
    expect(validate(schema, { name: 42, count: 3 })).toBe("name must be a string");
    expect(validate(schema, { name: "Ada", count: 3.5 })).toBe("count must be a whole number");
    expect(validate(schema, { name: "Ada", count: 3, amount: Number.NaN })).toBe(
      "amount must be a number",
    );
    expect(validate(schema, { name: "Ada", count: 3, active: "yes" })).toBe(
      "active must be true or false",
    );
  });

  it("validates enums and rejects unexpected keys", () => {
    const schema = {
      type: "object",
      properties: {
        plan: { type: "string", enum: ["free", "pro"] },
      },
      required: ["plan"],
    };

    expect(validate(schema, { plan: "pro" })).toBeNull();
    expect(validate(schema, { plan: "enterprise" })).toBe("plan is not an allowed value");
    expect(validate(schema, { plan: "pro", extra: true })).toBe("unexpected extra");
  });

  it("requires own properties for Object.prototype names, including in nested objects", () => {
    const schema = {
      type: "object",
      properties: {
        constructor: { type: "string" },
        nested: {
          type: "object",
          properties: {
            toString: { type: "string" },
          },
          required: ["toString"],
        },
      },
      required: ["constructor", "nested"],
    };

    expect(validate(schema, { nested: { toString: "ok" } })).toBe("missing constructor");
    expect(validate(schema, { constructor: undefined, nested: { toString: "ok" } })).toBe(
      "missing constructor",
    );
    expect(validate(schema, { constructor: "v1", nested: {} })).toBe("nested is not valid");
    expect(validate(schema, { constructor: "v1", nested: { toString: "ok" } })).toBeNull();
  });

  it("validates composite enum members across JSON round trips", () => {
    const schema = {
      type: "object",
      properties: {
        selection: {
          enum: [{ id: "inv_1", tags: ["a", "b"] }, ["x", 1], null],
        },
      },
      required: ["selection"],
    };

    const matchingObject = JSON.parse('{"selection":{"tags":["a","b"],"id":"inv_1"}}');
    const matchingArray = JSON.parse('{"selection":["x",1]}');
    const matchingNull = JSON.parse('{"selection":null}');
    const mismatchObject = JSON.parse('{"selection":{"id":"inv_2","tags":["a","b"]}}');
    const mismatchArray = JSON.parse('{"selection":["x",2]}');

    expect(validate(schema, matchingObject)).toBeNull();
    expect(validate(schema, matchingArray)).toBeNull();
    expect(validate(schema, matchingNull)).toBeNull();
    expect(validate(schema, mismatchObject)).toBe("selection is not an allowed value");
    expect(validate(schema, mismatchArray)).toBe("selection is not an allowed value");
  });

  it("validates nested objects and typed arrays", () => {
    const schema = {
      type: "object",
      properties: {
        filter: {
          type: "object",
          properties: {
            status: { type: "string" },
          },
          required: ["status"],
        },
        tags: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["filter", "tags"],
    };

    expect(
      validate(schema, { filter: { status: "open" }, tags: ["billing", "urgent"] }),
    ).toBeNull();
    expect(validate(schema, { filter: {}, tags: [] })).toBe("filter is not valid");
    expect(validate(schema, { filter: { status: "open" }, tags: "billing" })).toBe(
      "tags must be a list",
    );
    expect(validate(schema, { filter: { status: "open" }, tags: ["ok", 123] })).toBe(
      "tags[1] must be a string",
    );
  });

  it("fails closed on non-object root schemas, missing types, missing array item schemas, and unsupported keywords", () => {
    expect(validate({ type: "string" }, "hello")).toBe("input schema must describe an object");
    expect(validate({ type: "object", properties: { x: {} } }, { x: 1 })).toBe(
      "x cannot be checked",
    );
    expect(validate({ type: "object", properties: { arr: { type: "array" } } }, { arr: [1] })).toBe(
      "arr has no item schema",
    );
    expect(
      validate(
        {
          type: "object",
          properties: { quantity: { type: "integer", minimum: 1, maximum: 10 } },
        },
        { quantity: -1 },
      ),
    ).toBe("quantity uses unsupported keyword minimum");
    expect(
      validate(
        {
          type: "object",
          properties: { tags: { type: "array", items: { type: "string" }, minItems: 1 } },
        },
        { tags: [] },
      ),
    ).toBe("tags uses unsupported keyword minItems");
  });
});

describe("runAction", () => {
  beforeEach(() => {
    clearRegistry();
  });

  it("refuses unregistered actions and invalid input without calling run", async () => {
    const run = vi.fn();
    register({ ...validAction, run });

    const missing = await runAction({
      callId: "call_1",
      name: "does_not_exist",
      input: {},
      confirm: false,
    });
    expect(missing).toEqual({
      callId: "call_1",
      ok: false,
      error: "That action is not available.",
    });

    const invalid = await runAction({
      callId: "call_2",
      name: "open_invoice",
      input: { id: 123 },
      confirm: false,
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toContain("id must be a string");
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects missing Object.prototype-named required inputs and accepts JSON-parsed composite enums in runAction", async () => {
    const protoRun = vi.fn();
    register({
      name: "proto_action",
      description: "Test Object.prototype required property",
      input: {
        type: "object",
        properties: { constructor: { type: "string" } },
        required: ["constructor"],
      },
      confirm: false,
      run: protoRun,
    });

    const missingProto = await runAction({
      callId: "call_proto",
      name: "proto_action",
      input: JSON.parse("{}"),
      confirm: false,
    });
    expect(missingProto.ok).toBe(false);
    expect(missingProto.error).toContain("missing constructor");
    expect(protoRun).not.toHaveBeenCalled();

    const enumRun = vi.fn((input) => ({ selected: input.selection }));
    register({
      name: "select_item",
      description: "Select a composite enum item",
      input: {
        type: "object",
        properties: { selection: { enum: [{ id: "inv_1" }] } },
        required: ["selection"],
      },
      confirm: false,
      run: enumRun,
    });

    const matched = await runAction({
      callId: "call_enum_ok",
      name: "select_item",
      input: JSON.parse('{"selection":{"id":"inv_1"}}'),
      confirm: false,
    });
    expect(matched).toEqual({
      callId: "call_enum_ok",
      ok: true,
      result: '{"selected":{"id":"inv_1"}}',
    });
    expect(enumRun).toHaveBeenCalledTimes(1);
  });

  it("refuses confirmation-required actions when no confirmation handler is available", async () => {
    const run = vi.fn(async () => ({ ok: true }));
    register({ ...validAction, confirm: true, run });
    register({ ...validAction, name: "delete_invoice", confirm: false, run });

    const regConfirm = await runAction({
      callId: "call_reg_confirm",
      name: "open_invoice",
      input: { id: "inv_1" },
      confirm: false,
    });
    expect(regConfirm).toEqual({
      callId: "call_reg_confirm",
      ok: false,
      error: "That action requires confirmation.",
    });

    const eventConfirm = await runAction({
      callId: "call_event_confirm",
      name: "delete_invoice",
      input: { id: "inv_1" },
      confirm: true,
    });
    expect(eventConfirm).toEqual({
      callId: "call_event_confirm",
      ok: false,
      error: "That action requires confirmation.",
    });
    expect(run).not.toHaveBeenCalled();

    const rejected = await runAction(
      {
        callId: "call_reject",
        name: "open_invoice",
        input: { id: "inv_1" },
        confirm: false,
      },
      { confirm: async () => false },
    );
    expect(rejected).toEqual({
      callId: "call_reject",
      ok: false,
      error: "The visitor did not confirm.",
    });
    expect(run).not.toHaveBeenCalled();

    const accepted = await runAction(
      {
        callId: "call_accept",
        name: "open_invoice",
        input: { id: "inv_1" },
        confirm: false,
      },
      { confirm: async () => true },
    );
    expect(accepted).toEqual({
      callId: "call_accept",
      ok: true,
      result: '{"ok":true}',
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("caps oversized results at MAX_ACTION_RESULT_BYTES and marks truncation", async () => {
    register({
      ...validAction,
      run: () => ({ text: "a".repeat(MAX_ACTION_RESULT_BYTES * 2) }),
    });

    const res = await runAction({
      callId: "call_big",
      name: "open_invoice",
      input: { id: "inv_1" },
      confirm: false,
    });

    expect(res.ok).toBe(true);
    expect(res.result).toBeDefined();
    expect(res.result?.endsWith("\n[truncated]")).toBe(true);
    expect(new TextEncoder().encode(res.result).byteLength).toBeLessThanOrEqual(
      MAX_ACTION_RESULT_BYTES,
    );
  });

  it("returns ok: false when an action times out", async () => {
    vi.useFakeTimers();
    try {
      register({
        ...validAction,
        run: () => new Promise(() => {}),
      });

      const pending = runAction({
        callId: "call_hang",
        name: "open_invoice",
        input: { id: "inv_1" },
        confirm: false,
      });

      await vi.advanceTimersByTimeAsync(ACTION_TIMEOUT_MS);
      const res = await pending;
      expect(res).toEqual({
        callId: "call_hang",
        ok: false,
        error: "That action did not finish.",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
