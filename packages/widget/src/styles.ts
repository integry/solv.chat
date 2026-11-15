const css = `
:host {
  --solv-accent: #2563eb;
  --solv-bg: #ffffff;
  --solv-surface: #f8fafc;
  --solv-border: #e2e8f0;
  --solv-text: #0f172a;
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
    --solv-bg: #0f172a;
    --solv-surface: #1e293b;
    --solv-border: #334155;
    --solv-text: #f8fafc;
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
  height: 44px;
  padding: 0 16px;
  border: none;
  border-radius: 9999px;
  background: var(--solv-accent);
  color: #ffffff;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  box-shadow: var(--solv-shadow);
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

.solv-panel[hidden] {
  display: none;
}

@media (prefers-reduced-motion: no-preference) {
  .solv-panel,
  .solv-launcher {
    transition: opacity 160ms ease, transform 160ms ease;
  }

  .solv-chip,
  .solv-send,
  .solv-fb-btn {
    transition: background-color 120ms ease, border-color 120ms ease, opacity 120ms ease;
  }
}

@media (prefers-reduced-motion: reduce) {
  .solv-panel,
  .solv-launcher,
  .solv-chip,
  .solv-send,
  .solv-fb-btn {
    transition: none;
    animation: none;
  }
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

.solv-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.solv-close {
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

.solv-close:hover {
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

.solv-bubble {
  max-width: 86%;
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

.solv-nav-recovery {
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
