import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon.js";

export interface CopyButtonProps {
  /** Text put on the clipboard. */
  value: string;
  /** Button text; default "Copy". */
  label?: string;
  /** Accessible name when the visible label is not specific enough, e.g. "Copy ingest key". */
  ariaLabel?: string;
  className?: string;
  onCopied?: () => void;
}

type CopyState = "idle" | "copied" | "failed";

/** Copies `value` and says so for a moment ("Copied" or "Could not copy"). */
export function CopyButton({
  value,
  label = "Copy",
  ariaLabel,
  className = "btn btn-secondary btn-sm",
  onCopied,
}: CopyButtonProps) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    if (timer.current) clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
      onCopied?.();
    } catch {
      setState("failed");
    }
    timer.current = setTimeout(() => setState("idle"), 2500);
  }

  return (
    <span className="copy-button">
      <button
        type="button"
        className={className}
        aria-label={ariaLabel}
        onClick={() => void copy()}
      >
        <Icon name={state === "copied" ? "check" : "copy"} />
        <span>{label}</span>
      </button>
      <span
        className={state === "failed" ? "copy-feedback error-text" : "copy-feedback notice-text"}
        aria-live="polite"
      >
        {state === "copied"
          ? "Copied."
          : state === "failed"
            ? "Could not copy. Select the text and copy it yourself."
            : ""}
      </span>
    </span>
  );
}
