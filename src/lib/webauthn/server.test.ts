import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateRegistrationOptions: vi.fn(),
  generateAuthenticationOptions: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
}));

vi.mock("@simplewebauthn/server", () => ({
  generateRegistrationOptions: (...args: unknown[]) =>
    mocks.generateRegistrationOptions(...args),
  generateAuthenticationOptions: (...args: unknown[]) =>
    mocks.generateAuthenticationOptions(...args),
  verifyRegistrationResponse: (...args: unknown[]) =>
    mocks.verifyRegistrationResponse(...args),
  verifyAuthenticationResponse: (...args: unknown[]) =>
    mocks.verifyAuthenticationResponse(...args),
}));
vi.mock("@/lib/env", () => ({
  optionalEnv: (key: string) =>
    key === "NEXT_PUBLIC_APP_URL" ? "https://axis.test" : undefined,
}));

import {
  buildAuthenticationOptions,
  buildRegistrationOptions,
} from "./server";

describe("WebAuthn ceremony options", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateRegistrationOptions.mockResolvedValue({
      challenge: "registration-challenge",
    });
    mocks.generateAuthenticationOptions.mockResolvedValue({
      challenge: "authentication-challenge",
    });
  });

  it("requires discoverable credentials and user verification without excluding security keys", async () => {
    await buildRegistrationOptions(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "user@example.test",
      [],
    );

    expect(mocks.generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        authenticatorSelection: {
          residentKey: "required",
          requireResidentKey: true,
          userVerification: "required",
        },
      }),
    );
    const options = mocks.generateRegistrationOptions.mock.calls[0][0];
    expect(options.authenticatorSelection).not.toHaveProperty(
      "authenticatorAttachment",
    );
  });

  it("requests the same user-verification level enforced by authentication verification", async () => {
    await buildAuthenticationOptions([]);

    expect(mocks.generateAuthenticationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: "axis.test",
        userVerification: "required",
        allowCredentials: undefined,
      }),
    );
  });
});
