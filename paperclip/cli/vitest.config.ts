import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Never run stale compiled tests from a build output.
    exclude: [...configDefaults.exclude, "**/dist/**"],
    environment: "node",
  },
});
