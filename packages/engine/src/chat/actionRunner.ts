import type { PageAction } from "@solvchat/core";
import type { ToolDefinition } from "../providers/types.js";
import { PAUSE_FOR_CLIENT, type ToolRunner } from "./toolLoop.js";

/** The three the engine knows; everything else must come from the page. */
const BUILTIN_NAMES = new Set(["navigate", "highlight", "fill"]);

export interface ActionRunnerSettings {
  builtinsEnabled: boolean;
}

/**
 * Builds the runner for the page's actions, or null if there are none to
 * offer.
 *
 * The gate is here, server-side, even though the widget gates too: the request
 * body comes from the visitor's page, so a page could claim `navigate` whether
 * or not the owner enabled it. The widget's gate is a courtesy; this one is the
 * rule.
 */
export function actionRunnerFor(
  pageActions: readonly PageAction[] | undefined,
  settings: ActionRunnerSettings,
): ToolRunner | null {
  if (!pageActions || pageActions.length === 0) return null;
  const offered = pageActions.filter(
    (action) => !BUILTIN_NAMES.has(action.name) || settings.builtinsEnabled,
  );
  if (offered.length === 0) return null;

  const definitions: ToolDefinition[] = offered.map((action) => ({
    name: action.name,
    description: action.description,
    inputSchema: action.inputSchema,
  }));

  return {
    kind: "action",
    definitions,
    async run() {
      // A page action runs in the visitor's browser, not here. The loop reads
      // this and stops, so the caller can emit `action` events and wait for a
      // follow-up request carrying the results.
      return PAUSE_FOR_CLIENT;
    },
  };
}
