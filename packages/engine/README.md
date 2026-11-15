# @solvchat/engine

Cloudflare Worker chat engine, retrieval pipeline, and admin/widget server for [solv.chat](https://github.com/integry/solv.chat).

## Using from `node_modules`

Install `@solvchat/engine` at a pinned exact version alongside `@solvchat/core`:

```sh
npm install --save-exact @solvchat/engine@<version>
```

### Worker entrypoint

Create your Worker entrypoint by calling `createApp(seams)` with your `AuthProvider`, `KeyProvider`, `UsageSink`, and `Limits` implementations:

```ts
import { createApp, type Env, type Seams } from "@solvchat/engine";

const seams: Seams = {
  auth: /* AuthProvider */,
  keys: /* KeyProvider */,
  usage: /* UsageSink */,
  limits: /* Limits */,
};

export default createApp(seams);
```

### D1 migrations

Point Wrangler's `migrations_dir` at the `migrations/` directory shipped inside the package:

```jsonc
{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "solvchat",
      "database_id": "<your-database-id>",
      "migrations_dir": "node_modules/@solvchat/engine/migrations"
    }
  ]
}
```

### Widget and admin assets

The built widget (`GET /widget.js`) and admin SPA (`GET /admin/*`) are bundled directly inside `@solvchat/engine/dist` (`widgetBundle.js` and `adminBundle.js`) and served automatically by `createApp(seams)`. No separate Wrangler `assets` directory configuration is required.
