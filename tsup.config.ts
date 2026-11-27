import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

// SWC (auto-enabled by emitDecoratorMetadata + @swc/core) keeps Nest's decorator metadata.
export default defineConfig({
  entry: { main: "src/main.ts", worker: "src/worker.ts", openapi: "src/openapi.ts", migrate: "src/migrate.ts", "admin-create": "src/admin-create.ts", "demo-logins": "src/demo-logins.ts", seed: "src/db/seed/index.ts", purge: "src/db/seed/purge.ts" },
  format: "cjs",
  target: "node22",
  sourcemap: true,
  splitting: false,
  clean: true,
  external: ["sharp", "@node-rs/argon2"],
  esbuildOptions(o) {
    o.alias = { "@": fileURLToPath(new URL("./src", import.meta.url)) };
  },
});
