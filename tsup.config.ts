import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

// SWC (auto-enabled by emitDecoratorMetadata + @swc/core) keeps Nest's decorator metadata.
export default defineConfig({
  entry: ["src/main.ts", "src/worker.ts", "src/openapi.ts", "src/migrate.ts", "src/admin-create.ts"],
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
