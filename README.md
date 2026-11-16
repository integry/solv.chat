# solv.chat

An open-source chatbot for your website. It answers visitors from your own
content, can call tools on MCP servers you configure, and shows you which
questions it could not answer.

Runs on Cloudflare Workers with your own Anthropic, OpenAI, or OpenRouter key.

**Status: self-hostable.** The chat engine, widget, admin, MCP tools, page
actions, answer tests and reports work. The cloud layer — sign-up, teams,
billing, managed keys, email — is phase 3 and not in this repository; it is not
needed to run your own. There is no crawler: content is pushed, imported once
from a sitemap, or written by hand.

To run your own, follow [docs/self-hosting.md](docs/self-hosting.md). The
design is in [docs/architecture.md](docs/architecture.md).

## Development

```
npm ci
npm run verify
```

Requires Node 24.

### Engine (`packages/engine`)

```
npm run typecheck -w @solvchat/engine
npm run test -w @solvchat/engine
npm run build -w @solvchat/engine
```

Required Worker secrets (set with `wrangler secret put` or `.dev.vars` locally; provider/model choices and encrypted API keys can also be configured in the admin under **Settings → Providers** when `SOLV_SECRET_KEY` is set, and stored settings/keys take precedence over `vars` and Worker secrets):

- `SOLV_ADMIN_PASSWORD` — admin sign-in password
- `SOLV_SECRET_KEY` — signs session cookies and encrypts stored MCP tool credentials and stored provider API keys. Changing it signs everyone out **and** makes stored credentials and keys unreadable until you enter them again.
- `SOLV_ANTHROPIC_KEY` — Anthropic API key (optional if entered in **Settings → Providers**)
- `SOLV_OPENAI_KEY` — OpenAI API key (optional if entered in **Settings → Providers**)
- `SOLV_OPENROUTER_KEY` — OpenRouter API key (optional if entered in **Settings → Providers**)

## Page actions

Your assistant can act inside the page a visitor is on. Register your own
actions and it will use them while it answers:

```js
solv.actions.register({
  name: "open_invoice",
  description: "Open one of the visitor's invoices",
  input: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
  confirm: false,
  run: async ({ id }) => {
    router.push(`/invoices/${id}`);
    return { opened: id };
  },
});
```

Three actions are built in and off until you turn them on under **Widget**:
`navigate` moves a visitor around your site, `highlight` points at a control,
and `fill` puts values into fields you marked. Mark them in your HTML:

```html
<input data-solv-fill="email" name="email" />
<button data-solv-target="save">Save changes</button>
<form data-solv-no-fill>...</form>
```

Anything marked `confirm`, and every `fill`, waits for the visitor to accept.
Nothing is submitted, bought, sent or deleted without their own click. Password,
payment and one-time-code fields are never filled or read, even if marked.
Page actions time out after 5 seconds so an answer is not held indefinitely;
timing out does not cancel the call, so an action that timed out may still
complete in the page.

## Mounting and extending the admin

`@solvchat/admin` can be mounted into another app with `mountAdmin(root, options)`.
Import `@solvchat/admin/styles.css` alongside it. A host can add screens, replace
sign-in and sign-out, hide built-in screens, put its own controls in the top bar,
and choose where `/admin/` lands:

```tsx
import "@solvchat/admin/styles.css";
import { type HeaderSlotProps, mountAdmin } from "@solvchat/admin";

function OrgName({ api }: HeaderSlotProps) {
  const org = api.useResource<{ name: string }>("/api/account/org");
  return <span>{org.value?.name}</span>;
}

mountAdmin(document.getElementById("root")!, {
  extraNavItems: [
    // Not about one assistant: no assistant switcher or Try it pane, and it
    // renders before the first assistant exists.
    {
      id: "account",
      label: "Account",
      path: "/admin/account",
      section: "Account",
      assistantScoped: false,
    },
  ],
  extraScreens: { account: AccountScreen },
  headerStart: OrgName,
  headerEnd: OrgSwitcher,
  defaultScreen: "account",
});
```

- `headerStart` / `headerEnd` — components rendered in the top bar after the
  product name and before the Sign out button. They receive `{ api }`, the same
  same-origin API helpers extra screens get. Leave them out for the default header.
- `assistantScoped` on an extra nav item — defaults to `true`. Set it to `false`
  for screens that are not about the selected assistant: the assistant switcher,
  "New assistant" and the Try it pane are hidden there, and the screen renders even
  when no assistant exists. Extra sections are listed after the built-in ones.
- `defaultScreen` — the screen `/admin/` (and any unknown admin path) opens: a
  built-in screen id or an extra nav item id. Defaults to Overview. An unknown or
  hidden id throws at mount time.

With no assistant yet, every built-in screen shows a first-run state with the
"New assistant" form; after creating one the admin opens its Sources screen.
The full option list is in [docs/architecture.md](docs/architecture.md#extending-the-admin).

## License

Apache 2.0. See [LICENSE](LICENSE).
