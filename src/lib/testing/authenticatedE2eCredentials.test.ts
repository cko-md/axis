import { describe, expect, it } from "vitest";
import {
  createAuthenticatedE2ECredential,
  writeAuthenticatedE2EEnvironment,
} from "../../../scripts/authenticated-e2e-credentials.mjs";

describe("authenticated E2E credentials", () => {
  it("uses a fresh 32-byte entropy block for every run", () => {
    const entropyLengths: number[] = [];
    let syntheticByte = 1;
    const syntheticEntropy = (length: number) => {
      entropyLengths.push(length);
      return Buffer.alloc(length, syntheticByte++);
    };
    const first = createAuthenticatedE2ECredential(syntheticEntropy);
    const second = createAuthenticatedE2ECredential(syntheticEntropy);

    expect(entropyLengths).toEqual([32, 32]);
    expect(first).toHaveLength(43);
    expect(second).toHaveLength(43);
    expect(first).not.toBe(second);
  });

  it("masks before writing the credential and never emits an environment assignment", () => {
    const credential = "E2E_TEST_MASK_SENTINEL";
    const events: Array<{ kind: "stdout" | "env"; value: string }> = [];

    writeAuthenticatedE2EEnvironment({
      outputPath: "/nonexistent/never-written",
      values: {
        url: "http://127.0.0.1:54321",
        anonKey: "anon",
        serviceRoleKey: "service",
        appUrl: "http://127.0.0.1:3000",
        email: "axis-ci-auth@example.test",
      },
      credential,
      isGitHubActions: true,
      emit: (line: string) => events.push({ kind: "stdout", value: line }),
      append: (_path: string, contents: string) => events.push({ kind: "env", value: contents }),
    });

    expect(events[0]).toEqual({ kind: "stdout", value: `::add-mask::${credential}` });
    expect(events.filter((event) => event.kind === "stdout")).toEqual([
      { kind: "stdout", value: `::add-mask::${credential}` },
    ]);
    expect(events[1]).toMatchObject({ kind: "env" });
    expect(events[1]?.value).toContain(`E2E_USER_PASSWORD=${credential}`);
  });
});
