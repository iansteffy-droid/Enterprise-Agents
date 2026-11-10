import path from "path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      lexical: path.resolve(__dirname, "./node_modules/lexical/Lexical.mjs"),
    },
  },
  test: {
    // Never run stale compiled tests from a build output.
    exclude: [...configDefaults.exclude, "**/dist/**"],
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
  },
});
