import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The `@/` alias tsconfig and bb's build resolve, for tests that load the app's components.
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
