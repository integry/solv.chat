import { MAX_ACTION_SCHEMA_BYTES } from "@solvchat/core";
import { lookup, type RegisteredAction, register, setBeforeList, unregister } from "./actions.js";

/** Marker attributes. Documented in docs/architecture.md under Page actions. */
export const TARGET_ATTRIBUTE = "data-solv-target";
export const FILL_ATTRIBUTE = "data-solv-fill";
/** On a form or any ancestor: nothing inside it may be filled. */
export const NO_FILL_ATTRIBUTE = "data-solv-no-fill";

export const HIGHLIGHT_DURATION_MS = 5000;
const MAX_MARKER_NAMES = 50;
const VIEWPORT_MARGIN_PX = 8;

/**
 * Input types that are never filled or read, whatever the markup says.
 * `password` and payment fields are the specification's rule; `hidden`,
 * `file`, `submit` and `image` are here because filling them is either
 * meaningless or a click.
 */
const REFUSED_TYPES = new Set([
  "password",
  "hidden",
  "file",
  "submit",
  "image",
  "button",
  "reset",
  "checkbox",
  "radio",
]);

/**
 * autocomplete purposes that mark a field as payment or one-time code.
 * Source: HTML Living Standard, autofill field names —
 * https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#autofill
 * (checked 2026-11-15). Matched token-wise because the attribute may carry a
 * section or a billing/shipping prefix.
 */
const REFUSED_AUTOCOMPLETE = new Set([
  "cc-name",
  "cc-given-name",
  "cc-additional-name",
  "cc-family-name",
  "cc-number",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
  "cc-csc",
  "cc-type",
  "one-time-code",
  "current-password",
  "new-password",
]);

export interface BuiltinSettings {
  enabled: boolean;
  /** Extra origins the owner listed for navigate. The current origin is implicit. */
  allowedOrigins: readonly string[];
}

type FillTarget = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

interface ActiveHighlight {
  element: HTMLElement;
  prevStyleAttr: string | null;
  noteEl: HTMLElement | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  cleanup?: () => void;
}

const installedBuiltins = new Map<string, RegisteredAction>();
const schemaEncoder = new TextEncoder();
let activeHighlight: ActiveHighlight | null = null;
let highlightHost: ShadowRoot | null = null;
let beforeNavigate: ((targetHref: string) => void) | null = null;

/** Sets the widget shadow root that hosts highlight notes styled by styles.ts. */
export function setHighlightHost(root: ShadowRoot | null): void {
  highlightHost = root;
}

/** Registers a hook invoked right before `navigate` leaves the current document. */
export function setBeforeNavigate(handler: ((targetHref: string) => void) | null): void {
  beforeNavigate = handler;
}

function escapeAttrValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}

function isFillTarget(element: Element): element is FillTarget {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  );
}

function isRefusedField(element: Element): string | null {
  if (!element.hasAttribute(FILL_ATTRIBUTE)) return "that field is not fillable";
  // An ancestor opt-out, checked before anything else: an owner marking a
  // whole payment form should not have to mark each field.
  if (element.closest(`[${NO_FILL_ATTRIBUTE}]`) !== null) return "that field is not fillable";
  if (!isFillTarget(element)) return "that field is not fillable";
  const type = (element.getAttribute("type") ?? "text").trim().toLowerCase();
  if (REFUSED_TYPES.has(type)) return "that kind of field is never filled";
  const tokens = (element.getAttribute("autocomplete") ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token !== "");
  if (tokens.some((token) => REFUSED_AUTOCOMPLETE.has(token))) {
    return "payment and one-time-code fields are never filled";
  }
  // `inputmode="numeric"` alone is not a payment field, but a name that says
  // so is a strong enough signal to refuse: the cost of a false refusal is a
  // visitor typing it themselves.
  const name = `${element.getAttribute("name") ?? ""} ${element.id}`.toLowerCase();
  if (/(^|[^a-z])(cvv|cvc|cardnumber|card_number|otp)([^a-z]|$)/.test(name)) {
    return "payment and one-time-code fields are never filled";
  }
  return null;
}

function normalizeOrigins(origins: readonly string[]): Set<string> {
  const allowed = new Set<string>();
  for (const raw of origins) {
    try {
      allowed.add(new URL(raw).origin);
    } catch {
      if (raw) allowed.add(raw);
    }
  }
  return allowed;
}

