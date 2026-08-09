import { createHmac, timingSafeEqual } from "node:crypto";
import { oauthPendingStateCookieName } from "@/lib/auth/directProviderCookies";
import {
  oauthPendingStateBelongsToSubject,
  type DirectOAuthProvider,
} from "@/lib/auth/oauthState.server";
import { isProfileSubject } from "@/lib/auth/profileSubject";

type CookieValue = { value: string } | undefined;
type CookieOptions = {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  maxAge: number;
  path: "/";
};

type CredentialCookieNames = {
  access: string;
  refresh: string;
  owner: string;
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
  subject: string,
  secret: string,
): void {
  store.set(
    subjectOAuthPendingStateCookieName(provider, subject, secret),
    sealedState,
    options(maxAge),
  );
}

/** Reads the legacy shared pending-state cookie without mutating browser state. */
export function peekOAuthPendingStateCookie(
  store: MutableProviderCookieStore,
  provider: DirectOAuthProvider,
): string | null {
  return store.get(PROVIDER_COOKIES[provider].oauthPendingState)?.value ?? null;
}

export function consumeOAuthPendingStateCookie(
  store: MutableProviderCookieStore,
  provider: DirectOAuthProvider,
): string | null {
  const name = PROVIDER_COOKIES[provider].oauthPendingState;
  const sealedState = peekOAuthPendingStateCookie(store, provider);
  store.delete(name);
  return sealedState;
}

export function peekOAuthPendingStateCookieForSubject(
  store: MutableProviderCookieStore,
  provider: DirectOAuthProvider,
  subject: string,
  secret: string,
): string | null {
  const name = subjectOAuthPendingStateCookieName(provider, subject, secret);
  return store.get(name)?.value ?? null;
}

/** Consumes only the deterministic pending-state slot for the exact subject. */
export function consumeOAuthPendingStateCookieForSubject(
  store: MutableProviderCookieStore,
  provider: DirectOAuthProvider,
  subject: string,
  secret: string,
): string | null {
  const name = subjectOAuthPendingStateCookieName(provider, subject, secret);
  const sealedState = peekOAuthPendingStateCookieForSubject(
    store,
    provider,
    subject,
    secret,
  );
  store.delete(name);
  return sealedState;
}

function ownerSealKey(secret: string, provider: DirectOAuthProvider): Buffer {
  return createHmac("sha256", secret)
    .update(`axis:direct-provider-owner:key:v${OWNER_SEAL_VERSION}:${provider}`)
    .digest();
}

function subjectCookieSlot(
  provider: DirectOAuthProvider,
  subject: string,
  secret: string,
): string {
  if (!isProfileSubject(subject) || !secret) {
    throw new Error("PROVIDER_CREDENTIAL_SLOT_INPUT_INVALID");
  }
  return createHmac("sha256", ownerSealKey(secret, provider))
    .update(`axis:direct-provider-cookie-slot:v${OWNER_SEAL_VERSION}\0${subject}`)
    .digest("hex")
    .slice(0, 24);
}

function subjectOAuthPendingStateCookieName(
  provider: DirectOAuthProvider,
  subject: string,
  secret: string,
): string {
  const config = PROVIDER_COOKIES[provider];
  return `${config.oauthPendingState}_s${OWNER_SEAL_VERSION}_${subjectCookieSlot(provider, subject, secret)}`;
}

