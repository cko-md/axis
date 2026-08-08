import { createHmac, timingSafeEqual } from "node:crypto";
import { oauthPendingStateCookieName } from "@/lib/auth/directProviderCookies";
import type { DirectOAuthProvider } from "@/lib/auth/oauthState.server";
import { isProfileSubject } from "@/lib/auth/profileSubject";

type CookieValue = { value: string } | undefined;
type CookieOptions = {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  maxAge: number;
  path: "/";
};

export type MutableProviderCookieStore = {
  get(name: string): CookieValue;
  set(name: string, value: string, options: CookieOptions): unknown;
  delete(name: string): unknown;
};

const PROVIDER_COOKIES: Record<DirectOAuthProvider, {
  access: string;
  refresh: string;
  owner: string;
  oauthPendingState: string;
  accessMaxAge: number;
  refreshMaxAge: number;
}> = {
  spotify: {
    access: "spotify_access_token",
    refresh: "spotify_refresh_token",
    owner: "spotify_token_owner",
    oauthPendingState: oauthPendingStateCookieName("spotify"),
    accessMaxAge: 60 * 60,
    refreshMaxAge: 60 * 60 * 24 * 30,
  },
  strava: {
    access: "strava_access_token",
    refresh: "strava_refresh_token",
    owner: "strava_token_owner",
    oauthPendingState: oauthPendingStateCookieName("strava"),
    accessMaxAge: 6 * 60 * 60,
    refreshMaxAge: 60 * 60 * 24 * 90,
  },
};

const OWNER_SEAL_VERSION = 1;
const OWNER_SEAL_PREFIX = `po${OWNER_SEAL_VERSION}_`;
const OWNER_SEAL_PATTERN = /^po1_[A-Za-z0-9_-]{43}$/;

function options(maxAge: number): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge,
    path: "/",
  };
}

function boundedMaxAge(value: unknown, fallback: number): number {
  if (!Number.isFinite(value) || !Number.isSafeInteger(value)) return fallback;
  return Math.max(1, Math.min(Number(value), 24 * 60 * 60));
}

export function setOAuthPendingStateCookie(
  store: MutableProviderCookieStore,
  provider: DirectOAuthProvider,
  sealedState: string,
  maxAge: number,
): void {
  store.set(PROVIDER_COOKIES[provider].oauthPendingState, sealedState, options(maxAge));
}

/** Reads and terminally clears pending OAuth state before callback validation/exchange. */
export function consumeOAuthPendingStateCookie(
  store: MutableProviderCookieStore,
  provider: DirectOAuthProvider,
): string | null {
  const name = PROVIDER_COOKIES[provider].oauthPendingState;
  const sealedState = store.get(name)?.value ?? null;
  store.delete(name);
  return sealedState;
}

function ownerSealKey(secret: string, provider: DirectOAuthProvider): Buffer {
  return createHmac("sha256", secret)
    .update(`axis:direct-provider-owner:key:v${OWNER_SEAL_VERSION}:${provider}`)
    .digest();
}

export function createProviderOwnerSeal(
  provider: DirectOAuthProvider,
  subject: string,
  secret: string,
): string {
  if (!isProfileSubject(subject) || !secret) {
    throw new Error("PROVIDER_OWNER_SEAL_INPUT_INVALID");
  }
  const digest = createHmac("sha256", ownerSealKey(secret, provider))
    .update(`axis:direct-provider-owner:subject:v${OWNER_SEAL_VERSION}\0${subject}`)
    .digest("base64url");
  return `${OWNER_SEAL_PREFIX}${digest}`;
}

function validOwnerSeal(
  supplied: string | undefined,
  provider: DirectOAuthProvider,
  subject: string,
  secret: string,
): boolean {
  if (!OWNER_SEAL_PATTERN.test(supplied ?? "") || !isProfileSubject(subject) || !secret) {
    return false;
  }
  const expected = createProviderOwnerSeal(provider, subject, secret);
  const suppliedBytes = Buffer.from(supplied!);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.length === expectedBytes.length
    && timingSafeEqual(suppliedBytes, expectedBytes);
}

export function providerTokensForSubject(
  store: MutableProviderCookieStore,
  provider: DirectOAuthProvider,
  subject: string,
  secret: string,
): { accessToken: string | null; refreshToken: string | null } {
  const names = PROVIDER_COOKIES[provider];
  const owner = store.get(names.owner)?.value;
  const accessToken = store.get(names.access)?.value ?? null;
  const refreshToken = store.get(names.refresh)?.value ?? null;
  if (!validOwnerSeal(owner, provider, subject, secret)) {
    if (owner || accessToken || refreshToken) clearProviderTokenCookies(store, provider);
    return { accessToken: null, refreshToken: null };
  }
  return {
    accessToken,
    refreshToken,
  };
}

export function setProviderAccessToken(
  store: MutableProviderCookieStore,
  provider: DirectOAuthProvider,
  accessToken: string,
  expiresIn?: unknown,
): void {
  const config = PROVIDER_COOKIES[provider];
  store.set(
    config.access,
    accessToken,
    options(boundedMaxAge(expiresIn, config.accessMaxAge)),
  );
}

export function setProviderRefreshToken(
  store: MutableProviderCookieStore,
  provider: DirectOAuthProvider,
  refreshToken: string,
): void {
  const config = PROVIDER_COOKIES[provider];
  store.set(config.refresh, refreshToken, options(config.refreshMaxAge));
}

export function clearProviderTokenCookies(
  store: MutableProviderCookieStore,
  provider: DirectOAuthProvider,
): void {
  const names = PROVIDER_COOKIES[provider];
  store.delete(names.owner);
  store.delete(names.access);
  store.delete(names.refresh);
  store.delete(names.oauthPendingState);
}

/** Clears any prior subject first, then publishes the owner only after tokens exist. */
export function replaceProviderTokenCookies(
  store: MutableProviderCookieStore,
  provider: DirectOAuthProvider,
  tokens: { accessToken: string; refreshToken?: string; expiresIn?: unknown },
  subject: string,
  secret: string,
): void {
  if (!isProfileSubject(subject) || !tokens.accessToken || !secret) {
    throw new Error("PROVIDER_TOKEN_COOKIE_INPUT_INVALID");
  }
  clearProviderTokenCookies(store, provider);
  setProviderAccessToken(store, provider, tokens.accessToken, tokens.expiresIn);
  if (tokens.refreshToken) {
    setProviderRefreshToken(store, provider, tokens.refreshToken);
  }
  const names = PROVIDER_COOKIES[provider];
  store.set(
    names.owner,
    createProviderOwnerSeal(provider, subject, secret),
    options(names.refreshMaxAge),
  );
}