/**
 * Resolves a model-supplied URL against the page and checks the origin.
 *
 * Re-resolved locally rather than trusted: a protocol-relative `//host/path`
 * or a `javascript:` URL both look like paths to a careless check, and both
 * would leave the owner's site.
 */
function resolveNavigation(raw: string, allowedOrigins: Set<string>): URL | string {
  let url: URL;
  try {
    url = new URL(raw, location.href);
  } catch {
    return "that address could not be read";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "only web addresses can be opened";
  }
  if (url.origin !== location.origin) {
    if (!allowedOrigins.has(url.origin)) {
      return "that address is not on this site";
    }
    // Same-tab sessionStorage is origin-scoped and no cross-origin handoff
    // exists yet, so cross-origin navigation cannot preserve the conversation.
    return "that address is on another origin where this conversation cannot continue";
  }
  return url;
}

/** Removes any active highlight outline, note, listeners, and auto-dismiss timer. */
export function clearHighlight(): void {
  if (!activeHighlight) return;
  if (activeHighlight.timer !== undefined) {
    clearTimeout(activeHighlight.timer);
  }
  activeHighlight.cleanup?.();
  if (activeHighlight.prevStyleAttr === null) {
    activeHighlight.element.removeAttribute("style");
  } else {
    activeHighlight.element.setAttribute("style", activeHighlight.prevStyleAttr);
  }
  activeHighlight.noteEl?.remove();
  activeHighlight = null;
}

function rememberAndOutline(element: HTMLElement): void {
  const prevStyleAttr = element.getAttribute("style");
  element.style.outline = "2px solid #2563eb";
  element.style.outlineOffset = "3px";
  const timer = setTimeout(clearHighlight, HIGHLIGHT_DURATION_MS);
  activeHighlight = { element, prevStyleAttr, noteEl: null, timer };
}

function positionNote(element: HTMLElement, note: HTMLElement): void {
  const rect = element.getBoundingClientRect();
  const noteRect = note.getBoundingClientRect();
  const noteWidth = noteRect.width || note.offsetWidth || 260;
  const noteHeight = noteRect.height || note.offsetHeight || 40;
  const vw =
    typeof window !== "undefined"
      ? window.innerWidth || document.documentElement.clientWidth || 0
      : 0;
  const vh =
    typeof window !== "undefined"
      ? window.innerHeight || document.documentElement.clientHeight || 0
      : 0;

  let left = Math.max(VIEWPORT_MARGIN_PX, rect.left);
  if (vw > 0) {
    left = Math.min(left, Math.max(VIEWPORT_MARGIN_PX, vw - noteWidth - VIEWPORT_MARGIN_PX));
  }

  const maxTop =
    vh > 0
      ? Math.max(VIEWPORT_MARGIN_PX, vh - noteHeight - VIEWPORT_MARGIN_PX)
      : Number.POSITIVE_INFINITY;
  let top = rect.bottom + VIEWPORT_MARGIN_PX;
  if (vh > 0 && top > maxTop) {
    const above = rect.top - noteHeight - VIEWPORT_MARGIN_PX;
    top = above >= VIEWPORT_MARGIN_PX && above <= maxTop ? above : maxTop;
  }
  top = Math.max(VIEWPORT_MARGIN_PX, Math.min(top, maxTop));

  note.style.top = `${Math.round(top)}px`;
  note.style.left = `${Math.round(left)}px`;
}