function subjectCredentialCookieNames(
  provider: DirectOAuthProvider,
  subject: string,
  secret: string,
): CredentialCookieNames {
  const config = PROVIDER_COOKIES[provider];
  const slot = subjectCookieSlot(provider, subject, secret);
  return {
    access: `${config.access}_s${OWNER_SEAL_VERSION}_${slot}`,
    refresh: `${config.refresh}_s${OWNER_SEAL_VERSION}_${slot}`,
    owner: `${config.owner}_s${OWNER_SEAL_VERSION}_${slot}`,
  };
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
  const slotNames = subjectCredentialCookieNames(provider, subject, secret);
  const slotOwner = store.get(slotNames.owner)?.value;
  const slotAccessToken = store.get(slotNames.access)?.value ?? null;
  const slotRefreshToken = store.get(slotNames.refresh)?.value ?? null;
  if (validOwnerSeal(slotOwner, provider, subject, secret)) {
    return {
      accessToken: slotAccessToken,
      refreshToken: slotRefreshToken,
    };
  }
  if (slotOwner || slotAccessToken || slotRefreshToken) {
    clearCredentialCookiesByName(store, slotNames);
  }

  // Legacy shared cookies are read only when they authenticate as this exact
  // subject. A mismatch may be another signed-in account's valid tuple, so it
  // must not be deleted by the current account.
  const legacyNames = PROVIDER_COOKIES[provider];
  const legacyOwner = store.get(legacyNames.owner)?.value;
  const accessToken = store.get(legacyNames.access)?.value ?? null;
  const refreshToken = store.get(legacyNames.refresh)?.value ?? null;
  if (!validOwnerSeal(legacyOwner, provider, subject, secret)) {
    return { accessToken: null, refreshToken: null };
  }
  if (accessToken) {
    replaceCredentialCookiesByName(
      store,
      provider,
      slotNames,
      { accessToken, ...(refreshToken ? { refreshToken } : {}) },
      subject,
      secret,
    );
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
  clearProviderCredentialCookies(store, provider);
  store.delete(names.oauthPendingState);
}

/** Clears only credential cookies authenticated as belonging to the exact subject. */
export function clearProviderCredentialCookiesForSubject(
  store: MutableProviderCookieStore,
  provider: DirectOAuthProvider,
  subject: string,
  secret: string,
): void {
  const slotNames = subjectCredentialCookieNames(provider, subject, secret);
  clearCredentialCookiesByName(store, slotNames);
  const legacyNames = PROVIDER_COOKIES[provider];
  const legacyOwner = store.get(legacyNames.owner)?.value;
  if (
    validOwnerSeal(legacyOwner, provider, subject, secret) ||
    legacyOwner === subject
  ) {
    clearProviderCredentialCookies(store, provider);
  }
}

/** Clears exact-subject credentials and pending OAuth state without cross-slot writes. */
export function clearProviderTokenCookiesForSubject(
  store: MutableProviderCookieStore,
  provider: DirectOAuthProvider,
  subject: string,
  secret: string,
): void {
  clearProviderCredentialCookiesForSubject(store, provider, subject, secret);
  store.delete(subjectOAuthPendingStateCookieName(provider, subject, secret));
  const legacyNames = PROVIDER_COOKIES[provider];
  const pendingState = store.get(legacyNames.oauthPendingState)?.value ?? null;
  if (
    oauthPendingStateBelongsToSubject({
      provider,
      subject,
      secret,
      sealedState: pendingState,
    })
  ) {
    store.delete(legacyNames.oauthPendingState);
  }
}

function clearProviderCredentialCookies(
  store: MutableProviderCookieStore,
  provider: DirectOAuthProvider,
): void {
  const names = PROVIDER_COOKIES[provider];
  clearCredentialCookiesByName(store, names);
}

function clearCredentialCookiesByName(
  store: MutableProviderCookieStore,
  names: CredentialCookieNames,
): void {
  store.delete(names.owner);
  store.delete(names.access);
  store.delete(names.refresh);
}

function replaceCredentialCookiesByName(
  store: MutableProviderCookieStore,
  provider: DirectOAuthProvider,
  names: CredentialCookieNames,
  tokens: { accessToken: string; refreshToken?: string; expiresIn?: unknown },
  subject: string,
  secret: string,
): void {
  const config = PROVIDER_COOKIES[provider];
  clearCredentialCookiesByName(store, names);
  store.set(
    names.access,
    tokens.accessToken,
    options(boundedMaxAge(tokens.expiresIn, config.accessMaxAge)),
  );
  if (tokens.refreshToken) {
    store.set(names.refresh, tokens.refreshToken, options(config.refreshMaxAge));
  }
  store.set(
    names.owner,
    createProviderOwnerSeal(provider, subject, secret),
    options(config.refreshMaxAge),
  );
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
  const subjectNames = subjectCredentialCookieNames(provider, subject, secret);
  replaceCredentialCookiesByName(
    store,
    provider,
    subjectNames,
    tokens,
    subject,
    secret,
  );
  const legacyNames = PROVIDER_COOKIES[provider];
  replaceCredentialCookiesByName(
    store,
    provider,
    legacyNames,
    tokens,
    subject,
    secret,
  );
}

/**
 * Refresh responses write only the authenticated subject's deterministic slot.
 * A late response from account A therefore cannot overwrite account B's tuple.
 */
export function replaceRefreshedProviderTokenCookies(
  store: MutableProviderCookieStore,
  provider: DirectOAuthProvider,
  tokens: { accessToken: string; refreshToken?: string; expiresIn?: unknown },
  subject: string,
  secret: string,
): void {
  if (!isProfileSubject(subject) || !tokens.accessToken || !secret) {
    throw new Error("PROVIDER_TOKEN_COOKIE_INPUT_INVALID");
  }
  replaceCredentialCookiesByName(
    store,
    provider,
    subjectCredentialCookieNames(provider, subject, secret),
    tokens,
    subject,
    secret,
  );
}
