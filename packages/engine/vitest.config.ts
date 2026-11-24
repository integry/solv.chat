import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrationsPath = path.join(__dirname, "migrations");
  const migrations = await readD1Migrations(migrationsPath);

  return {
    resolve: {
      alias: {
        "@solvchat/core": path.join(__dirname, "../core/src/index.ts"),
        "@solvchat/cli": path.join(__dirname, "../cli/src/index.ts"),
      },
    },
    test: {
      setupFiles: ["./test/setup.ts"],
      poolOptions: {
        workers: {
          singleWorker: true,
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              SOLV_ADMIN_PASSWORD: "fixture-admin-password",
              SOLV_SECRET_KEY: "fixture-operator-signing-key",
            },
          },
        },
      },
    },
  };
});
