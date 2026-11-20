import type { VisitorCheckMissing, VisitorCheckStatus } from "../api/types.js";

/** The Worker setting behind each missing piece, named as the owner sets it. */
export const MISSING_SETTING: Record<VisitorCheckMissing, string> = {
  site_key: "SOLV_TURNSTILE_SITE_KEY",
  secret: "SOLV_TURNSTILE_SECRET",
  secret_key: "SOLV_SECRET_KEY",
};

/**
 * The standing warning about visitor chat's security check, shown on every
 * screen until the check is set up. Nothing is shown when it runs, or when
 * the engine did not say (an older engine, or a host that leaves it out).
 */
export function VisitorCheckNotice({ status }: { status: VisitorCheckStatus | undefined }) {
  if (status === undefined || status.state === "on") return null;
  if (status.state === "misconfigured") {
    return (
      <div className="shell-check-alert" role="alert">
        <p className="check-error-banner">
          <strong>The chat is turning every visitor away.</strong> Its security check is only partly
          set up. Missing:{" "}
          {status.missing.map((name, i) => (
            <span key={name}>
              {i > 0 ? ", " : ""}
              <code>{MISSING_SETTING[name]}</code>
            </span>
          ))}
          .
        </p>
      </div>
    );
  }
  return (
    <div className="shell-check-alert" role="status">
      <p className="warning-banner">
        {status.state === "test_keys" ? (
          <>
            <strong>Visitor chat is not protected.</strong> The security check uses Turnstile's test
            keys, which let everyone through. Set your own keys in{" "}
            <code>SOLV_TURNSTILE_SITE_KEY</code> and <code>SOLV_TURNSTILE_SECRET</code>.
          </>
        ) : (
          <>
            <strong>Visitor chat is not protected.</strong> Scripts can send messages and use up
            today's spending limit. Turn on the security check by setting{" "}
            <code>SOLV_TURNSTILE_SITE_KEY</code> and <code>SOLV_TURNSTILE_SECRET</code>.
          </>
        )}
      </p>
    </div>
  );
}
