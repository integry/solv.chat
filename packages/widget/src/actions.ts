import {
  type ActionResult,
  MAX_ACTION_DESCRIPTION_LENGTH,
  MAX_ACTION_NAME_LENGTH,
  MAX_ACTION_RESULT_BYTES,
  MAX_ACTION_SCHEMA_BYTES,
  MAX_PAGE_ACTIONS,
  type PageAction,
} from "@solvchat/core";

const NAME_RE = /^[a-z][a-z0-9_]*$/;

const ANNOTATION_KEYS = new Set(["title", "description", "$schema", "$comment", "examples"]);
const OBJECT_KEYS = new Set(["type", "properties", "required", ...ANNOTATION_KEYS]);
const ARRAY_KEYS = new Set(["type", "items", ...ANNOTATION_KEYS]);
const PRIMITIVE_KEYS = new Set(["type", "enum", ...ANNOTATION_KEYS]);
const ENUM_ONLY_KEYS = new Set(["enum", ...ANNOTATION_KEYS]);
const PRIMITIVE_TYPES = new Set(["string", "number", "integer", "boolean"]);

/** One action gets this long to finish before the answer continues without it. */
export const ACTION_TIMEOUT_MS = 5000;

export interface RegisteredAction {
  name: string;
  description: string;
  input: Record<string, unknown>;
  confirm: boolean;
  run: (input: Record<string, unknown>) => unknown;
}

export interface RunRequest {
  callId: string;
  name: string;
  input: Record<string, unknown>;
  confirm: boolean;
}

const encoder = new TextEncoder();
const registry = new Map<string, RegisteredAction>();
let beforeListHook: (() => void) | null = null;

