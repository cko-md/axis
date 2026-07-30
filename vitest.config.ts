import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"],
    // Keep the complete typecheck + lint + test gate stable on 8 GiB hosts.
    // Vitest's default or four-worker settings can exhaust residual memory and
    // turn otherwise passing suites into timeouts; raise only with measured
    // evidence from the complete gate, not a standalone Vitest run.
    maxWorkers: 2,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
