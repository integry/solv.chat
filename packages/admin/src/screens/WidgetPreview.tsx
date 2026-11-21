import type { WidgetConfig } from "@solvchat/core";
import { useEffect, useMemo, useRef, useState } from "react";

export interface WidgetPreviewConfig {
  widget: WidgetConfig;
  behaviour: { greeting: string; suggestedQuestions: string[] };
}

export interface WidgetPreviewProps {
  config: WidgetPreviewConfig;
}

/**
 * The page inside the frame: static files in the admin build (`public/`, so
 * `dist/preview.html`, `preview.js` and `preview.css`), served next to the
 * other admin files. Loaded by URL, not `srcdoc`, because a `srcdoc` frame
 * inherits the admin's policy, which allows no inline script or style. The
 * page loads this origin's `/widget.js` and carries its own policy with no
 * `connect-src`.
 */
export const PREVIEW_PAGE = "/admin/preview.html";

const READY = "solv-preview-ready";

/**
 * The real widget package, showing the form's values as they change. It
 * runs in a sandboxed frame with no network access and no assistant key, so
 * typing in it sends nothing anywhere.
 */
export function WidgetPreview({ config }: WidgetPreviewProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [showPanel, setShowPanel] = useState(true);

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
    frameRef.current?.contentWindow?.postMessage({ ...JSON.parse(message), showPanel }, "*");
  }, [ready, message, showPanel]);

  return (
    <figure className="widget-preview">
      <div>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setShowPanel(!showPanel)}
        >
          {showPanel ? "Preview launcher" : "Preview open chat"}
        </button>
      </div>
      <iframe
        ref={frameRef}
        className="widget-preview-frame"
        title="Preview of the chat on your site"
        sandbox="allow-scripts"
        src={PREVIEW_PAGE}
      />
      <figcaption className="field-hint">
        Preview of your unsaved settings. Typing here sends nothing.
      </figcaption>
    </figure>
  );
}
