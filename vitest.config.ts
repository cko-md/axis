import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"],
    // Keep the complete gate stable on the 8 GiB CI/development hosts. Vitest's
    // default worker count can exhaust memory and turn otherwise passing suites
    // into timeout failures; raise this only with measured full-suite evidence.
    maxWorkers: 4,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
