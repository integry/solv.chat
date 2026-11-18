# solv.chat

An open-source chatbot for your website. It answers visitors from your own
content, can call tools on MCP servers you configure, and shows you which
questions it could not answer.

Runs on Cloudflare Workers with your own Anthropic, OpenAI, or OpenRouter key.

**Status: self-hostable.** The chat engine, widget, admin, MCP tools, page
actions, answer tests and reports work. The cloud layer — sign-up, teams,
billing, managed keys, email — is phase 3 and not in this repository; it is not
needed to run your own. Content is pushed, imported from a sitemap (once, or
again daily or weekly), or written by hand. There is no crawler that follows
links: only the pages a sitemap lists are fetched.

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

- `icon` on an extra nav item — optional small decorative icon (for example a 16×16
  inline `<svg aria-hidden="true">` drawn with `currentColor`) shown before the label.
- `section` on an extra nav item — the built-in groups are _Monitor_, _Build_,
  _Go live_ and _Settings_; naming one adds the item to it, any other name adds a
  section after them.

Below 900px the navigation becomes a drawer opened from a menu button. The top bar
then keeps only the product name, `headerStart`, the current screen, Try it and the
menu button; the assistant switcher and publish status move to the top of the
drawer, and `headerEnd` and Sign out to its bottom. Keep `headerStart` compact.

### Shared components

The package entry also exports the pieces the built-in screens use, so host screens
look and behave the same:

```tsx
import {
  ConfirmDialog,
  CopyButton,
  DataTable,
  EmptyState,
  PageHeader,
  RowMenu,
  Skeleton,
  StatusBadge,
  formatDate,
  formatDateTime,
  formatRelative,
  useToast,
} from "@solvchat/admin";

function BillingScreen() {
  const toast = useToast(); // feedback messages; the admin shell provides them
  return (
    <div className="screen">
      <PageHeader title="Billing" description="Your plan and invoices." />
      <EmptyState
        icon="inbox"
        title="No invoices yet"
        description="Your first invoice appears here."
      />
    </div>
  );
}
```

- `PageHeader` — screen title, one-sentence description and actions.
- `EmptyState` — icon, title, one sentence and a primary action.
- `StatusBadge` — a status word in a coloured pill (`success`, `warning`, `danger`,
  `info`, `neutral`).
- `ConfirmDialog` (and `Dialog`) — focus-trapped; `tone="danger"` for destructive
  actions and `confirmText` to require typing a word first.
- `ToastProvider` / `useToast` and `Notice` — feedback with `role="status"`, or
  `role="alert"` for errors.
- `Skeleton`, `DataTable` (stacks into labelled rows under 600px), `RowMenu`,
  `CopyButton`, `Icon`, `RelativeTime`.
- `formatDate` / `formatDateTime` / `formatRelative` — one date format everywhere:
  `16 Nov 2026`, `16 Nov 2026, 23:10`, "3 hours ago". Month names follow the
  browser's locale; dates are never US-style numeric.

With no assistant yet, every built-in screen shows a first-run state with the
"New assistant" form; after creating one the admin opens its Sources screen.
The full option list is in [docs/architecture.md](docs/architecture.md#extending-the-admin).

## License

Apache 2.0. See [LICENSE](LICENSE).
