import { optionalEnv } from "@/lib/env";

export type DirectProviderCookieKey = {
  version: 1 | 2;
  secret: string;
};

export type DirectProviderCookieKeyring = {
  current: DirectProviderCookieKey;
  legacy: readonly DirectProviderCookieKey[];
  oauthSecret: string;
};

export type DirectProviderCookieKeyInput = string | DirectProviderCookieKeyring;

export function directProviderCookieKeyring(
  providerSecret: string,
): DirectProviderCookieKeyring {
  const stableSecret = optionalEnv("DIRECT_PROVIDER_COOKIE_SECRET");
  if (!stableSecret) throw new Error("DIRECT_PROVIDER_COOKIE_SECRET_NOT_CONFIGURED");
  const previousStableSecret = optionalEnv("DIRECT_PROVIDER_COOKIE_SECRET_PREVIOUS");
  const legacy: DirectProviderCookieKey[] = [
    ...(previousStableSecret && previousStableSecret !== stableSecret
      ? [{ version: 2 as const, secret: previousStableSecret }]
      : []),
    ...(providerSecret !== stableSecret
      ? [{ version: 1 as const, secret: providerSecret }]
      : []),
  ];
  return {
    current: { version: 2, secret: stableSecret },
    legacy,
    oauthSecret: providerSecret,
  };
}

export function normalizeDirectProviderCookieKeyring(
  input: DirectProviderCookieKeyInput,
): DirectProviderCookieKeyring {
  return typeof input === "string"
    ? {
        current: { version: 1, secret: input },
        legacy: [],
        oauthSecret: input,
      }
    : input;
}
