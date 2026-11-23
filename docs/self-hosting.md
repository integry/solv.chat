# Self-hosting solv.chat

You need a Cloudflare account, Node 24, and keys for the providers you configure: by default, an Anthropic key for answers and an OpenAI key for embeddings (or a single OpenRouter key when both `SOLV_LLM_PROVIDER` and `SOLV_EMBEDDINGS_PROVIDER` are set to `"openrouter"`).

## 1. Clone, create Cloudflare resources, and migrate

```sh
git clone https://github.com/integry/solv.chat && cd solv.chat
npm ci
npx wrangler login

# Create the resources. Copy the database_id from `d1 create` into packages/engine/wrangler.jsonc.
npx wrangler d1 create solvchat
npx wrangler vectorize create solvchat-chunks --dimensions 1536 --metric cosine
npx wrangler vectorize create-metadata-index solvchat-chunks --property-name=org_id --type=string
npx wrangler vectorize create-metadata-index solvchat-chunks --property-name=assistant_id --type=string
npx wrangler r2 bucket create solvchat-docs
npx wrangler queues create solvchat-ingest
npx wrangler queues create solvchat-ingest-dlq

npm run migrations:apply -w @solvchat/engine
```

The metadata indexes (`org_id` and `assistant_id`) must exist before the first `solv push`; any content pushed earlier has to be pushed again after creating them.

## 2. Set secrets

Two secrets are required for the admin and encrypted storage, plus keys for the providers you use. Provider keys and provider/model choices can also be entered in `/admin` under **Settings → Providers** instead of setting provider secrets and `vars` (stored settings and keys take precedence over environment variables and secrets; `SOLV_SECRET_KEY` is required to store keys in the admin).

Run `npx wrangler secret put <name>` inside `packages/engine` for each secret you set via Worker secrets:

| Secret                  | What it is                                                                                   | Where it comes from                                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `SOLV_ADMIN_PASSWORD`   | The one password that signs you in to `/admin`.                                              | You choose it (or generate one with `openssl rand -base64 24`).                                                   |
| `SOLV_SECRET_KEY`       | Signs session cookies and encrypts stored MCP server credentials and provider API keys.      | `openssl rand -base64 32`. Changing it signs you out everywhere and makes stored credentials and keys unreadable. |
| `SOLV_ANTHROPIC_KEY`    | Your Anthropic key, if the instance uses Anthropic (or enter in **Settings → Providers**).   | console.anthropic.com                                                                                             |
| `SOLV_OPENAI_KEY`       | Your OpenAI key. Needed for embeddings by default (or enter in **Settings → Providers**).    | platform.openai.com                                                                                               |
| `SOLV_OPENROUTER_KEY`   | Your OpenRouter key, if `SOLV_LLM_PROVIDER` or `SOLV_EMBEDDINGS_PROVIDER` is `"openrouter"`. | openrouter.ai                                                                                                     |
| `SOLV_TURNSTILE_SECRET` | The secret key of your Turnstile widget, for the visitor security check (below).             | Cloudflare dashboard → Turnstile. Never sent to a browser or logged.                                              |

### Provider settings in the admin and OpenRouter

You can configure the answering provider (`anthropic`, `openai`, or `openrouter`), tier or OpenRouter model ID, embeddings provider (`openai` or `openrouter`), and API keys in `/admin` under **Settings → Providers** (and test the effective key from that screen):

- **Precedence**: stored settings beat `vars` in `wrangler.jsonc`, which beat built-in defaults; stored keys beat Worker secrets. Removing a stored value falls back to the environment variable or default.
- **Encrypted keys**: keys entered in **Settings → Providers** are encrypted with `SOLV_SECRET_KEY`, write-only, and never returned by any API. `SOLV_SECRET_KEY` must be set before storing a key in the admin. If a stored key cannot be decrypted (for example after rotating `SOLV_SECRET_KEY`), answering fails rather than silently falling back to a Worker secret.

By default, `packages/engine/wrangler.jsonc` sets `SOLV_LLM_PROVIDER` to `"anthropic"` and `SOLV_LLM_TIER` to `"fast"`. To answer with OpenAI or switch tiers (`"fast"` or `"balanced"`), edit those two values under `vars` in `packages/engine/wrangler.jsonc` (or choose them in **Settings → Providers**). Built-in model IDs, prices and token limits are listed in `packages/engine/src/models.ts`.

To answer with any model on OpenRouter instead, set `SOLV_LLM_PROVIDER` to `"openrouter"` and `SOLV_LLM_MODEL` to the OpenRouter model slug (`SOLV_LLM_TIER` is ignored). You can also set `SOLV_EMBEDDINGS_PROVIDER` to `"openrouter"` to embed with `openai/text-embedding-3-small` (1536 dimensions) using `SOLV_OPENROUTER_KEY` so no OpenAI key is needed:

