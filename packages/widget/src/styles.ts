import { SIDE_PANEL_WIDTH } from "./dock.js";

const light = ["#ffffff", "#f8fafc", "#e2e8f0", "#0f172a"] as const;
const dark = ["#0f172a", "#1e293b", "#334155", "#f8fafc"] as const;

export function dockColors(): typeof light | typeof dark {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches
    ? dark
    : light;
}

const css = `
:host {
  --solv-accent: #2563eb;
  --solv-bg: ${light[0]};
  --solv-surface: ${light[1]};
  --solv-border: ${light[2]};
  --solv-text: ${light[3]};
  --solv-muted: #475569;
  --solv-user-bg: var(--solv-accent);
  --solv-user-text: #ffffff;
  --solv-error: #dc2626;
  --solv-error-bg: #fef2f2;
  --solv-error-border: #fecaca;
  --solv-shadow: 0 12px 32px rgba(15, 23, 42, 0.16);

  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 2147483647;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: var(--solv-text);
}

:host([data-position="left"]) {
  right: auto;
  left: 20px;
}

@media (prefers-color-scheme: dark) {
  :host {
    --solv-bg: ${dark[0]};
    --solv-surface: ${dark[1]};
    --solv-border: ${dark[2]};
    --solv-text: ${dark[3]};
    --solv-muted: #94a3b8;
    --solv-error: #f87171;
    --solv-error-bg: #450a0a;
    --solv-error-border: #7f1d1d;
    --solv-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
  }
}

*, *::before, *::after {
  box-sizing: border-box;
}

button:focus-visible,
a:focus-visible,
textarea:focus-visible {
  outline: 2px solid var(--solv-accent);
  outline-offset: 2px;
}

.solv-wrap {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 12px;
}

:host([data-position="left"]) .solv-wrap {
  align-items: flex-start;
}

.solv-launcher {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  max-width: calc(100vw - 40px);
  padding: 6px 16px;
  border: none;
  border-radius: 9999px;
  background: var(--solv-accent);
  color: #ffffff;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  box-shadow: var(--solv-shadow);
}

.solv-launcher-label {
  min-width: 0;
  overflow-wrap: anywhere;
}

.solv-launcher svg[hidden],
.solv-launcher-label:empty {
  display: none;
}

.solv-shortcut {
  flex: none;
  padding: 1px 5px;
  border: 1px solid rgba(255, 255, 255, 0.55);
  border-radius: 4px;
  font: 500 11px/1.4 system-ui, sans-serif;
  white-space: nowrap;
}

@media (any-pointer: coarse) {
  .solv-shortcut { display: none; }
}

@media (any-pointer: fine) {
  .solv-shortcut:not([hidden]) { display: inline-block; }
}

.solv-launcher:hover {
  opacity: 0.94;
}

.solv-panel {
  display: flex;
  flex-direction: column;
  width: min(380px, calc(100vw - 32px));
  height: min(560px, calc(100vh - 96px));
  background: var(--solv-bg);
  color: var(--solv-text);
  border: 1px solid var(--solv-border);
  border-radius: 14px;
  box-shadow: var(--solv-shadow);
  overflow: hidden;
}

/* Desktop size, chosen for answers with a code block and a five-step list:
   460px wide fits about 44 characters of code per line (34 at 380px), and up
   to 720px tall shows a five-step list with a short code block whole. Never
   more than the viewport less the same margins as below; a screen narrower
   than 640px keeps the size above. */
@media (min-width: 640px) {
  .solv-panel {
    width: min(${SIDE_PANEL_WIDTH}, calc(100vw - 32px));
    height: min(720px, calc(100vh - 96px));
  }
}

.solv-panel[data-loading] {
  --solv-accent: var(--solv-muted);
}

.solv-panel[data-layout-pending] {
  width: min(320px, calc(100vw - 40px));
  height: auto;
}

.solv-panel[hidden] {
  display: none;
}

/* Expanded: a full-height column on the widget's side, beside the page
   (the page is narrowed by the same width), or the whole screen when the
   viewport is too narrow for both. */
:host([data-layout]) {
  top: 0;
  bottom: 0;
  right: 0;
}

:host([data-layout][data-position="left"]) {
  right: auto;
  left: 0;
}

:host([data-layout]) .solv-wrap {
  height: 100%;
}

:host([data-layout]) .solv-panel {
  width: ${SIDE_PANEL_WIDTH};
  height: 100vh;
  height: 100dvh;
  border-radius: 0;
  border-top: none;
  border-bottom: none;
  border-right: none;
  box-shadow: none;
}

:host([data-layout][data-position="left"]) .solv-panel {
  border-left: none;
  border-right: 1px solid var(--solv-border);
}

/* Both edges, so the left-widget rule (right: auto) cannot leave the host
   sized to its contents. */
:host([data-layout="full"]),
:host([data-layout="full"][data-position="left"]) {
  left: 0;
  right: 0;
}

/* The host spans the viewport less any scrollbar, which 100vw would not. */
:host([data-layout="full"]) .solv-wrap {
  width: 100%;
}

:host([data-layout="full"]) .solv-panel {
  width: 100%;
  border: none;
}

.solv-launcher[hidden],
.solv-expand[hidden],
.solv-collapse[hidden] {
  display: none;
}

@media (prefers-reduced-motion: no-preference) {
  .solv-panel,
  .solv-launcher {
    transition: opacity 160ms ease, transform 160ms ease;
  }

  :host([data-layout]) .solv-panel:not([data-opened-while-loading], [data-dock-restored]) {
    animation: solv-expand 180ms ease-out;
  }

  .solv-typing-dot {
    animation: solv-typing 1.2s ease-in-out infinite;
  }

  .solv-typing-dot:nth-child(2) {
    animation-delay: 0.15s;
  }

  .solv-typing-dot:nth-child(3) {
    animation-delay: 0.3s;
  }

  .solv-chip,
  .solv-fb-btn {
    transition: background-color 120ms ease, border-color 120ms ease, opacity 120ms ease;
  }
}

@media (prefers-reduced-motion: reduce) {
  .solv-panel,
  .solv-launcher,
  .solv-chip,
  .solv-send,
  .solv-fb-btn,
  .solv-confirm,
  .solv-typing-dot {
    transition: none;
    animation: none;
  }
}

@keyframes solv-expand {
  from {
    opacity: 0.6;
  }
  to {
    opacity: 1;
  }
}

@keyframes solv-typing {
  0%,
  80%,
  100% {
    opacity: 0.3;
    transform: translateY(0);
  }
  40% {
    opacity: 1;
    transform: translateY(-3px);
  }
}

/* The waiting answer: three dots, still when motion is reduced. */
.solv-typing {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 21px;
}

.solv-bubble-text:not(:empty) + .solv-typing,
.solv-bubble-text:not(:empty) ~ .solv-typing {
  margin-top: 6px;
}

.solv-typing-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--solv-muted);
  opacity: 0.6;
}

.solv-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--solv-border);
  background: var(--solv-surface);
}

.solv-header-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.solv-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.solv-close,
.solv-expand,
.solv-collapse {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--solv-muted);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}

.solv-new {
  min-height: 30px;
  padding: 4px 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--solv-muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.solv-new:hover,
.solv-close:hover,
.solv-expand:hover,
.solv-collapse:hover {
  background: var(--solv-border);
  color: var(--solv-text);
}

.solv-messages {
  flex: 1;
  overflow-y: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.solv-conversation-note {
  color: var(--solv-muted);
  font-size: 12px;
  text-align: center;
}

.solv-messages[hidden] {
  display: none;
}

.solv-bubble {
  max-width: 86%;
  min-width: 0;
  padding: 10px 12px;
  border-radius: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}

.solv-bubble--user {
  align-self: flex-end;
  background: var(--solv-user-bg);
  color: var(--solv-user-text);
  border-bottom-right-radius: 4px;
}

.solv-bubble--assistant {
  align-self: flex-start;
  background: var(--solv-surface);
  color: var(--solv-text);
  border: 1px solid var(--solv-border);
  border-bottom-left-radius: 4px;
}

.solv-bubble--assistant .solv-bubble-text {
  white-space: normal;
}

.solv-bubble-text p {
  margin: 0 0 8px;
}

.solv-bubble-text .solv-md-literal {
  white-space: pre-wrap;
}

.solv-bubble-text p:last-child {
  margin-bottom: 0;
}

.solv-bubble-text ul,
.solv-bubble-text ol {
  margin: 0 0 8px;
  padding-left: 20px;
}

.solv-bubble-text ul:last-child,
.solv-bubble-text ol:last-child {
  margin-bottom: 0;
}

.solv-bubble-text li {
  margin: 2px 0;
}

.solv-bubble-text li > ul,
.solv-bubble-text li > ol {
  margin: 4px 0 0;
}

.solv-bubble-text :not(pre) > code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.9em;
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--solv-border);
  white-space: pre-wrap;
}

.solv-md-link {
  color: var(--solv-accent);
  text-decoration: underline;
}

.solv-code-block {
  margin: 0 0 8px;
  border: 1px solid var(--solv-border);
  border-radius: 8px;
  background: var(--solv-bg);
  overflow: hidden;
  max-width: 100%;
}

.solv-code-block:last-child {
  margin-bottom: 0;
}

.solv-code-header {
  display: flex;
  justify-content: flex-end;
  padding: 4px 6px;
  border-bottom: 1px solid var(--solv-border);
  background: var(--solv-surface);
}

.solv-copy-btn {
  padding: 2px 8px;
  border: 1px solid var(--solv-border);
  border-radius: 6px;
  background: var(--solv-bg);
  color: var(--solv-muted);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.solv-copy-btn:hover {
  color: var(--solv-text);
  border-color: var(--solv-accent);
}

.solv-code-pre {
  margin: 0;
  padding: 8px 10px;
  overflow-x: auto;
  max-width: 100%;
  white-space: pre;
  word-break: normal;
  overflow-wrap: normal;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.45;
}

.solv-bubble-text:empty {
  display: none;
}

.solv-bubble--error {
  border-color: var(--solv-error-border);
}

.solv-bubble-error {
  margin-top: 6px;
  padding: 6px 8px;
  border-radius: 8px;
  background: var(--solv-error-bg);
  color: var(--solv-error);
  font-size: 12px;
}

.solv-bubble-text:empty + .solv-bubble-error {
  margin-top: 0;
}

.solv-citations {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.solv-citation {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 9999px;
  border: 1px solid var(--solv-border);
  background: var(--solv-bg);
  color: var(--solv-accent);
  font-size: 12px;
  text-decoration: none;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.solv-citation:hover {
  text-decoration: underline;
}

.solv-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.solv-nav-status {
  margin-top: 8px;
  font-size: 12px;
  color: var(--solv-muted);
}

.solv-nav-external {
  margin-top: 8px;
}

.solv-action {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 9999px;
  border: 1px solid var(--solv-border);
  background: var(--solv-bg);
  color: var(--solv-muted);
  font-size: 12px;
}

.solv-feedback {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}

.solv-fb-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px 8px;
  border: 1px solid var(--solv-border);
  border-radius: 6px;
  background: var(--solv-bg);
  color: var(--solv-muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.solv-fb-btn[aria-pressed="true"] {
  border-color: var(--solv-accent);
  color: var(--solv-accent);
  font-weight: 600;
}

.solv-fb-btn:disabled {
  cursor: default;
  opacity: 0.7;
}

.solv-fb-ack {
  font-size: 12px;
  color: var(--solv-muted);
}

.solv-suggestions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 14px 10px;
}

.solv-suggestions[hidden] {
  display: none;
}

.solv-chip {
  padding: 6px 10px;
  border: 1px solid var(--solv-border);
  border-radius: 9999px;
  background: var(--solv-surface);
  color: var(--solv-text);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}

.solv-chip:hover {
  border-color: var(--solv-accent);
}

.solv-input-error {
  padding: 6px 12px 0;
  border-top: 1px solid var(--solv-border);
  background: var(--solv-bg);
  color: var(--solv-error);
  font-size: 12px;
}

.solv-input-error[hidden] {
  display: none;
}

.solv-input[aria-invalid="true"] {
  border-color: var(--solv-error);
}

.solv-form {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid var(--solv-border);
  background: var(--solv-bg);
}

.solv-panel[data-loading] .solv-form {
  margin-top: auto;
}

.solv-input {
  flex: 1;
  min-height: 38px;
  max-height: 110px;
  padding: 8px 10px;
  border: 1px solid var(--solv-border);
  border-radius: 10px;
  background: var(--solv-surface);
  color: var(--solv-text);
  font: inherit;
  resize: none;
}

.solv-send {
  height: 38px;
  padding: 0 14px;
  border: none;
  border-radius: 10px;
  background: var(--solv-accent);
  color: #ffffff;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.solv-send:disabled {
  opacity: 0.55;
  cursor: default;
}

.solv-highlight-note {
  position: fixed;
  z-index: 2147483647;
  max-width: 260px;
  padding: 6px 10px;
  border: 1px solid var(--solv-border);
  border-radius: 8px;
  background: var(--solv-bg);
  color: var(--solv-text);
  font: inherit;
  font-size: 13px;
  line-height: 1.4;
  box-shadow: var(--solv-shadow);
  pointer-events: none;
}

.solv-confirm {
  align-self: flex-start;
  max-width: 86%;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--solv-surface);
  border: 1px solid var(--solv-accent);
}

.solv-confirm-title {
  font-weight: 600;
}

.solv-confirm-detail {
  margin: 6px 0 8px;
  padding-left: 1.1rem;
  font-size: 13px;
  /* Values come from the model and may be long; wrap rather than overflow. */
  word-break: break-word;
}

.solv-confirm-actions {
  display: flex;
  gap: 8px;
}

.solv-action-note {
  margin-top: 6px;
  font-size: 12px;
  color: var(--solv-muted);
}

/* The visitor check. Collapsed (no height) while Turnstile works unseen,
   so creating its frame moves nothing; opened only when Turnstile asks the
   visitor to act, or to say the check failed. */
.solv-check {
  flex: none;
  height: 0;
  overflow: hidden;
  padding: 0 14px;
}

.solv-check[data-state] {
  height: auto;
  padding: 8px 14px 0;
}

.solv-check-note {
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--solv-muted);
}

.solv-check:not([data-state="interactive"]) .solv-check-note {
  display: none;
}

.solv-check-frame {
  display: block;
  width: 100%;
  /* Turnstile's flexible size is 100% wide (at least 300px) and 65px high;
     the rest is room for its border, so the frame never scrolls. */
  height: 72px;
  border: 0;
  background: transparent;
}

.solv-check-failed {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  background: var(--solv-error-bg);
  color: var(--solv-error);
  font-size: 12px;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
`;

export const styles = new CSSStyleSheet();
styles.replaceSync(css);