/** Internal hook so built-in schemas can refresh DOM marker inventories on request. */
export function setBeforeList(fn: (() => void) | null): void {
  beforeListHook = fn;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Registers a page action. Throws synchronously on invalid input rather than
 * ignoring it: this is called from the owner's own code at boot, so a mistake
 * should be loud in their console, not a silently missing capability later.
 */
export function register(action: unknown): void {
  if (!isRecord(action)) {
    throw new TypeError("solv.actions.register needs an object");
  }
  const name = typeof action.name === "string" ? action.name.trim() : "";
  if (!NAME_RE.test(name) || name.length > MAX_ACTION_NAME_LENGTH) {
    throw new TypeError(
      "solv.actions.register: name must be lower-case letters, digits and underscores",
    );
  }
  if (typeof action.description !== "string") {
    throw new TypeError(`solv.actions.register: ${name} needs a description string`);
  }
  const description = action.description.trim();
  if (description.length > MAX_ACTION_DESCRIPTION_LENGTH) {
    throw new TypeError(
      `solv.actions.register: ${name} description must be at most ${MAX_ACTION_DESCRIPTION_LENGTH} characters`,
    );
  }
  if (typeof action.run !== "function") {
    throw new TypeError(`solv.actions.register: ${name} needs a run function`);
  }
  if (!isRecord(action.input)) {
    throw new TypeError(`solv.actions.register: ${name} needs an input schema object`);
  }
  const schemaError = validateSchemaNode(action.input, "", true);
  if (schemaError !== null) {
    throw new TypeError(
      `solv.actions.register: ${name} input schema is not supported (${schemaError})`,
    );
  }
  // Capped here as well as in the engine's parser: a page that exceeds it
  // should find out at registration, not have its request rejected later.
  if (encoder.encode(JSON.stringify(action.input)).byteLength > MAX_ACTION_SCHEMA_BYTES) {
    throw new TypeError(`solv.actions.register: ${name} input schema is too large`);
  }
  // Re-registration replaces: a single-page app re-running its boot must not
  // accumulate duplicates, and two entries for one name would make which one
  // runs depend on insertion order.
  registry.set(name, {
    name,
    description,
    input: action.input,
    confirm: action.confirm === true,
    run: action.run as RegisteredAction["run"],
  });
}

export function unregister(name: string): void {
  registry.delete(name);
}

export function clearRegistry(): void {
  registry.clear();
}

/** What goes on the wire. Sorted by name so the request body is stable. */
export function listForRequest(): PageAction[] {
  beforeListHook?.();
  return [...registry.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_PAGE_ACTIONS)
    .map((action) => ({
      name: action.name,
      description: action.description,
      inputSchema: action.input,
      confirm: action.confirm,
    }));
}

export function lookup(name: string): RegisteredAction | undefined {
  return registry.get(name);
}

function checkAllowedKeys(
  schema: Record<string, unknown>,
  allowed: Set<string>,
  path: string,
): string | null {
  for (const key of Object.keys(schema)) {
    if (!allowed.has(key)) {
      return `${path || "input"} uses unsupported keyword ${key}`;
    }
  }
  return null;
}

function validateSchemaNode(
  schema: Record<string, unknown>,
  path: string,
  requireObject: boolean,
): string | null {
  if (requireObject && schema.type !== "object") {
    return "input schema must describe an object";
  }
  const label = path || "input";

  if (schema.type === "object") {
    const keyError = checkAllowedKeys(schema, OBJECT_KEYS, label);
    if (keyError !== null) return keyError;

    if (schema.properties !== undefined) {
      if (!isRecord(schema.properties)) return `${label}.properties must be an object`;
      for (const [key, prop] of Object.entries(schema.properties)) {
        const childPath = path ? `${path}.${key}` : key;
        if (!isRecord(prop)) return `${childPath} must be an object`;
        const err = validateSchemaNode(prop, childPath, false);
        if (err !== null) return err;
      }
    }
    if (schema.required !== undefined) {
      if (
        !Array.isArray(schema.required) ||
        schema.required.some((item) => typeof item !== "string")
      ) {
        return `${label}.required must be a list of strings`;
      }
    }
    return null;
  }

  if (schema.type === "array") {
    const keyError = checkAllowedKeys(schema, ARRAY_KEYS, label);
    if (keyError !== null) return keyError;
    if (!isRecord(schema.items)) return `${label} has no item schema`;
    return validateSchemaNode(schema.items, `${label}.items`, false);
  }

  if (typeof schema.type === "string" && PRIMITIVE_TYPES.has(schema.type)) {
    const keyError = checkAllowedKeys(schema, PRIMITIVE_KEYS, label);
    if (keyError !== null) return keyError;
    if (schema.enum !== undefined && !Array.isArray(schema.enum)) {
      return `${label}.enum must be a list`;
    }
    return null;
  }

  if (schema.type === undefined && Array.isArray(schema.enum)) {
    return checkAllowedKeys(schema, ENUM_ONLY_KEYS, label);
  }

  return `${label} cannot be checked`;
}

/**
 * Validates `value` against the subset of JSON Schema a page action input
 * needs: object with typed properties, required, enum, and nested objects or
 * arrays of typed items.
 *
 * Fails closed on anything it does not understand. The alternative — unknown
 * keyword means "allowed" — is how an action ends up running with input nobody
 * checked, and a real schema library is larger than this entire widget.
 */
export function validate(schema: Record<string, unknown>, value: unknown): string | null {
  const schemaError = validateSchemaNode(schema, "", true);
  if (schemaError !== null) return schemaError;
  if (!isRecord(value)) {
    return "input must be an object";
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];

  for (const key of required) {
    if (typeof key !== "string" || !Object.hasOwn(value, key) || value[key] === undefined) {
      return `missing ${String(key)}`;
    }
  }
  for (const [key, raw] of Object.entries(value)) {
    const property = Object.hasOwn(properties, key) ? properties[key] : undefined;
    // An unexpected key is refused rather than ignored: the model chose it,
    // and the page's run() was written against the schema it declared.
    if (!isRecord(property)) return `unexpected ${key}`;
    const problem = checkValue(property, raw, key);
    if (problem !== null) return problem;
  }
  return null;
}

function jsonEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => jsonEquals(item, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key) => Object.hasOwn(b, key) && jsonEquals(a[key], b[key]));
  }
  return false;
}

