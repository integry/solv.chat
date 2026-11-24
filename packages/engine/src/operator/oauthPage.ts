import type { OperatorScope } from "../seams/types.js";

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[char] ?? char;
  });

type Page =
  | { kind: "error"; message: string }
  | { kind: "login"; query: URLSearchParams; error?: string | undefined }
  | {
      kind: "consent";
      query: URLSearchParams;
      name: string;
      scopes: OperatorScope[];
      callbackHost: string;
      localOnly: boolean;
    };

export function oauthPage(
  page: Page,
  status = 200,
  extraHeaders?: HeadersInit,
  callbackOrigin?: string,
): Response {
  const title =
    page.kind === "login"
      ? "Sign in to solv.chat"
      : page.kind === "consent"
        ? "Connect to solv.chat"
        : "Couldn’t connect";
  let content: string;
  if (page.kind === "error") {
    content = `<p>${escapeHtml(page.message)}</p>`;
  } else {
    const hidden = [...page.query]
      .map(
        ([name, value]) =>
          `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
      )
      .join("");
    if (page.kind === "login") {
      content = `<p>Use your admin password to review this connection.</p>
        ${page.error ? `<p role="alert" class="error">${escapeHtml(page.error)}</p>` : ""}
        <form method="post" action="/oauth/authorize">
          ${hidden}<label for="password">Admin password</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required>
          <button name="decision" value="sign-in">Sign in</button>
        </form>`;
    } else {
      content = `<p><strong>${escapeHtml(page.name)}</strong> is asking to manage this solv.chat instance.</p>
        <p class="callback">You’ll return to <strong>${escapeHtml(page.callbackHost)}</strong>.
          ${page.localOnly ? "Only continue if you started this connection on this device." : ""}</p>
        <form method="post" action="/oauth/authorize">${hidden}
          <fieldset><legend>Access to grant</legend>
            ${page.scopes
              .map(
                (scope, index) => `<label class="choice">
              <input type="radio" name="access" value="${scope}" ${index === 0 ? "checked" : ""}>
              <span><strong>${scope === "read" ? "Read only" : "Full access"}</strong>
              <small>${scope === "read" ? "View assistants, content, and activity." : "View and change settings, content, and access."}</small></span>
            </label>`,
              )
              .join("")}
          </fieldset>
          <div class="actions"><button class="secondary" name="decision" value="deny">Cancel</button>
          <button name="decision" value="allow">Allow access</button></div>
        </form>`;
    }
  }

  const headers = new Headers(extraHeaders);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  // Keep the browser's same-origin POST Origin so the consent CSRF check
  // works. The continuation sends no Referer across origins.
  headers.set("referrer-policy", "same-origin");
  headers.set(
    "content-security-policy",
    `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'${callbackOrigin ? ` ${callbackOrigin}` : ""}`,
  );
  headers.set("x-content-type-options", "nosniff");
  return new Response(
    `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root{color-scheme:light;--bg:#f5f6fa;--card:#fff;--text:#202236;--muted:#55596d;--line:#d6d9e6;--accent:#4c3fba;--button:#fff;--error:#a82037}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#151520;--card:#202132;--text:#f0f0fb;--muted:#bac0d8;--line:#464963;--accent:#b1a6ff;--button:#17132d;--error:#ff9bad}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,sans-serif}
main{width:min(100%,440px);background:var(--card);border:1px solid var(--line);border-radius:16px;padding:clamp(20px,5vw,36px);overflow-wrap:anywhere}
.callback{font-size:.875rem;margin-top:-10px}.brand{font-weight:750;color:var(--accent);margin:0 0 20px}h1{font-size:1.65rem;line-height:1.2;margin:0}p{color:var(--muted);margin:12px 0 22px}
form>label,legend{font-weight:650}input[type=password]{width:100%;padding:11px;margin:6px 0 18px;background:var(--card);color:var(--text);border:1px solid var(--line);border-radius:7px;font:inherit}
button{border:1px solid var(--accent);border-radius:7px;background:var(--accent);color:var(--button);font:650 1rem system-ui;padding:11px 15px;cursor:pointer}
button:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:3px}fieldset{margin:0;padding:0;border:0}legend{margin-bottom:5px}
.choice{display:flex;gap:10px;align-items:flex-start;margin:8px 0;padding:10px;border:1px solid var(--line);border-radius:8px;cursor:pointer}
.choice input{accent-color:var(--accent);margin-top:5px}small{display:block;color:var(--muted)}.actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:18px}
.secondary{background:var(--card);color:var(--text);border-color:var(--line)}.error{color:var(--error)}
</style>
<main><p class="brand">solv.chat</p><h1>${title}</h1>${content}</main></html>`,
    { status, headers },
  );
}
