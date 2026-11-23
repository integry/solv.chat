import { useState } from "react";
import { ApiError, postJson } from "../api/client.js";
import type { InstallInfo } from "../api/types.js";
import { useResource } from "../api/useResource.js";
import { ScreenLink } from "../routing.js";
import { CopyButton } from "../ui/CopyButton.js";
import { RelativeTime } from "../ui/DateText.js";
import { ConfirmDialog } from "../ui/Dialog.js";
import { ErrorState } from "../ui/ErrorState.js";
import { PageHeader } from "../ui/PageHeader.js";
import { Skeleton } from "../ui/Skeleton.js";
import { StatusBadge } from "../ui/StatusBadge.js";
import { useToast } from "../ui/Toast.js";
import { cliPushCommand } from "./cliCommand.js";
import { ORIGINS_LABEL } from "./Widget.js";

export interface InstallProps {
  assistantId: string;
}

const DESCRIPTION = "Add the chat to your website in three steps.";

/** The script URL and public key inside the snippet, for the framework notes. */
function snippetParts(snippet: string): { src: string; publicKey: string } {
  const src = /src="([^"]+)"/.exec(snippet)?.[1] ?? "/widget.js";
  const publicKey = /assistant="([^"]+)"/.exec(snippet)?.[1] ?? "";
  return { src, publicKey };
}

/**
 * Where the widget was seen, as host and path. The URL comes from a
 * visitor's browser, so it is shown as text and never as a link.
 */
function describePage(pageUrl: string): string {
  try {
    const url = new URL(pageUrl);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return pageUrl;
  }
}

function PlatformNotes({ snippet }: { snippet: string }) {
  const { src, publicKey } = snippetParts(snippet);
  // Next.js: `next/script` in the root layout; afterInteractive is the default strategy.
  // Source: https://nextjs.org/docs/app/api-reference/components/script — checked 2026-11-17
  const nextCode = `import Script from "next/script";

// app/layout.tsx, outside the routed content:
<Script src="${src}" />
<solv-chat assistant="${publicKey}"></solv-chat>`;
  return (
    <div className="platform-notes">
      <details className="disclosure">
        <summary>Plain HTML</summary>
        <p>
          Add the scripts to <code>&lt;head&gt;</code>, after your stylesheets. Add the{" "}
          <code>&lt;solv-chat&gt;</code> tag to <code>&lt;body&gt;</code>. Use the same setup on
          every page that shows the chat.
        </p>
      </details>
      <details className="disclosure">
        <summary>WordPress</summary>
        <p>
          Use a plugin that adds code to the head and footer. Put the scripts in the head and the{" "}
          <code>&lt;solv-chat&gt;</code> tag in the footer.
        </p>
      </details>
      <details className="disclosure">
        <summary>Shopify</summary>
        {/* The default layout is layout/theme.liquid.
            Source: https://shopify.dev/docs/storefronts/themes/architecture/layouts — checked 2026-11-17 */}
        <p>
          In your Shopify admin, open Online Store, then Themes, and choose Edit code. Open{" "}
          <code>layout/theme.liquid</code> and add the scripts to <code>&lt;head&gt;</code> and the
          chat tag to <code>&lt;body&gt;</code>. List your store's address in step 1, and your
          myshopify.com address too if visitors use it.
        </p>
      </details>
      <details className="disclosure">
        <summary>Next.js</summary>
        <p>
          Load the script with <code>next/script</code> in your root layout and add the tag next to
          it. If TypeScript says <code>solv-chat</code> is not a known element, declare it in a{" "}
          <code>.d.ts</code> file.
        </p>
        <pre className="code-block">
          <code>{nextCode}</code>
        </pre>
      </details>
    </div>
  );
}

/**
 * What a host site's Content-Security-Policy must allow, and, when the
 * security check runs, what an owner should tell visitors about it.
 * What Turnstile processes is from Cloudflare's Turnstile Privacy Addendum
 * (https://www.cloudflare.com/turnstile-privacy-policy/ — checked 2026-11-20):
 * "client IP address, TLS Fingerprint, User-Agent Header and Sitekey and
 * associated origin"; the overview page says it does not read page inputs
 * (https://developers.cloudflare.com/turnstile/ — checked 2026-11-20).
 */
