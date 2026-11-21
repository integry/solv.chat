// Imported before element.ts so globalThis.solv.actions is installed before
// <solv-chat> is defined, regardless of script load order.
import "./actions.js";
import "./element.js";

export type { WidgetSendOptions, WidgetSendResult } from "./element.js";
