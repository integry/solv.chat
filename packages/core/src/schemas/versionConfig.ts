import { Errors, fail, ok, type Result } from "../result.js";
import { isPlainObject, readTrimmedString } from "./shared.js";

export type WidgetPosition = "left" | "right";

export interface BehaviourConfig {
  greeting: string;
  persona: string;
  fallbackText: string;
  suggestedQuestions: string[];
}

export interface WidgetConfig {
  title: string;
  accentColor: string;
  position: WidgetPosition;
}

export interface LimitsConfig {
  dailyCostCapMicros: number;
}

export interface VersionConfig {
  behaviour: BehaviourConfig;
  widget: WidgetConfig;
  limits: LimitsConfig;
  allowedTools: string[];
}

const MAX_SUGGESTED_QUESTIONS = 6;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** Returns a fresh default assistant version configuration. */
export const defaultVersionConfig = (): VersionConfig => ({
  behaviour: {
    greeting: "Hello. Ask me anything about this site.",
    persona: "",
    fallbackText: "I could not find an answer to that on this site.",
    suggestedQuestions: [],
  },
  widget: {
    title: "Ask a question",
    accentColor: "#2563eb",
    position: "right",
  },
  // 0 means no cap, so an owner who never sets one is not locked out.
  limits: { dailyCostCapMicros: 2_000_000 },
  // Phase 1 never reads this; it exists so the stored shape does not change
  // when phase 2 adds MCP tools.
  allowedTools: [],
});

function parseBehaviourSection(raw: unknown, target: BehaviourConfig, errors: Errors): void {
  if (!isPlainObject(raw)) {
    errors.add("behaviour", "must be an object");
    return;
  }
  if (raw.greeting !== undefined) {
    const greeting = readTrimmedString(raw.greeting, 1, 500);
    if (greeting === null) errors.add("behaviour.greeting", "must be 1 to 500 characters");
    else target.greeting = greeting;
  }
  if (raw.persona !== undefined) {
    const persona = readTrimmedString(raw.persona, 0, 4000);
    if (persona === null) errors.add("behaviour.persona", "must be at most 4000 characters");
    else target.persona = persona;
  }
  if (raw.fallbackText !== undefined) {
    const fallbackText = readTrimmedString(raw.fallbackText, 1, 500);
    if (fallbackText === null) errors.add("behaviour.fallbackText", "must be 1 to 500 characters");
    else target.fallbackText = fallbackText;
  }
  if (raw.suggestedQuestions !== undefined) {
    if (!Array.isArray(raw.suggestedQuestions)) {
      errors.add("behaviour.suggestedQuestions", "must be an array");
    } else {
      if (raw.suggestedQuestions.length > MAX_SUGGESTED_QUESTIONS) {
        errors.add(
          "behaviour.suggestedQuestions",
          `must have at most ${MAX_SUGGESTED_QUESTIONS} items`,
        );
      }
      const questions: string[] = [];
      raw.suggestedQuestions.slice(0, MAX_SUGGESTED_QUESTIONS).forEach((item, i) => {
        const q = readTrimmedString(item, 1, 200);
        if (q === null) {
          errors.add(`behaviour.suggestedQuestions[${i}]`, "must be 1 to 200 characters");
        } else {
          questions.push(q);
        }
      });
      target.suggestedQuestions = questions;
    }
  }
}

function parseWidgetSection(raw: unknown, target: WidgetConfig, errors: Errors): void {
  if (!isPlainObject(raw)) {
    errors.add("widget", "must be an object");
    return;
  }
  if (raw.title !== undefined) {
    const title = readTrimmedString(raw.title, 1, 80);
    if (title === null) errors.add("widget.title", "must be 1 to 80 characters");
    else target.title = title;
  }
  if (raw.accentColor !== undefined) {
    if (typeof raw.accentColor !== "string" || !HEX_COLOR_RE.test(raw.accentColor.trim())) {
      errors.add("widget.accentColor", "must be a hex color such as #2563eb");
    } else {
      target.accentColor = raw.accentColor.trim();
    }
  }
  if (raw.position !== undefined) {
    if (raw.position !== "left" && raw.position !== "right") {
      errors.add("widget.position", 'must be "left" or "right"');
    } else {
      target.position = raw.position;
    }
  }
}

function parseLimitsSection(raw: unknown, target: LimitsConfig, errors: Errors): void {
  if (!isPlainObject(raw)) {
    errors.add("limits", "must be an object");
    return;
  }
  if (raw.dailyCostCapMicros !== undefined) {
    if (
      typeof raw.dailyCostCapMicros !== "number" ||
      !Number.isInteger(raw.dailyCostCapMicros) ||
      raw.dailyCostCapMicros < 0
    ) {
      errors.add("limits.dailyCostCapMicros", "must be a non-negative integer");
    } else {
      target.dailyCostCapMicros = raw.dailyCostCapMicros;
    }
  }
}

function cloneVersionConfig(config: VersionConfig): VersionConfig {
  return {
    behaviour: {
      ...config.behaviour,
      suggestedQuestions: [...config.behaviour.suggestedQuestions],
    },
    widget: { ...config.widget },
    limits: { ...config.limits },
    allowedTools: [...config.allowedTools],
  };
}

/**
 * Parses a partial config over a base configuration (defaults when omitted).
 * Partial on purpose: the admin's Behaviour screen saves one section at a time,
 * and requiring the whole blob would make every screen responsible for fields
 * it does not show.
 */
export function parseVersionConfig(value: unknown, base?: VersionConfig): Result<VersionConfig> {
  if (!isPlainObject(value)) return fail("body: must be a JSON object");

  const config = base ? cloneVersionConfig(base) : defaultVersionConfig();
  const errors = new Errors();

  if (value.behaviour !== undefined)
    parseBehaviourSection(value.behaviour, config.behaviour, errors);
  if (value.widget !== undefined) parseWidgetSection(value.widget, config.widget, errors);
  if (value.limits !== undefined) parseLimitsSection(value.limits, config.limits, errors);

  if (value.allowedTools !== undefined) {
    if (!Array.isArray(value.allowedTools)) {
      errors.add("allowedTools", "must be an array");
    } else {
      const tools: string[] = [];
      value.allowedTools.forEach((raw, i) => {
        const tool = readTrimmedString(raw, 1, 200);
        if (tool === null) errors.add(`allowedTools[${i}]`, "must be 1 to 200 characters");
        else if (!tools.includes(tool)) tools.push(tool);
      });
      config.allowedTools = tools;
    }
  }

  if (errors.failed) return fail(...errors.list);
  return ok(config);
}
