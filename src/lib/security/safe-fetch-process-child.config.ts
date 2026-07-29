import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/lib/security/safe-fetch-process-child.fixture.ts"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