function checkValue(schema: Record<string, unknown>, value: unknown, path: string): string | null {
  if (Array.isArray(schema.enum) && !schema.enum.some((allowed) => jsonEquals(allowed, value))) {
    return `${path} is not an allowed value`;
  }
  if (schema.type === undefined && Array.isArray(schema.enum)) {
    return null;
  }
  switch (schema.type) {
    case "string":
      return typeof value === "string" ? null : `${path} must be a string`;
    case "number":
    case "integer":
      if (typeof value !== "number" || !Number.isFinite(value)) return `${path} must be a number`;
      return schema.type === "integer" && !Number.isInteger(value)
        ? `${path} must be a whole number`
        : null;
    case "boolean":
      return typeof value === "boolean" ? null : `${path} must be true or false`;
    case "array": {
      if (!Array.isArray(value)) return `${path} must be a list`;
      if (!isRecord(schema.items)) return `${path} has no item schema`;
      for (const [index, item] of value.entries()) {
        const problem = checkValue(schema.items, item, `${path}[${index}]`);
        if (problem !== null) return problem;
      }
      return null;
    }
    case "object":
      return validate(schema, value) === null ? null : `${path} is not valid`;
    default:
      // Unknown or missing type: refuse. Failing closed is the whole point.
      return `${path} cannot be checked`;
  }
}

/** Serialises a return value for the wire, capped and marked when truncated. */
export function serialiseResult(value: unknown): string {
  let text: string;
  try {
    text = value === undefined ? "null" : (JSON.stringify(value) ?? "null");
  } catch {
    // A page may return something with a cycle or a DOM node; the model does
    // not need it, and failing the action over it would be worse.
    text = '"(result could not be serialised)"';
  }
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= MAX_ACTION_RESULT_BYTES) return text;
  return `${new TextDecoder().decode(bytes.slice(0, MAX_ACTION_RESULT_BYTES - 32))}\n[truncated]`;
}

/**
 * Runs one action the engine asked for and produces the wire result.
 *
 * Every refusal is an `ok: false` result, never a thrown error: the visitor is
 * waiting for an answer, and the answer can continue without this action. The
 * `confirm` gate is a hook here and is implemented in the confirmation task.
 */
export async function runAction(
  request: RunRequest,
  options: {
    confirm?: (request: RunRequest, action: RegisteredAction) => Promise<boolean>;
    timeoutMs?: number;
  } = {},
): Promise<ActionResult> {
  const action = lookup(request.name);
  // The registry is the only authority. The engine offered this name because
  // the page sent it, but a stale or crafted event must find nothing.
  if (!action) {
    return { callId: request.callId, ok: false, error: "That action is not available." };
  }
  const problem = validate(action.input, request.input);
  if (problem !== null) {
    return { callId: request.callId, ok: false, error: `That action was not valid: ${problem}.` };
  }
  if (action.confirm || request.confirm) {
    if (!options.confirm) {
      return {
        callId: request.callId,
        ok: false,
        error: "That action requires confirmation.",
      };
    }
    const accepted = await options.confirm(request, action);
    if (!accepted) {
      return { callId: request.callId, ok: false, error: "The visitor did not confirm." };
    }
  }
  const timeoutMs = options.timeoutMs ?? ACTION_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      Promise.resolve().then(() => action.run(request.input)),
      new Promise((_resolve, reject) => {
        // A page action that never resolves must not hold the answer forever.
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
    return { callId: request.callId, ok: true, result: serialiseResult(value) };
  } catch {
    // The page's error is not forwarded: it can contain anything, and this
    // string becomes part of a model prompt.
    return { callId: request.callId, ok: false, error: "That action did not finish." };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Installs `globalThis.solv.actions`, merging into an existing `solv` object
 * if the host page created one before loading the widget.
 */
export function installGlobal(): void {
  const host = globalThis as { solv?: unknown };
  const existing = isRecord(host.solv) ? host.solv : {};
  host.solv = {
    ...existing,
    actions: { register, unregister },
  };
}

installGlobal();