function showNote(element: HTMLElement, text: string): void {
  if (!activeHighlight) return;
  const note = document.createElement("div");
  note.className = "solv-highlight-note";
  note.setAttribute("role", "status");
  note.textContent = text;

  if (highlightHost?.isConnected) {
    highlightHost.append(note);
  } else {
    // Fallback when highlight runs outside a mounted <solv-chat> shadow root.
    note.style.position = "fixed";
    note.style.zIndex = "2147483647";
    note.style.maxWidth = "260px";
    note.style.padding = "6px 10px";
    note.style.border = "1px solid #e2e8f0";
    note.style.borderRadius = "8px";
    note.style.background = "#ffffff";
    note.style.color = "#0f172a";
    note.style.fontSize = "13px";
    note.style.boxShadow = "0 12px 32px rgba(15, 23, 42, 0.16)";
    note.style.pointerEvents = "none";
    document.body.append(note);
  }

  positionNote(element, note);
  const onReposition = () => {
    if (activeHighlight?.noteEl === note) {
      positionNote(element, note);
    }
  };
  if (typeof window !== "undefined") {
    window.addEventListener("scroll", onReposition, { capture: true, passive: true });
    window.addEventListener("scrollend", onReposition, { capture: true, passive: true });
    window.addEventListener("resize", onReposition, { passive: true });
    activeHighlight.cleanup = () => {
      window.removeEventListener("scroll", onReposition, { capture: true });
      window.removeEventListener("scrollend", onReposition, { capture: true });
      window.removeEventListener("resize", onReposition);
    };
  }
  activeHighlight.noteEl = note;
}

function decodeFragmentId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function buildBoundedInputSchema(
  attribute: string,
  buildSchema: (names: string[]) => Record<string, unknown>,
  filter?: (element: Element) => boolean,
): Record<string, unknown> {
  let currentSchema = buildSchema([]);
  if (typeof document === "undefined") return currentSchema;

  const names: string[] = [];
  const seen = new Set<string>();
  for (const element of document.querySelectorAll(`[${attribute}]`)) {
    if (names.length >= MAX_MARKER_NAMES) break;
    const raw = element.getAttribute(attribute);
    if (!raw || seen.has(raw)) continue;
    if (filter && !filter(element)) continue;
    seen.add(raw);
    if (schemaEncoder.encode(JSON.stringify(raw)).byteLength > MAX_ACTION_SCHEMA_BYTES) {
      continue;
    }
    const candidateNames = [...names, raw];
    const candidateSchema = buildSchema(candidateNames);
    if (
      schemaEncoder.encode(JSON.stringify(candidateSchema)).byteLength > MAX_ACTION_SCHEMA_BYTES
    ) {
      continue;
    }
    names.push(raw);
    currentSchema = candidateSchema;
  }
  return currentSchema;
}

function highlightInputSchema(): Record<string, unknown> {
  return buildBoundedInputSchema(TARGET_ATTRIBUTE, (targets) => ({
    type: "object",
    properties: {
      target: targets.length > 0 ? { type: "string", enum: targets } : { type: "string" },
      note: { type: "string" },
    },
    required: ["target"],
  }));
}

function fillInputSchema(): Record<string, unknown> {
  return buildBoundedInputSchema(
    FILL_ATTRIBUTE,
    (fillables) => ({
      type: "object",
      properties: {
        fields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: fillables.length > 0 ? { type: "string", enum: fillables } : { type: "string" },
              value: { type: "string" },
            },
            required: ["name", "value"],
          },
        },
      },
      required: ["fields"],
    }),
    (el) => isRefusedField(el) === null,
  );
}

function refreshBuiltinSchemas(): void {
  const highlight = installedBuiltins.get("highlight");
  if (highlight && lookup("highlight") === highlight) {
    highlight.input = highlightInputSchema();
  }
  const fill = installedBuiltins.get("fill");
  if (fill && lookup("fill") === fill) {
    fill.input = fillInputSchema();
  }
}

