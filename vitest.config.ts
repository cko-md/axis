import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    // Several suites intentionally exercise CPU-heavy game generation and
    // Git-backed release fixtures. Vitest's host-sized default oversubscribes
    // 8-core runners and causes unrelated timeout failures under full load.
    maxWorkers: 4,
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
