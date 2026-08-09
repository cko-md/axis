import { optionalEnv } from "@/lib/env";

export type DirectProviderCookieKey = {
  version: 1 | 2;
  secret: string;
};

export type DirectProviderCookieKeyring = {
  current: DirectProviderCookieKey;
  legacy: readonly DirectProviderCookieKey[];
};

export type DirectProviderCookieKeyInput = string | DirectProviderCookieKeyring;

function acceptsLegacyProviderSecret(): boolean {
  const raw = optionalEnv("DIRECT_PROVIDER_COOKIE_V1_ACCEPT_UNTIL");
  if (!raw) return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw)) {
    throw new Error("DIRECT_PROVIDER_COOKIE_V1_ACCEPT_UNTIL_INVALID");
  }
  const cutoff = Date.parse(raw);
  if (!Number.isFinite(cutoff) || new Date(cutoff).toISOString() !== raw) {
    throw new Error("DIRECT_PROVIDER_COOKIE_V1_ACCEPT_UNTIL_INVALID");
  }
  return Date.now() < cutoff;
}

export function directProviderCookieKeyring(
  providerSecret: string,
  previousProviderSecret?: string,
): DirectProviderCookieKeyring {
  const stableSecret = optionalEnv("DIRECT_PROVIDER_COOKIE_SECRET");
  if (!stableSecret) throw new Error("DIRECT_PROVIDER_COOKIE_SECRET_NOT_CONFIGURED");
  const previousStableSecret = optionalEnv("DIRECT_PROVIDER_COOKIE_SECRET_PREVIOUS");
  const legacyProviderSecrets = acceptsLegacyProviderSecret()
    ? [providerSecret, previousProviderSecret]
        .filter((secret): secret is string => Boolean(secret))
        .filter((secret, index, all) => all.indexOf(secret) === index)
    : [];
  const legacy: DirectProviderCookieKey[] = [
    ...(previousStableSecret && previousStableSecret !== stableSecret
      ? [{ version: 2 as const, secret: previousStableSecret }]
      : []),
    ...legacyProviderSecrets
      .filter((secret) => secret !== stableSecret)
      .map((secret) => ({ version: 1 as const, secret })),
  ];
  return {
    current: { version: 2, secret: stableSecret },
    legacy,
  };
}

export function normalizeDirectProviderCookieKeyring(
  input: DirectProviderCookieKeyInput,
): DirectProviderCookieKeyring {
  return typeof input === "string"
    ? {
        current: { version: 1, secret: input },
        legacy: [],
      }
    : input;
}