```jsonc
"vars": {
  "SOLV_LLM_PROVIDER": "openrouter",
  "SOLV_LLM_MODEL": "anthropic/claude-sonnet-4",
  "SOLV_EMBEDDINGS_PROVIDER": "openrouter"
}
```

For OpenRouter, the daily spend cap is counted in OpenRouter credits (if OpenRouter omits cost on a response, cost is stored as unknown and the spend cap cannot protect the instance). Tool calling and page actions depend on whether the chosen OpenRouter model supports tools.

### Retrieval score floor (optional)

Content is only given to the model when its similarity to the question is at least the score floor, `0.2` by default. Lower it if questions your content answers get "nothing found"; raise it if replies lean on unrelated pages. Set `SOLV_SCORE_FLOOR` under `vars` in `packages/engine/wrangler.jsonc` to a number from `0` to `0.9`:

```jsonc
"vars": {
  "SOLV_SCORE_FLOOR": "0.25"
}
```

Any other value (not a number, or out of range) is ignored with a warning in the Worker logs, and the default is used. Each answer's trace shows the floor it used and every candidate's score, which is the way to pick a value. There is no admin setting for it.

### Visitor security check (Cloudflare Turnstile)

Without it, anything that can send an HTTP request can talk to your assistant: the `Origin` header is checked, but a script can set it, and the per-IP rate limit is beaten by changing addresses, so a script can use up the assistant's daily spend cap and leave real visitors with "reached its limit for today". The security check makes every visitor's browser pass [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) before the chat answers, and adds per-visitor caps behind it. Until it is set up, the admin shows a warning on every screen.

