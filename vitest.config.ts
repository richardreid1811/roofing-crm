import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: { name: "shared", include: ["test/shared/**/*.test.ts"], environment: "node", testTimeout: 20_000 },
      },
      {
        plugins: [
          cloudflareTest(async () => ({
            main: "./worker/index.ts",
            wrangler: { configPath: "./wrangler.jsonc" },
            // Tests never call Workers AI; keep everything local (no Cloudflare login needed in CI).
            remoteBindings: false,
            miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations("./migrations") } },
          })),
        ],
        test: { name: "worker", include: ["test/worker/**/*.test.ts"] },
      },
    ],
  },
});
