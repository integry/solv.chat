import type { RegisteredAction } from "./actions.js";

/**
 * How long a prompt waits. Long enough to read a list of fields and decide,
 * short enough that an abandoned tab does not leave the answer half-finished.
 * The specification sets no number; this one is ours.
 */
export const CONFIRM_TIMEOUT_MS = 60_000;

export interface ConfirmRequest {
  name: string;
  input: Record<string, unknown>;
}

export interface ConfirmHandle {
  /** Resolves true only on a deliberate Allow. */
  readonly answer: Promise<boolean>;
  /** Refuses and removes the prompt. Idempotent. */
  dismiss(): void;
}

/** One short sentence per built-in; a custom action uses its own description. */
function headline(request: ConfirmRequest, action: RegisteredAction): string {
  switch (request.name) {
    case "navigate":
      return "Open another page on this site?";
    case "highlight":
      return "Point at something on this page?";
    case "fill":
      return "Put these details into the form?";
    default:
      return action.description || `Run ${request.name}?`;
  }
}

/**
 * The detail lines. Everything here is set with textContent: the values come
 * from the model, and a chat panel is the last place that should render markup.
 */
function detailLines(request: ConfirmRequest): string[] {
  if (request.name === "navigate") {
    const section = typeof request.input.section === "string" ? request.input.section : "";
    return [String(request.input.url ?? ""), ...(section ? [`Section: ${section}`] : [])];
  }
  if (request.name === "highlight") {
    return [String(request.input.target ?? "")];
  }
  if (request.name === "fill") {
    const fields = Array.isArray(request.input.fields) ? request.input.fields : [];
    // Field and value, so the visitor sees exactly what will go into their
    // form before it does. This is the point of confirming a fill at all.
    return fields.map((entry) => {
      const record = (entry ?? {}) as Record<string, unknown>;
      return `${String(record.name ?? "")}: ${String(record.value ?? "")}`;
    });
  }
  try {
    return [JSON.stringify(request.input)];
  } catch {
    return [];
  }
}

/**
 * Renders a confirmation prompt into `container` and resolves when the visitor
 * answers. Every path that is not a deliberate Allow resolves false: Not now,
 * Escape, the timeout, and `dismiss()` (panel closed, widget removed). A
 * promise that could stay pending would hang the answer.
 */
export function askToConfirm(
  container: HTMLElement,
  request: ConfirmRequest,
  action: RegisteredAction,
  onFocusReturn: () => void,
): ConfirmHandle {
  const suffix = Math.random().toString(36).slice(2);
  const panel = document.createElement("div");
  panel.className = "solv-confirm";
  panel.setAttribute("role", "group");

  const title = document.createElement("div");
  title.className = "solv-confirm-title";
  title.id = `solv-confirm-title-${suffix}`;
  title.textContent = headline(request, action);
  panel.setAttribute("aria-labelledby", title.id);

  const detail = document.createElement("ul");
  detail.className = "solv-confirm-detail";
  detail.id = `solv-confirm-detail-${suffix}`;
  panel.setAttribute("aria-describedby", detail.id);
  for (const line of detailLines(request)) {
    const item = document.createElement("li");
    // textContent, never innerHTML: this string came from the model.
    item.textContent = line;
    detail.append(item);
  }

  const allow = document.createElement("button");
  allow.type = "button";
  allow.className = "solv-send";
  allow.textContent = "Allow";

  const deny = document.createElement("button");
  deny.type = "button";
  deny.className = "solv-fb-btn";
  deny.textContent = "Not now";

  const actions = document.createElement("div");
  actions.className = "solv-confirm-actions";
  actions.append(allow, deny);
  panel.append(title, detail, actions);

  let settle: ((accepted: boolean) => void) | null = null;
  const answer = new Promise<boolean>((resolve) => {
    settle = resolve;
  });

  const finish = (accepted: boolean) => {
    if (settle === null) return;
    const resolve = settle;
    settle = null;
    clearTimeout(timer);
    panel.removeEventListener("keydown", onKeyDown);
    panel.remove();
    // Focus goes back where the visitor was typing, as closing the dialog
    // already does in phase 1.
    onFocusReturn();
    resolve(accepted);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    // Escape is Not now without closing the outer chat dialog.
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    }
  };

  const timer = setTimeout(() => finish(false), CONFIRM_TIMEOUT_MS);
  allow.addEventListener("click", () => finish(true));
  deny.addEventListener("click", () => finish(false));
  panel.addEventListener("keydown", onKeyDown);

  container.append(panel);
  // Focus the refusing button, not Allow: a stray Enter should not accept
  // something on the visitor's behalf.
  deny.focus();

  return { answer, dismiss: () => finish(false) };
}