/** Registers the built-ins the owner enabled, and removes the ones they did not. */
export function installBuiltins(settings: BuiltinSettings): void {
  if (!settings.enabled) {
    setBeforeList(null);
    // Off by default and removable: a config that arrives saying "disabled"
    // after an earlier one said "enabled" must take tools away, without
    // removing a page's own custom action of the same name.
    for (const [name, action] of installedBuiltins) {
      if (lookup(name) === action) {
        unregister(name);
      }
    }
    installedBuiltins.clear();
    return;
  }

  const allowedOrigins = normalizeOrigins(settings.allowedOrigins);

  const builtins: RegisteredAction[] = [
    {
      name: "navigate",
      description: "Open a page on this site, optionally scrolling to a section.",
      input: {
        type: "object",
        properties: { url: { type: "string" }, section: { type: "string" } },
        required: ["url"],
      },
      confirm: false,
      run: (input) => {
        clearHighlight();
        const target = resolveNavigation(String(input.url ?? ""), allowedOrigins);
        if (typeof target === "string") throw new Error(target);
        if (typeof input.section === "string" && input.section !== "") {
          const section = input.section.startsWith("#") ? input.section.slice(1) : input.section;
          if (section !== "") target.hash = section;
        }
        // A section on this page is a scroll, not a reload: the conversation
        // continues in front of the visitor instead of blinking away.
        const samePage =
          target.origin === location.origin &&
          target.pathname === location.pathname &&
          target.search === location.search;
        if (samePage && target.hash !== "") {
          const rawId = target.hash.slice(1);
          const decodedId = decodeFragmentId(rawId);
          const element =
            document.getElementById(decodedId) ??
            (decodedId !== rawId ? document.getElementById(rawId) : null);
          if (!element) throw new Error("that section is not on this page");
          element.scrollIntoView({ behavior: "smooth", block: "center" });
          return { scrolledTo: element.id || decodedId };
        }
        beforeNavigate?.(target.href);
        location.assign(target.href);
        // The conversation survives this because the transcript, the
        // conversation id and the pending resume are persisted before leaving.
        return { opened: target.href };
      },
    },
    {
      name: "highlight",
      description: "Point at a control on this page and explain it in a few words.",
      input: highlightInputSchema(),
      confirm: false,
      run: (input) => {
        const name = String(input.target ?? "");
        // A name, never a selector: the page decides what is pointable by
        // marking it, so the model cannot reach anything else.
        const element =
          name !== ""
            ? (document.querySelector(
                `[${TARGET_ATTRIBUTE}="${escapeAttrValue(name)}"]`,
              ) as HTMLElement | null)
            : null;
        if (!element) throw new Error("there is nothing by that name on this page");
        clearHighlight();
        element.scrollIntoView({ behavior: "smooth", block: "center" });
        // Inline styles, recorded and restored: injecting a page stylesheet
        // would outlive the note and could collide with the owner's CSS.
        rememberAndOutline(element);
        if (typeof input.note === "string" && input.note !== "") {
          showNote(element, input.note);
        }
        return { highlighted: name };
      },
    },
    {
      name: "fill",
      description: "Put values into the fields on this page that accept them. Never submits.",
      input: fillInputSchema(),
      // Always confirmed, per the specification: every fill waits for the
      // visitor. The prompt itself is the confirmation task.
      confirm: true,
      run: (input) => {
        clearHighlight();
        const requested = Array.isArray(input.fields) ? input.fields : [];
        const filled: string[] = [];
        const refused: Array<{ name: string; why: string }> = [];
        for (const entry of requested) {
          if (typeof entry !== "object" || entry === null) continue;
          const record = entry as Record<string, unknown>;
          const name = String(record.name ?? "");
          const element =
            name !== ""
              ? document.querySelector(`[${FILL_ATTRIBUTE}="${escapeAttrValue(name)}"]`)
              : null;
          if (!element) {
            refused.push({ name, why: "that field is not fillable" });
            continue;
          }
          // Checked from attributes only, before `.value` is touched: the
          // specification says these fields are never filled *or read*, and a
          // read is the part a reviewer cannot see not happening.
          const why = isRefusedField(element);
          if (why !== null || !isFillTarget(element)) {
            refused.push({ name, why: why ?? "that field is not fillable" });
            continue;
          }
          element.value = String(record.value ?? "");
          // Frameworks listen for these; setting `.value` alone leaves React
          // and friends showing the old value.
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
          filled.push(name);
        }
        // No submit, no click, no Enter: anything sent, bought or deleted
        // needs the visitor's own click, so the result tells the model to say
        // so rather than doing it.
        return { filled, refused, submitted: false };
      },
    },
  ];

  for (const action of builtins) {
    // A page's own action of the same name wins: the page is more specific
    // than a default, so the built-in is only registered if nothing claimed
    // the name. Re-registering on each config load keeps that true.
    const existing = lookup(action.name);
    if (existing !== undefined && existing !== installedBuiltins.get(action.name)) {
      continue;
    }
    register(action);
    const registered = lookup(action.name);
    if (registered) {
      installedBuiltins.set(action.name, registered);
    }
  }
  setBeforeList(refreshBuiltinSchemas);
}