1. In the Cloudflare dashboard, open **Turnstile** and select **Add widget** ([guide](https://developers.cloudflare.com/turnstile/get-started/widget-management/dashboard/)). Choose **Managed** mode and, under **Hostname management**, add the hostname of **this Worker** (for example `solvchat-engine.example.workers.dev` or `chat.example.com`), not the hostnames of the sites the widget is embedded on. The challenge runs in a frame served by the Worker, so one hostname covers every site and assistant on the instance.
2. Put the site key under `vars` in `packages/engine/wrangler.jsonc` (it is public) and the secret key in a Worker secret:

   ```jsonc
   "vars": {
     "SOLV_TURNSTILE_SITE_KEY": "0x4AAAAAAA..."
   }
   ```

   ```sh
   npx wrangler secret put SOLV_TURNSTILE_SECRET
   ```

   `SOLV_SECRET_KEY` must be set too: visitor sessions are signed with a key derived from it.
3. Deploy. With both keys set, the widget runs the check when a visitor first focuses or types in the message box, and the engine refuses chat and feedback requests without a valid session. With only one of the two set, the public chat refuses every request and the admin says which setting is missing. With neither, the chat runs without the check, as before.

For a local or test instance you can use Turnstile's [test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/) (site key `1x00000000000000000000AA` with secret `1x0000000000000000000000000000000AA` always passes). They let everyone through, so the admin keeps warning while they are in use.

**Your site's security policy.** Nothing from Turnstile loads on your pages. If your site sends a `Content-Security-Policy`, the widget needs the Worker's origin, and only it, in `script-src` (the widget script), `connect-src` (its requests) and, with the check on, `frame-src` (the check's frame). The Install screen lists the exact lines.

**Your privacy notice.** Turnstile processes the visitor's IP address, their browser's TLS fingerprint and user agent, and the site key and the origin it runs on ([Turnstile Privacy Addendum](https://www.cloudflare.com/turnstile-privacy-policy/)); it does not read what visitors type. Mention Cloudflare Turnstile in your privacy notice. The engine stores no Turnstile token, session or IP with conversations.

**Caps behind the check.** Turnstile stops scripts, not a person or a browser someone drives. These caps apply to visitor chat when the check is on (owner previews and test runs are not counted), each a whole number under `vars`, `0` to turn it off:

| Variable                      | Default | What it limits                                                         |
| ----------------------------- | ------- | ---------------------------------------------------------------------- |
| `SOLV_VISITOR_DAILY_MESSAGES` | 100     | Questions from one visitor to one assistant per UTC day.               |
| `SOLV_IP_DAILY_MESSAGES`      | 500     | Questions from one IP address to one assistant per UTC day.            |
| `SOLV_CONVERSATION_MESSAGES`  | 50      | Questions in one conversation; the next one starts a new conversation. |
| `SOLV_IP_HOURLY_SESSIONS`     | 30      | Security checks passed from one IP address per hour, per assistant.    |

They sit behind the per-IP rate limit and the daily spend cap, which are unchanged.

## 3. Build and deploy

From the repository root:

```sh
npm run build
cd packages/engine && npx wrangler deploy
```

## 4. First run

1. Open `https://<your-worker>/admin` and sign in with `SOLV_ADMIN_PASSWORD`.
2. Click **New assistant**, enter a name and your website's origin (for example `https://example.com`), and create it.
3. Copy the assistant ID (`ast_…`) and the ingest key — the ingest key is shown once.
4. From the repository root, push your Markdown content:

```sh
SOLV_INGEST_KEY=<the key> npx solv push ./content \
  --endpoint https://<your-worker> --assistant ast_… --base-url https://example.com
```

`solv push` sends 10 documents per request so each request fits the Workers Free limit of 50 subrequests (calls to R2 and D1 count; see [Cloudflare's limits page](https://developers.cloudflare.com/workers/platform/limits/)). If you call the ingest API yourself, keep batches that small on Free; batches up to the API's cap of 100 need the Paid plan.

`solv push` reads `.md`, `.markdown` and `.mdx` files. A few options shape what it sends:

- `--include <glob>` and `--exclude <glob>` choose files, relative to the folder. Both can be given more than once. `*` matches within one folder, `**` across folders, and `{md,mdx}` either. For example, `--exclude "drafts/**"` leaves out a drafts folder.
- `--file <path>=<url>` also pushes one file from outside the folder, with its own URL, for example `--file README.md=https://example.com/ --file CHANGELOG.md=https://example.com/changelog`. With only `--file`, no folder or `--base-url` is needed.
- `--source <name>` names the content. Use it when more than one repository pushes into the same assistant: each name is its own source under **Sources**, and `--prune` then deletes only documents pushed under the same name. Without `--source`, everything goes to the assistant's one default source, as before. Use the same name on every push: a renamed source starts empty, and the old one keeps its documents.

If the folder is a Docusaurus docs folder, `solv push` finds that from the files themselves: an `.mdx` file, a Docusaurus front matter key such as `sidebar_position` or `sidebar_label`, an admonition (`:::note`), or an import from `@theme/`, `@site/` or `@docusaurus/`. Then, for every file in the folder:

- URLs follow Docusaurus: `slug` and `id` front matter are honoured, number prefixes (`01-intro.md`, `02-guides/`) are dropped, and `index.md`, `README.md` or a file named like its folder gives the folder's URL. Point `--base-url` at your docs root, for example `https://example.com/docs`.
- The title is the front matter `title`, else `sidebar_label`, else the first heading. The front matter `description` is put at the top of the document.
- Admonitions (`note`, `tip`, `info`, `warning`, `danger`, `caution`, `important`, `success`, `secondary`) become plain labelled paragraphs (`**Tip:** …`, or the admonition's own title), `import`/`export` lines are dropped, and components such as `<Tabs>` are replaced by the text inside them (or dropped when there is none). Only a tag that closes itself or has a matching closing tag is a component, so placeholders such as `<YOUR_TOKEN>` stay. Code blocks are kept exactly.
- Files and folders whose name starts with `_` (partials) and pages with `draft: true` or `unlisted: true` in their front matter are left out: Docusaurus gives them no public page. Push one anyway with `--file`.

Other folders are pushed as they always were. Run with `--dry-run` to see each document's URL before pushing.

5. In `/admin`, open **Behaviour** (or **Widget**) and click **Publish** so the assistant goes live (Publish promotes your draft — behaviour, widget settings, and any enabled tools — to visitors).
6. Open **Install**, add the scripts and the chat tag to your site, and ask a question.

### The chat on your page

#### Keep an open side panel in place between pages

For a site that loads a new document on navigation, put the following inline
script in `<head>` on every page that shows the assistant, after the viewport
meta tag and the stylesheets that size your page. Replace `pk_...` with the
same public key as the `assistant` attribute on your `<solv-chat>` tag. Keep
that tag in `<body>`.

```html
<script data-key="pk_...">(()=>{var y="--solv-chat-panel-width";var u=o=>`solv-dock:1:${o}`;function x(o,i,t){let l=o.style,e=getComputedStyle(o),n=e.maxWidth,r=`margin-${i}`,d=l.getPropertyValue(r),s=(p,h)=>l.setProperty(p,h,"important");s(r,t),d&&s(r,`calc(${d} + ${t})`),l.setProperty(y,t);let c=p=>parseFloat(p)||0,a=o.getBoundingClientRect().width,m=`calc(100% - ${(a&&a-c(e.width))+c(e.marginLeft)+c(e.marginRight)}px)`;s("max-width",n&&n!=="none"?`min(${n}, ${m})`:m)}function f(o,i,t=document.documentElement,l){if(t.getAttribute("style")!==l){let e=t.style,n=document.createElement("div").style;n.cssText=i??"";for(let r of[`margin-${o}`,"max-width",y])e.setProperty(r,n.getPropertyValue(r),n.getPropertyPriority(r));if(t.getAttribute("style"),e.cssText!==n.cssText)return}i===null?t.removeAttribute("style"):t.setAttribute("style",i)}try{let o=document,i=u(o.currentScript.dataset.key),t=sessionStorage[i];if(t&&innerWidth>=900){let l;try{l=opener.sessionStorage[i]}catch{}let[e,n,r,d]=JSON.parse(t);if(t!==l&&(e==="left"||e==="right")&&n==="460px"&&typeof d=="string"&&r.match(/^position:fixed;[#a-z0-9:;, -]+$/)){let s=o.createElement("div");s.id=i,s.inert=!0,s.style.cssText=r,s.textContent=d;let c=o.documentElement,a=c.getAttribute("style");s.rootStyle=a,x(c,e,n);let g=c.getAttribute("style");setTimeout(()=>{s.isConnected&&(s.remove(),f(e,a,c,g))},3e3),c.append(s)}}}catch{}})();</script>
```

The engine serves the exact script body at `/boot.js`. The widget package
publishes it as `@solvchat/widget/boot.js`. Copy the body inline so it can
run while the head is parsed. For Content-Security-Policy, add
`'sha256-wKNxb9ISGk0wGMPONDaS6EQcivqaehUe6YFzRCFv+KI='` to `script-src` alongside
the engine's origin. Keep the script body byte for byte, including whitespace.
Changing the `data-key` attribute leaves the hash unchanged.

On the next page in the same tab, the script makes room for an already-open
side panel and shows its heading. The widget replaces that column when it
connects. If it fails to load, the boot script gives the page its width back
after three seconds and preserves unrelated changes to the page’s inline styles.

Request `widget.js` right away while parsing the head when the boot column
exists. The **Install** snippet puts the existing deferred widget script
directly after the inline script. If your site loads the widget on idle or
on interaction, make that loader run immediately when
`document.getElementById("solv-dock:1:" + assistantKey)` returns an element.
Use the same loader for both paths so the script is requested only once.
With no docked column, keep your usual loading schedule.

To opt in to cross-document view transitions, add this rule to the
stylesheets of both pages. Supporting browsers keep the side panel in place
as its own named part of the transition.
[Chrome's cross-document view transition guide](https://developer.chrome.com/docs/web-platform/view-transitions/cross-document).

```css
@media (prefers-reduced-motion: no-preference) {
  @view-transition {
    navigation: auto;
  }
}
```

In a single-page app, keep `<solv-chat>` outside the routed region, such as
in the root layout, so it stays mounted across route changes.

#### What the chat remembers

On your website's origin, the chat uses `localStorage` for a random visitor
ID that lasts until the browser clears site data. Per assistant, it keeps
the conversation ID, the last 20 turns with their citations and feedback,
and the last time a message was sent or an answer received. Visitors can pick up the conversation in another tab or after
restarting their browser. After 7 days without a message or reply, the widget
forgets the conversation the next time it loads or reads it. **New
conversation** clears it from the browser sooner. The server copy remains
available to the owner according to the server's retention rules.

The panel layout, draft, scroll position and docked first paint use
`sessionStorage` for the life of the tab. Public settings and pending
page-action continuations use the same storage and are valid for two minutes.
When the security check is on, the chat saves its visitor session in the tab's
`sessionStorage` and reuses it across pages in that tab until it needs renewal.
A new tab starts with the panel closed. If the browser blocks shared storage
or coordination, the chat uses tab storage where it can.
The chat holds tool credentials and Turnstile tokens in memory and sets no
cookies.

**Privacy notice wording you can copy**

> Our chat stores a random visitor ID and your recent messages in your browser
> so you can continue across tabs and visits. The conversation is forgotten
> after 7 days without a message or reply, and you can clear it sooner by
> choosing New conversation.

#### Set the launcher’s appearance

You can set the launcher’s appearance for its first paint with optional
attributes on the embed.

```html
<solv-chat assistant="pk_..." launcher-label="Get help"
  launcher-shortcut="/" launcher-position="left"
  launcher-accent-color="#126146" opens-as="side"></solv-chat>
```

`launcher-label` sets the button text, `launcher-position` takes `left` or
`right`, and `launcher-accent-color` takes a three- or six-digit hex colour.
`launcher-shortcut` takes `/`, `mod-k`, or `none`. `opens-as` takes
`panel` or `side` and gives the loading frame its layout on desktop.
Keep these hints in sync with the published Widget settings. A fresh saved
copy for the tab takes precedence over the hints, and a successful response
from the engine supplies the current settings. If the label is unknown, the
launcher shows a chat icon until it knows the published label.

Without a valid shortcut hint or a fresh saved copy for the tab, the widget
reads the public settings when it loads so the published shortcut works on
the first keypress. With either one, a closed widget waits for interaction.
Use `launcher-shortcut="none"` when shortcuts are off and you want the
widget to wait. A page view alone creates no visitor session and saves no
conversation or tab settings.

To open the chat from a button on your page, give `<solv-chat>` an `id` and
set `data-solv-chat-trigger` on the button to that same ID. For example,
`<button type="button" data-solv-chat-trigger="help-chat">Ask a question</button>`
opens `<solv-chat id="help-chat" assistant="pk_..."></solv-chat>`.
Hovering over, focusing or touching either button starts loading the
configuration if it hasn't started already.

The tab can restore its last configuration for up to two minutes and
rechecks it in the background when the chat is open. A browser may reuse a
fresh HTTP response for up to one minute after you publish. A chat left
open on a single page picks up changes on the next page load.

The chat window is 460 × 720 pixels on a desktop screen (never more than the screen less a small margin) and 380 pixels wide on a phone.

With **Allow expanding to a side panel** on (the default, under **Widget**), visitors can expand the chat into a full-height column on the same side as the chat button. On a screen at least 900 pixels wide your page moves over to make room; on a narrower screen the chat fills the screen and your page is not changed. Turn the setting off and the expand button is not shown.

On **Widget**, set **Opens as** to **Side panel** to open beside the page at 900 pixels wide or more. It requires **Allow expanding to a side panel**. On smaller screens the assistant opens as a floating panel. **Floating panel** is the default. After visitors expand or collapse the chat, their choice takes precedence in that tab.

Set **Launcher label** to 1–24 characters of plain text. The default is **Chat**. **Keyboard shortcut** is off by default. Choose **/** or **Ctrl/⌘ K** to let visitors open the chat and focus its message box. The launcher shows the shortcut on devices with a keyboard. The widget leaves keys alone when the page handles them or the visitor is typing in a field.

#### Use your own Ask button

Add `data-solv-chat-open` to a button anywhere on the page, including one you add later. Give the attribute a value of `side` or `panel` to request that view. Use the element's methods when your site needs to control the chat from JavaScript.

```html
<button type="button" data-solv-chat-open>Ask</button>
<button type="button" id="ask-in-side-panel" data-solv-chat-open="side">Ask in the side panel</button>
<script>
  customElements.whenDefined("solv-chat").then(() => {
    const chat = document.querySelector("solv-chat");
    document.querySelector("#ask-in-side-panel").addEventListener("click", (event) => {
      event.preventDefault();
      chat.open({ mode: "side", focus: true });
    });
  });
</script>
```

`open({ mode?, focus? })`, `close()` and `toggle()` return promises that resolve when the action finishes. Hover or focus on a marked trigger starts the same request that an open uses. If settings are pending, an accepted open shows a neutral loading frame with the message box disabled. When the layout is unknown, the compact frame keeps the host page in place until the published layout and content are ready. Omit `mode` to use the visitor's choice or the **Opens as** setting. Omit `focus` to move focus to the message box. Call `open()` or a `toggle()` that opens from a real visitor gesture, such as a button click. Chat only reopens on navigation in a tab where the visitor already had it open.

`send(text, options?)` sends a message from your own input and returns a promise for `{ text }` when the assistant finishes. By default, a closed panel stays closed and the exchange appears in the chat history when the visitor opens it. Pass `{ open: true }` to open it before sending. The visitor check, message limits and page actions also apply to this method. The panel opens if a page action needs approval or the security check needs the visitor's help. The promise rejects with a displayable error if the message is blank, too long or refused, if another reply is in progress, if the assistant is unavailable, or if the reply is interrupted.

```html
<form id="ask-form">
  <label for="ask-input">Ask a question</label>
  <input id="ask-input" name="question" required>
  <button>Ask</button>
</form>
<p id="ask-reply" role="status"></p>
<script>
  customElements.whenDefined("solv-chat").then(() => {
    const chat = document.querySelector("solv-chat");
    const form = document.querySelector("#ask-form");
    const reply = document.querySelector("#ask-reply");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const { text } = await chat.send(form.elements.question.value);
        reply.textContent = text;
      } catch (error) {
        reply.textContent = error.message;
      }
    });
  });
</script>
```

Listen on the element or the page for `solv-chat:open`, `solv-chat:close`, `solv-chat:expand` and `solv-chat:collapse`. These events bubble, cross shadow boundaries and carry no conversation content.

While the column is open the widget adds three inline styles to your `<html>` element and removes exactly what it added when the visitor collapses or closes the chat, or when the widget is removed from the page (an inline style you set yourself comes back as it was):

- `margin-right` (or `margin-left` for a chat on the left) of the column's width, added to an inline margin you already set;
- a `max-width` that keeps the page beside the column, within any maximum width you set;
- `--solv-chat-panel-width`, a CSS custom property holding the column's width (`460px`).

Content in normal flow, including centred layouts, reflows into the narrower page. Elements you fixed to that edge of the screen (a `position: fixed` or `sticky` header, a cookie bar, a "back to top" button) stay where they are and can end up under the column. Move them with the custom property, which is only set while the column is open:

```css
.site-header {
  position: fixed;
  left: 0;
  right: var(--solv-chat-panel-width, 0px);
}
```

For a chat on the left, use the property in `left` instead.

## Keeping a sitemap source in sync (optional)

A source imported from a sitemap can be read again on a schedule: on **Sources**, set its **Sync** to **Every day** or **Every week** (it is **Off** by default, so nothing changes until you turn it on), or choose **Sync now** to run it at once. The first sync asks before it starts, because it brings in every page the sitemap lists, not only the ones you chose when importing. Each run reads the sitemap again, adds pages that are new, re-fetches pages that may have changed, and removes documents whose page is no longer in the sitemap. Only the pages the sitemap lists are fetched; links are not followed.

- **Cheap when nothing changed**: a page whose sitemap `<lastmod>` is the same as last time is not fetched, for up to 7 days after it was last checked (the `recheckDays` setting, 1 to 365, default `7`); after that it is checked again even if its `<lastmod>` has not changed, so a page that was briefly wrong (a "Down for maintenance" page served as a normal page) is put right. Pages are asked for with `If-None-Match` / `If-Modified-Since`, so an unchanged page costs little, and a page whose text has not changed is never embedded again.
- **Safe against a broken sitemap**: if the sitemap cannot be loaded, is cut short or is not valid XML, or lists no pages, the run changes nothing and is recorded as failed. A sitemap index (a sitemap that lists other sitemaps) is not followed: the run fails with "This is a sitemap index; use one of the sitemaps it lists.", and the one-time import's preview says the same. Use one of the sitemaps it lists as the source's address.
- **A limit on removals**: a run that would remove more than half of the source's documents (the `maxRemovePercent` setting, 1 to 100, default `50`) changes nothing: it adds, updates and removes no page. The run is recorded as failed, and it is refused again on every later run, scheduled or not, until you step in. **Sources** offers **Sync anyway**, which says how many documents will be removed and, once you confirm, runs one sync with the limit lifted for that run only: it adds, updates and removes in one go (if by then more would go, it is refused again with the new number). You will need it after a whole-site address change, such as every URL gaining a trailing slash or moving to a new host (every old document is "not listed"), and on very small sources: removing the only page of a one-page source, or 2 pages of 3, is more than half. Check the sitemap first: a sitemap pointing at a staging host or another section of the site trips the limit the same way, and **Sync anyway** would replace your documents with those pages. To allow more for a source, set `maxRemovePercent` with `PATCH /api/admin/sources/<id>` and a body such as `{"settings": {"maxRemovePercent": 100}}`.
- **Caps**: at most 200 pages are fetched per run and a source holds at most 500 documents; the rest are counted as deferred and come up in later runs, ahead of pages that were tried more recently, even if those failed.
- **Sources** shows each sitemap source's schedule, when it last synced, the outcome with its counts (added, updated, unchanged, removed, failed, deferred, and kept when removals waited), when it will next sync, and the last error in plain words; **Overview** lists a source whose last sync failed under "Needs attention".

The schedule is driven by the cron trigger in `packages/engine/wrangler.jsonc` (`"triggers": { "crons": ["17 * * * *"] }`, hourly; each tick starts at most three due sources). It is deployed with `wrangler deploy`; Workers Free allows 5 cron triggers per account. A daily source runs about once a day, at the first tick a day after its previous run.

## 5. Tools (optional)

Open **Tools** and add an MCP server by URL (Streamable HTTP over `https:`). Every tool on a newly added server starts off. A visitor's question can trigger any tool you switch on. For a shared key you enter in Tools, **use a token that can only read.**

A tool runs for visitors only when both are true: you switched it on under **Tools**, **and** you clicked **Publish** afterwards. Switching a tool on updates your draft (so you can try it in the "Try it" pane); **Publish** is what reaches visitors.

If the server needs a key, enter the header name it expects and the key value. It is stored encrypted with `SOLV_SECRET_KEY` and never shown again, so keep your own copy. If you rotate `SOLV_SECRET_KEY`, stored tool credentials become unreadable until you re-enter them on the **Tools** screen.

### Use each visitor’s own key

On the server’s card under **Tools**, choose **The page supplies each visitor's key** under **Where the key comes from**. Enter the header your server expects. The default is `Authorization`, which sends `Bearer <token>`. A custom header receives the token as entered. Save and **Publish** to turn the mode on for visitors.

Use the same HTTPS address on the page and in Tools, including its exact origin and path. Use an address without a query or fragment and keep secrets out of the address. Wait for the widget to load, then set the signed-in visitor’s token. Call the method again when you renew the token, and pass `null` when the visitor signs out.

```js
await customElements.whenDefined("solv-chat");
const chat = document.querySelector("solv-chat");
const serverUrl = "https://tools.example.com/mcp";

chat.setToolCredential(serverUrl, visitorToken);
// On renewal:
chat.setToolCredential(serverUrl, renewedVisitorToken);
// On sign-out:
chat.setToolCredential(serverUrl, null);
```

The widget holds the token in memory and includes it in chat requests only for a server the published assistant marks as page-supplied. The Worker uses it only for that server’s tool calls during that request and refuses redirects. If the token is missing, the assistant answers without that server’s tools.

Issue short-lived tokens scoped to the visitor and the operations your app intends to allow. The assistant can do whatever the token allows. Keep your own authorization checks on the server and require confirmation for operations that need the visitor’s approval.

Optionally save a **Test key** for tool listing, the **Try it** pane, and answer tests (including **Publish** and `solv test`). The Worker encrypts it with `SOLV_SECRET_KEY` and uses it only for those paths. Without a saved test key, Tools asks for a one-time key to list the tools and discards it afterwards. Try it and answer tests omit that server’s tools until you save a test key.

### Send conversation context

Every tool call comes from your Worker. With a shared key, the tool server sees your visitors as one caller. If the server limits or tracks work per visitor, switch on **Send conversation context** on that server's card under **Tools** (it is off for every server until you do, and takes effect at once; it is not part of Publish). Each request the engine then makes to that server for a visitor's chat (`initialize`, `tools/list` and `tools/call`) carries three headers:

| Header                 | Value                                                         |
| ---------------------- | ------------------------------------------------------------- |
| `Solv-Conversation-Id` | the conversation id (`cnv_…`)                                 |
| `Solv-Visitor-Id`      | the random id the widget keeps for the visitor in the browser |
| `Solv-Assistant-Id`    | the assistant id (`ast_…`)                                    |

Values are the engine's own opaque ids: an id of 1 to 128 letters, digits, `_` or `-` that does not start with `h_` is sent as it is, and any other id as `h_` followed by the first 32 hex characters of its SHA-256. Because an id that starts with `h_` is always hashed, a hashed value can never equal a raw id, so a visitor cannot pass off another visitor's hashed value as their own. Nothing else is sent in these headers: no IP address, page address or message text.

Requests from the admin and from CI belong to no visitor, so they carry `Solv-Assistant-Id` only: listing a server's tools when you add it or press **Refresh**, the "Try it" pane, and answer tests run from **Tests**, **Publish** or `solv test`. None of these stores a conversation, so none sends `Solv-Conversation-Id` or `Solv-Visitor-Id`.

The ids say nothing about who a visitor is, but they let the server link all of one visitor's conversations (in the same browser). **Turn this on only for a server you run or trust.** The three header names are reserved: you cannot add a server, or rename its key header, to one of them (in any case). A server saved with such a key header before this rule keeps working and can still be edited, disabled, have its key removed or keep the setting off; only turning **Send conversation context** on is refused until you rename the header.

#### What your tool server may rely on

- Trust these headers only on requests that carry the server's key. A server with no key cannot tell the engine's requests from anyone else's, so anyone can forge them.
- `Solv-Conversation-Id` is issued by the engine; a visitor cannot choose it. But a visitor can start as many conversations as they like.
- `Solv-Visitor-Id` comes from the visitor's browser. It is a hint, not proof: a visitor can change it or copy someone else's.
- So keep a limit per assistant, or for everyone, behind any limit per conversation or per visitor.

#### From `solv.config.json`

`solv apply` changes servers already added in the admin, matched by address, and leaves the rest alone:

```json
{ "mcpServers": [{ "url": "https://tools.example.com/mcp", "sendConversationContext": false }] }
```

The ingest key is a CI credential, so it can do less here than you can in the admin:

- It can turn **Send conversation context** off, but not on. Turn it on under **Tools** in the admin. If the file asks for on where a server is off, `solv apply` names that server, changes nothing and fails; if the server is already on, that entry is fine and changes nothing.
- Reading the servers with it shows each server's name, setting and the start of its address (for example `https://tools.example.com`), never the rest of the address or its key.

`solv apply` checks `mcpServers` with the engine before it writes anything, so if any entry would be refused, the draft, tests and servers are all left as they were.

Tool runs are capped at 4 iterations per turn, 20 tool calls per conversation, 15 seconds of wall time per answer, 10 seconds per MCP request, and 8192 bytes per tool result.

## 6. Page actions (optional)

Open **Widget**, turn on **Let the assistant help on the page**, and click **Publish** to enable the three built-in actions (`navigate`, `highlight`, and `fill`).

Mark what the assistant may touch in your HTML with two attributes:

- `data-solv-fill="<name>"` on form fields `fill` may set
- `data-solv-target="<name>"` on elements `highlight` may point at
- `data-solv-no-fill` on a form or any ancestor to take everything inside it out of scope

`fill` always asks the visitor to accept before changing a field and never submits. Password, payment and one-time-code fields are never filled or read, even if marked.

**Other sites it may send visitors to** is a different list from **Allowed origins**: the first lists extra origins `navigate` may open in a new tab, while the second lists which sites may embed and chat with the assistant at all. At most 16 page actions are sent per chat request.

A page action times out after 5 seconds so it does not hold the answer indefinitely. Timing out does not cancel the underlying call, so an action that timed out may still complete in the page.

## 7. Tests (optional)

Open **Tests** to write questions your assistant must keep getting right (up to 25 tests per assistant). Each test is a question plus one expectation: `cites` a URL, `contains` a phrase, `notContains` a phrase, or `declines` (uses the fallback).

Clicking **Publish** runs the tests against the draft first (at most 25 tests per run, within 60 seconds). If any fail, you are shown which and why, and can fix the draft or click **Publish anyway**.

From CI, run tests with the same ingest key you use for content:

```sh
SOLV_INGEST_KEY=<the key> npx solv test \
  --endpoint https://<your-worker> --assistant ast_…
```

`solv test` exits non-zero if any test fails or does not run. If you declare a `tests` array in `solv.config.json` (and pass `--file solv.config.json` to `solv test`, or run `solv apply`), it **replaces** the assistant's stored tests, including any you added in the admin; `solv test --dry-run` previews what would change first.

## 8. Reports

Open **Reports** and pick **7**, **30**, or **90** days to see questions asked, share answered, share marked unhelpful (thumbs down), cost, response time (how long visitors waited until the answer started appearing and until it was complete, compared with the period before; Try it, tests and answers that used a page action are not counted), most asked questions, most frequent unanswered questions, and which sources were cited most and never. Click **Download CSV** to save the report on screen.

## Rotating a secret

- `SOLV_SECRET_KEY` — every session is signed out, so sign in again, and every
  MCP server credential and provider API key stored with the old key can no
  longer be read. Open **Tools** to re-enter MCP server credentials, and open
  **Settings → Providers** to re-enter any stored provider keys; until you do,
  those servers' tools cannot be called and answering with a stored provider key
  will fail rather than falling back to a Worker secret. Visitors' security-check
  sessions stop working too; each visitor's next message runs the check again.

Signing out clears the session cookie in that browser only. The engine keeps no list of sessions, so a copy of the cookie stays valid until it expires after 30 days. If you think a session cookie was copied, rotate `SOLV_SECRET_KEY`.

- An ingest key — rotate it on the **Install** screen in `/admin` and replace it in CI; the old one stops working at once.
- A provider key — takes effect on the next request; nothing else changes.
- `SOLV_TURNSTILE_SECRET` — rotate it in the Turnstile dashboard ([guide](https://developers.cloudflare.com/turnstile/troubleshooting/rotate-secret-key/)) and put the new one with `wrangler secret put`. Sessions already issued keep working until they expire (one hour).

## Upgrading an existing instance

From the repository root, apply the new D1 migrations, rebuild, and redeploy:

```sh
npm ci
npm run migrations:apply -w @solvchat/engine
npm run build
cd packages/engine && npx wrangler deploy
```

No environment variable needs to change. The scheduled sitemap sync adds a cron trigger to `wrangler.jsonc`; `wrangler deploy` installs it, and no source syncs until you set its schedule. Upgrading to this version signs existing admin sessions out once because session cookies are now signed with a key derived from `SOLV_SECRET_KEY`; sign in again after deploying.

The embed works with the same `/widget.js` URL. Browsers can reuse the widget
and its security check script (`/v1/check/frame.js`) for five minutes before
checking for an update. Returning visitors get the new script on their first
load after that window expires. Copies cached before this change can still
follow their previous limits (up to a day for the widget and an hour for the
check script).

If you put a CDN in front of the Worker, configure it to honor the scripts'
`Cache-Control` and `ETag` headers. Keep the five-minute freshness limit and
revalidate expired copies before serving them. Preserve the response bytes
so the strong `ETag` stays valid.

## Not here yet

- The cloud layer: public sign-up, teams and roles, billing, managed model keys, and scheduled email digests. Those live in a separate, closed repository; nothing here needs them.
- A crawler that follows links. Content is pushed with `solv push`, imported from a sitemap (once, or again daily or weekly; see "Keeping a sitemap source in sync"), or written by hand under **Sources**. Only pages a sitemap lists are ever fetched.
