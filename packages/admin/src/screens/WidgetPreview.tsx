import { useEffect, useMemo, useRef, useState } from "react";

export interface WidgetPreviewConfig {
  widget: { title: string; accentColor: string; position: "left" | "right" };
  behaviour: { greeting: string; suggestedQuestions: string[] };
}

export interface WidgetPreviewProps {
  config: WidgetPreviewConfig;
  /** Where the widget script is served; default this origin's `/widget.js`. */
  widgetUrl?: string;
}

const READY = "solv-preview-ready";

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The page inside the frame. The frame is sandboxed without same-origin, and
 * its policy allows only the widget script and the small inline listener:
 * no `connect-src`, so the widget cannot make a request even if it tried.
 */
export function previewDocument(widgetUrl: string, nonce: string): string {
  const csp = [
    "default-src 'none'",
    `script-src ${widgetUrl} 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
  ].join("; ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>html,body{margin:0;height:100%;background:#e2e8f0;}</style>
</head>
<body>
<solv-chat></solv-chat>
<script src="${widgetUrl}"></script>
<script nonce="${nonce}">
var latest = null;
function show() {
  var el = document.querySelector("solv-chat");
  if (latest !== null && el && typeof el.preview === "function") el.preview(latest);
}
addEventListener("message", function (event) {
  if (event.source !== parent) return;
  latest = event.data;
  customElements.whenDefined("solv-chat").then(show);
});
parent.postMessage("${READY}", "*");
</script>
</body>
</html>`;
}

/**
 * The real widget package, showing the form's values as they change. It
 * runs in a sandboxed frame with no network access and no assistant key, so
 * typing in it sends nothing anywhere.
 */
export function WidgetPreview({ config, widgetUrl }: WidgetPreviewProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const src = useMemo(
    () => widgetUrl ?? new URL("/widget.js", window.location.href).href,
    [widgetUrl],
  );
  const srcDoc = useMemo(() => previewDocument(src, randomNonce()), [src]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== frameRef.current?.contentWindow || event.data !== READY) return;
      setReady(true);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const message = useMemo(() => JSON.stringify(config), [config]);
  useEffect(() => {
    if (!ready) return;
    // The frame has an opaque origin, so "*" is the only target that reaches it.
    // The values are the widget's public settings, which visitors see anyway.
    frameRef.current?.contentWindow?.postMessage(JSON.parse(message), "*");
  }, [ready, message]);

  return (
    <figure className="widget-preview">
      <iframe
        ref={frameRef}
        className="widget-preview-frame"
        title="Preview of the chat on your site"
        sandbox="allow-scripts"
        srcDoc={srcDoc}
      />
      <figcaption className="field-hint">
        Preview of your unsaved settings. Typing here sends nothing.
      </figcaption>
    </figure>
  );
}