function SitePolicyNotes({ info }: { info: InstallInfo }) {
  const policy = info.hostPolicy ?? [];
  const checkRuns = info.visitorCheck?.state === "on" || info.visitorCheck?.state === "test_keys";
  return (
    <div className="stack install-policy">
      {policy.length > 0 && (
        <section aria-labelledby="install-csp-heading">
          <h3 id="install-csp-heading" className="section-heading">
            If your site sets a Content-Security-Policy
          </h3>
          <p className="muted">
            Add these values to your policy. The hash allows the inline script in the snippet.
          </p>
          <ul className="policy-list" aria-label="Content-Security-Policy additions">
            {policy.map((entry) => (
              <li key={entry.directive}>
                <code>
                  {entry.directive} {entry.value}
                </code>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-labelledby="install-storage-heading">
        <h3 id="install-storage-heading" className="section-heading">
          Tell visitors what the chat remembers
        </h3>
        <p className="muted">
          You can use this in your privacy notice. Our chat stores a random visitor ID and your
          recent messages in your browser so you can continue across tabs and visits. The
          conversation is forgotten after 7 days without a message or reply, and you can clear it
          sooner by choosing New conversation.
        </p>
      </section>
      {checkRuns && (
        <section aria-labelledby="install-privacy-heading">
          <h3 id="install-privacy-heading" className="section-heading">
            Tell visitors about the security check
          </h3>
          <p className="muted">
            When a visitor starts typing, the chat runs a short check from Cloudflare Turnstile to
            keep scripts out. It runs in a frame from this chat's address. Turnstile receives the
            visitor's IP address, details of their browser and connection (its TLS fingerprint and
            user agent) and this chat's address. It does not see what the visitor types. Mention
            Cloudflare Turnstile in your privacy notice and link to{" "}
            <a
              href="https://www.cloudflare.com/turnstile-privacy-policy/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Cloudflare's Turnstile privacy addendum
            </a>
            .
          </p>
        </section>
      )}
    </div>
  );
}

function ForDevelopers({ assistantId }: { assistantId: string }) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [rotatedKey, setRotatedKey] = useState<string | null>(null);

  async function handleRotateKey() {
    if (rotating) return;
    setRotating(true);
    setRotateError(null);
    try {
      const res = await postJson<{ ingestKey: string }>(
        `/api/admin/assistants/${assistantId}/ingest-key`,
        {},
      );
      setRotatedKey(res.ingestKey);
      setConfirming(false);
      toast.success("New ingest key created. The old one has stopped working.");
    } catch (err) {
      setRotateError(err instanceof ApiError ? err.message : "Could not rotate ingest key.");
    } finally {
      setRotating(false);
    }
  }

  return (
    <details className="disclosure developer-details">
      <summary>For developers</summary>
      <div className="stack">
        <p className="muted">
          Push content from your build and apply settings from a file with the <code>solv</code>{" "}
          command. It authenticates with the ingest key, kept as the secret{" "}
          <code>SOLV_INGEST_KEY</code>.
        </p>
        <div className="field">
          <label htmlFor="install-assistant-id">Assistant ID</label>
          <div className="input-with-button">
            <input id="install-assistant-id" type="text" readOnly value={assistantId} />
            <CopyButton value={assistantId} ariaLabel="Copy assistant ID" />
          </div>
        </div>
        <div className="field">
          <span className="field-label">Push your pages</span>
          <pre className="code-block">
            <code>{cliPushCommand(assistantId)}</code>
          </pre>
          <CopyButton value={cliPushCommand(assistantId)} label="Copy command" />
        </div>

        <section className="stack" aria-labelledby="ingest-key-heading">
          <h3 id="ingest-key-heading" className="section-heading">
            Ingest key
          </h3>
          <p className="muted">
            Used by <code>solv push</code> and <code>solv apply</code>. It is shown once, when
            created or rotated. Anyone holding it can change this assistant's content and draft, so
            keep it secret.
          </p>
          {rotatedKey && (
            <div className="stack">
              <p className="warning-banner">
                Copy this key now. The previous key stopped working immediately.
              </p>
              <div className="field">
                <label htmlFor="rotated-ingest-key">New ingest key</label>
                <div className="input-with-button">
                  <input id="rotated-ingest-key" type="text" readOnly value={rotatedKey} />
                  <CopyButton value={rotatedKey} label="Copy key" ariaLabel="Copy ingest key" />
                </div>
              </div>
            </div>
          )}
          <div className="actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={rotating}
              onClick={() => {
                setRotateError(null);
                setConfirming(true);
              }}
            >
              Rotate ingest key
            </button>
          </div>
        </section>
      </div>
      <ConfirmDialog
        open={confirming}
        title="Rotate the ingest key?"
        description="The current key stops working straight away. Builds and scripts using it fail until you give them the new key."
        confirmLabel="Rotate key"
        busyLabel="Rotating…"
        tone="danger"
        busy={rotating}
        error={rotateError}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void handleRotateKey()}
      />
    </details>
  );
}

export function Install({ assistantId }: InstallProps) {
  const installRes = useResource<InstallInfo>(`/api/admin/assistants/${assistantId}/install`);
  const info = installRes.value;

  if (installRes.status === "loading" && !info) {
    return (
      <div className="screen">
        <PageHeader title="Install" description={DESCRIPTION} />
        <Skeleton label="Loading install snippet…" lines={5} />
      </div>
    );
  }
  if (installRes.status === "error" || !info) {
    return (
      <div className="screen">
        <PageHeader title="Install" description={DESCRIPTION} />
        <ErrorState
          title="Could not load the install details."
          detail={installRes.error}
          onRetry={installRes.reload}
        />
      </div>
    );
  }

  const lastSeen = info.lastSeen ?? null;

  return (
    <div className="screen">
      <PageHeader title="Install" description={DESCRIPTION} />

      <ol className="install-steps">
        <li className="install-step source-card">
          <h2 className="section-heading">Check the websites that may show the chat</h2>
          <p className="muted">
            The chat only answers on the websites listed here, so include each address visitors use.
          </p>
          {info.allowedOrigins.length === 0 ? (
            // A plain warning, not a validation error: the owner has not done
            // anything wrong yet, but with no origins listed the widget refuses
            // every request, and that is invisible from the site itself.
            <p className="warning-banner" role="status">
              Add your website address on the Widget screen first. Until you do, the chat will not
              answer anyone.
            </p>
          ) : (
            <ul className="origin-list" aria-label={ORIGINS_LABEL}>
              {info.allowedOrigins.map((origin) => (
                <li key={origin}>{origin}</li>
              ))}
            </ul>
          )}
          <p>
            <ScreenLink to="widget">Change this list on the Widget screen</ScreenLink>
          </p>
        </li>

        <li className="install-step source-card">
          <h2 className="section-heading">Copy the snippet</h2>
          <label htmlFor="install-snippet" className="muted">
            Paste this into your site, once per page that should show the chat.
          </label>
          <textarea
            id="install-snippet"
            className="snippet-box"
            rows={3}
            readOnly
            value={info.snippet}
          />
          <div className="actions">
            <CopyButton
              value={info.snippet}
              label="Copy snippet"
              className="btn btn-primary btn-sm"
            />
          </div>
          <PlatformNotes snippet={info.snippet} />
          <SitePolicyNotes info={info} />
        </li>

        <li className="install-step source-card">
          <h2 className="section-heading">Check it works</h2>
          {lastSeen ? (
            <p className="install-seen">
              <StatusBadge tone="success">Working</StatusBadge>
              <span>
                We have seen the widget load on <strong>{describePage(lastSeen.pageUrl)}</strong>,{" "}
                <RelativeTime value={lastSeen.at} />.
              </span>
            </p>
          ) : (
            <p className="install-seen">
              <StatusBadge tone="neutral">Not seen yet</StatusBadge>
              <span className="muted">
                Open a page with the snippet and send the chat a message. It shows here once a
                visitor writes from your site.
              </span>
            </p>
          )}
        </li>
      </ol>

      <ForDevelopers assistantId={assistantId} />
    </div>
  );
}
