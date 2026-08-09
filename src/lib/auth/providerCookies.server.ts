import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { oauthPendingStateCookieName } from "@/lib/auth/directProviderCookies";
import {
  authenticatedOAuthPendingStateOrder,
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
  refreshGeneration: string;
  owner: string;
};

export type ProviderCredentialAttempt = {
  providerState: string;
  authorizationOrder: number;
};

export type MutableProviderCookieStore = {
  get(name: string): CookieValue;
  getAll?(): Array<{ name: string; value: string }>;
  set(name: string, value: string, options: CookieOptions): unknown;
  delete(name: string): unknown;
};

const PROVIDER_COOKIES: Record<DirectOAuthProvider, {
  access: string;
  refresh: string;
  refreshGeneration: string;
  owner: string;
  oauthPendingState: string;
  accessMaxAge: number;
  refreshMaxAge: number;
}> = {
  spotify: {
    access: "spotify_access_token",
    refresh: "spotify_refresh_token",
    refreshGeneration: "spotify_refresh_generation",
    owner: "spotify_token_owner",
    oauthPendingState: oauthPendingStateCookieName("spotify"),
    accessMaxAge: 60 * 60,
    refreshMaxAge: 60 * 60 * 24 * 30,
  },
  strava: {
    access: "strava_access_token",
    refresh: "strava_refresh_token",
    refreshGeneration: "strava_refresh_generation",
    owner: "strava_token_owner",
    oauthPendingState: oauthPendingStateCookieName("strava"),
    accessMaxAge: 6 * 60 * 60,
    refreshMaxAge: 60 * 60 * 24 * 90,
  },
};

const OWNER_SEAL_VERSION = 1;
const OWNER_SEAL_PREFIX = `po${OWNER_SEAL_VERSION}_`;
const OWNER_SEAL_PATTERN = /^po1_[A-Za-z0-9_-]{43}$/;
const OAUTH_ATTEMPT_VERSION = 1;
const OAUTH_PROVIDER_STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CREDENTIAL_ATTEMPT_VERSION = 1;
const CREDENTIAL_ATTEMPT_OWNER_PATTERN = /^pa1_([0-9a-z]+)_([A-Za-z0-9_-]{43})$/;
const CREDENTIAL_CUTOFF_VERSION = 1;
const CREDENTIAL_CUTOFF_SUFFIX_PATTERN = /^([0-9a-z]+)_([a-f0-9]{16})$/;
const CREDENTIAL_CUTOFF_VALUE_PATTERN = /^pc1_[A-Za-z0-9_-]{43}$/;
const CREDENTIAL_CUTOFF_MAX_AGE = 60 * 60 * 24 * 365;
const REFRESH_REJECTION_VERSION = 1;
const REFRESH_REJECTION_VALUE_PATTERN = /^pr1_[A-Za-z0-9_-]{43}$/;
const REFRESH_GENERATION_VERSION = 1;
const REFRESH_GENERATION_PATTERN = /^rg1_([A-Za-z0-9_-]{22})_([A-Za-z0-9_-]{43})$/;

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
  providerState: string,
): void {
  const name = oauthPendingAttemptCookieName(provider, providerState);
  if (!name) throw new Error("OAUTH_PENDING_COOKIE_STATE_INVALID");
  store.set(
    name,
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

export function peekOAuthPendingStateCookieForAttempt(
  store: MutableProviderCookieStore,
  provider: DirectOAuthProvider,
  providerState: string | null,
): string | null {
  const name = oauthPendingAttemptCookieName(provider, providerState);
  if (!name) return null;
  return store.get(name)?.value ?? null;
}

/** Consumes only the cookie for the exact public OAuth attempt nonce. */
export function consumeOAuthPendingStateCookieForAttempt(
  store: MutableProviderCookieStore,
  provider: DirectOAuthProvider,
  providerState: string | null,
): string | null {
  const name = oauthPendingAttemptCookieName(provider, providerState);
  if (!name) return null;
  const sealedState = peekOAuthPendingStateCookieForAttempt(store, provider, providerState);
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

function oauthPendingAttemptCookieName(
  provider: DirectOAuthProvider,
  providerState: string | null,
): string | null {
  if (!providerState || !OAUTH_PROVIDER_STATE_PATTERN.test(providerState)) return null;
  const config = PROVIDER_COOKIES[provider];
  return `${config.oauthPendingState}_a${OAUTH_ATTEMPT_VERSION}_${providerState}`;
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
    refreshGeneration: `${config.refreshGeneration}_s${OWNER_SEAL_VERSION}_${slot}`,
    owner: `${config.owner}_s${OWNER_SEAL_VERSION}_${slot}`,
  };
}

function createProviderRefreshGeneration(
  provider: DirectOAuthProvider,
  subject: string,
  secret: string,
  slotName: string,
  nonce = randomBytes(16).toString("base64url"),
): string {
  if (
    !isProfileSubject(subject) ||
    !secret ||
    !slotName ||
    !/^[A-Za-z0-9_-]{22}$/.test(nonce)
  ) {
    throw new Error("PROVIDER_REFRESH_GENERATION_INPUT_INVALID");
  }
  const digest = createHmac("sha256", ownerSealKey(secret, provider))
    .update(
      `axis:direct-provider-refresh-generation:v${REFRESH_GENERATION_VERSION}\0${subject}\0${slotName}\0${nonce}`,
    )
    .digest("base64url");
  return `rg${REFRESH_GENERATION_VERSION}_${nonce}_${digest}`;
}

function validProviderRefreshGeneration(
  supplied: string | undefined,
  provider: DirectOAuthProvider,
  subject: string,
  secret: string,
  slotName: string,
): string | null {
  const match = supplied?.match(REFRESH_GENERATION_PATTERN);
  if (!match?.[1]) return null;
  const expected = createProviderRefreshGeneration(
    provider,
    subject,
    secret,
    slotName,
    match[1],
  );
  const suppliedBytes = Buffer.from(supplied!);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.length === expectedBytes.length &&
    timingSafeEqual(suppliedBytes, expectedBytes)
    ? supplied!
    : null;
}

function providerRefreshRejectionCookiePrefix(
  provider: DirectOAuthProvider,
  subject: string,
  secret: string,
): string {
  return `${PROVIDER_COOKIES[provider].owner}_refresh_rejected_v${REFRESH_REJECTION_VERSION}_${subjectCookieSlot(provider, subject, secret)}_`;
}

function providerRefreshRejectionDigest(
  provider: DirectOAuthProvider,
  subject: string,
  secret: string,
  refreshToken: string,
  refreshGeneration: string,
  attempt?: ProviderCredentialAttempt,
): string {
  if (
    !isProfileSubject(subject) ||
    !secret ||
    !refreshToken ||
    !refreshGeneration ||
    (attempt && (
      !OAUTH_PROVIDER_STATE_PATTERN.test(attempt.providerState) ||
      !Number.isSafeInteger(attempt.authorizationOrder) ||
      attempt.authorizationOrder < 0
    ))
  ) {
    throw new Error("PROVIDER_REFRESH_REJECTION_INPUT_INVALID");
  }
  const generation = attempt
    ? `${attempt.authorizationOrder.toString(36)}:${attempt.providerState}`
    : "subject-slot";
  return createHmac("sha256", ownerSealKey(secret, provider))
    .update(
      `axis:direct-provider-refresh-rejection:v${REFRESH_REJECTION_VERSION}\0${subject}\0${generation}\0${refreshGeneration}\0${refreshToken}`,
    )
    .digest("base64url");
}

function providerRefreshRejectionCookieName(
  provider: DirectOAuthProvider,
  subject: string,
  secret: string,
  refreshToken: string,
  refreshGeneration: string,
  attempt?: ProviderCredentialAttempt,
): string {
  const digest = providerRefreshRejectionDigest(
    provider,
    subject,
    secret,
    refreshToken,
    refreshGeneration,
    attempt,
  );
  return `${providerRefreshRejectionCookiePrefix(provider, subject, secret)}${digest.slice(0, 22)}`;
}

function createProviderRefreshRejectionValue(
  provider: DirectOAuthProvider,
  subject: string,
  secret: string,
  refreshToken: string,
  refreshGeneration: string,
  attempt?: ProviderCredentialAttempt,
): string {
  return `pr${REFRESH_REJECTION_VERSION}_${providerRefreshRejectionDigest(
    provider,
    subject,
    secret,
    refreshToken,
    refreshGeneration,
    attempt,
  )}`;
}

function attemptCredentialCookieNames(
  provider: DirectOAuthProvider,
  providerState: string,
): CredentialCookieNames {
  if (!OAUTH_PROVIDER_STATE_PATTERN.test(providerState)) {
    throw new Error("PROVIDER_CREDENTIAL_ATTEMPT_INVALID");
  }
  const config = PROVIDER_COOKIES[provider];
  const suffix = `_a${CREDENTIAL_ATTEMPT_VERSION}_${providerState}`;
  return {
    access: `${config.access}${suffix}`,
    refresh: `${config.refresh}${suffix}`,
    refreshGeneration: `${config.refreshGeneration}${suffix}`,
    owner: `${config.owner}${suffix}`,
  };
}

function createProviderAttemptOwnerSeal(
  provider: DirectOAuthProvider,
  subject: string,
  secret: string,
  attempt: ProviderCredentialAttempt,
): string {
  if (
    !isProfileSubject(subject) ||
    !secret ||
    !OAUTH_PROVIDER_STATE_PATTERN.test(attempt.providerState) ||
    !Number.isSafeInteger(attempt.authorizationOrder) ||
    attempt.authorizationOrder < 0
  ) {
    throw new Error("PROVIDER_ATTEMPT_OWNER_SEAL_INPUT_INVALID");
  }
  const encodedOrder = attempt.authorizationOrder.toString(36);
  const digest = createHmac("sha256", ownerSealKey(secret, provider))
    .update(
      `axis:direct-provider-attempt-owner:v${CREDENTIAL_ATTEMPT_VERSION}\0${subject}\0${attempt.providerState}\0${encodedOrder}`,
    )
    .digest("base64url");
  return `pa${CREDENTIAL_ATTEMPT_VERSION}_${encodedOrder}_${digest}`;
}

function validProviderAttemptOwnerSeal(
  supplied: string | undefined,
  provider: DirectOAuthProvider,
  subject: string,
  secret: string,
  providerState: string,
): ProviderCredentialAttempt | null {
  const match = supplied?.match(CREDENTIAL_ATTEMPT_OWNER_PATTERN);
  if (!match || !match[1] || !match[2]) return null;
  const authorizationOrder = Number.parseInt(match[1], 36);
  if (!Number.isSafeInteger(authorizationOrder) || authorizationOrder < 0) return null;
  const attempt = { providerState, authorizationOrder };
  const expected = createProviderAttemptOwnerSeal(
    provider,
    subject,
    secret,
    attempt,
  );
  const suppliedBytes = Buffer.from(supplied!);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.length === expectedBytes.length &&
    timingSafeEqual(suppliedBytes, expectedBytes)
    ? attempt
    : null;
}

function credentialCutoffPrefix(
  provider: DirectOAuthProvider,
  subject: string,
  secret: string,
): string {
  return `${PROVIDER_COOKIES[provider].owner}_cut${CREDENTIAL_CUTOFF_VERSION}_${subjectCookieSlot(provider, subject, secret)}_`;
}

function createCredentialCutoffValue(
  provider: DirectOAuthProvider,
  subject: string,
  secret: string,
  suffix: string,
): string {
  if (!isProfileSubject(subject) || !secret || !CREDENTIAL_CUTOFF_SUFFIX_PATTERN.test(suffix)) {
    throw new Error("PROVIDER_CREDENTIAL_CUTOFF_INPUT_INVALID");
  }
  const digest = createHmac("sha256", ownerSealKey(secret, provider))
    .update(
      `axis:direct-provider-credential-cutoff:v${CREDENTIAL_CUTOFF_VERSION}\0${subject}\0${suffix}`,
    )
    .digest("base64url");
  return `pc${CREDENTIAL_CUTOFF_VERSION}_${digest}`;
}

function providerCredentialCutoffForSubject(
  store: MutableProviderCookieStore,
  provider: DirectOAuthProvider,
  subject: string,
  secret: string,
): number | null {
  const prefix = credentialCutoffPrefix(provider, subject, secret);
  const valid: Array<{ name: string; cutoffOrder: number }> = [];
  for (const cookie of store.getAll?.() ?? []) {
    if (!cookie.name.startsWith(prefix)) continue;
    const suffix = cookie.name.slice(prefix.length);
    const match = suffix.match(CREDENTIAL_CUTOFF_SUFFIX_PATTERN);
    if (!match || !match[1] || !CREDENTIAL_CUTOFF_VALUE_PATTERN.test(cookie.value)) {
      continue;
    }
    const cutoffOrder = Number.parseInt(match[1], 36);
    if (!Number.isSafeInteger(cutoffOrder) || cutoffOrder < 0) continue;
    const expected = createCredentialCutoffValue(
      provider,
      subject,
      secret,
      suffix,
    );
    const suppliedBytes = Buffer.from(cookie.value);
    const expectedBytes = Buffer.from(expected);
    if (
      suppliedBytes.length === expectedBytes.length &&
      timingSafeEqual(suppliedBytes, expectedBytes)
    ) {
      valid.push({ name: cookie.name, cutoffOrder });
    }
  }
  valid.sort((left, right) => right.cutoffOrder - left.cutoffOrder);
  const newest = valid[0];
  if (!newest) return null;
  for (const stale of valid.slice(1)) {
    store.delete(stale.name);
  }
  return newest.cutoffOrder;
}

function appendProviderCredentialCutoff(
  store: MutableProviderCookieStore,
  provider: DirectOAuthProvider,
  subject: string,
  secret: string,
  cutoffOrder: number,
): number {
  if (!Number.isSafeInteger(cutoffOrder) || cutoffOrder < 0) {
    throw new Error("PROVIDER_CREDENTIAL_CUTOFF_ORDER_INVALID");
  }
  const suffix = `${cutoffOrder.toString(36)}_${randomBytes(8).toString("hex")}`;
  store.set(
    `${credentialCutoffPrefix(provider, subject, secret)}${suffix}`,
    createCredentialCutoffValue(provider, subject, secret, suffix),
    options(CREDENTIAL_CUTOFF_MAX_AGE),
  );
  return cutoffOrder;
}

function providerCredentialCutoffBoundaryForSubject(
  store: MutableProviderCookieStore,
  provider: DirectOAuthProvider,
  subject: string,
  secret: string,
): number {
  let cutoffOrder = Math.max(
    Date.now(),
    providerCredentialCutoffForSubject(store, provider, subject, secret) ?? 0,
  );
  const config = PROVIDER_COOKIES[provider];
  const credentialOwnerPrefix = `${config.owner}_a${CREDENTIAL_ATTEMPT_VERSION}_`;
  const pendingPrefix = `${config.oauthPendingState}_a${OAUTH_ATTEMPT_VERSION}_`;
  for (const cookie of store.getAll?.() ?? []) {
    if (cookie.name.startsWith(credentialOwnerPrefix)) {
      const providerState = cookie.name.slice(credentialOwnerPrefix.length);
      const attempt = validProviderAttemptOwnerSeal(
        cookie.value,
        provider,
        subject,
        secret,
        providerState,
      );
      if (attempt) cutoffOrder = Math.max(cutoffOrder, attempt.authorizationOrder);
      continue;
    }
    if (cookie.name.startsWith(pendingPrefix)) {
      const providerState = cookie.name.slice(pendingPrefix.length);
      const authorizationOrder = authenticatedOAuthPendingStateOrder({
        provider,
        subject,
        secret,
        sealedState: cookie.value,
        providerState,
      });
      if (authorizationOrder !== null) {
        cutoffOrder = Math.max(cutoffOrder, authorizationOrder);
      }
    }
  }
  const legacyAuthorizationOrder = authenticatedOAuthPendingStateOrder({
    provider,
    subject,
    secret,
    sealedState: store.get(config.oauthPendingState)?.value ?? null,
  });
  return legacyAuthorizationOrder === null
    ? cutoffOrder
    : Math.max(cutoffOrder, legacyAuthorizationOrder);
}

export function nextProviderAuthorizationOrder(
  store: MutableProviderCookieStore,
  provider: DirectOAuthProvider,
  subject: string,
  secret: string,
): number {
  const boundary = providerCredentialCutoffBoundaryForSubject(
    store,
    provider,
    subject,
    secret,
  );
  if (boundary >= Number.MAX_SAFE_INTEGER) {
    throw new Error("PROVIDER_AUTHORIZATION_TIME_EXHAUSTED");
  }
  return boundary + 1;
}

function providerAttemptCredentialsForSubject(
  store: MutableProviderCookieStore,
  provider: DirectOAuthProvider,
  subject: string,
  secret: string,
  cutoffOrder: number | null,
): {
  accessToken: string | null;
  refreshToken: string | null;
  credentialAttempt: ProviderCredentialAttempt;
} | null {
  const ownerPrefix = `${PROVIDER_COOKIES[provider].owner}_a${CREDENTIAL_ATTEMPT_VERSION}_`;
  const candidates: Array<{
    names: CredentialCookieNames;
    accessToken: string | null;
    refreshToken: string | null;
    credentialAttempt: ProviderCredentialAttempt;
  }> = [];
  for (const cookie of store.getAll?.() ?? []) {
    if (!cookie.name.startsWith(ownerPrefix)) continue;
    const providerState = cookie.name.slice(ownerPrefix.length);
    if (!OAUTH_PROVIDER_STATE_PATTERN.test(providerState)) continue;
    const credentialAttempt = validProviderAttemptOwnerSeal(
      cookie.value,
      provider,
      subject,
      secret,
      providerState,
    );
    if (!credentialAttempt) continue;
    const names = attemptCredentialCookieNames(provider, providerState);
    if (
      cutoffOrder !== null &&
      credentialAttempt.authorizationOrder <= cutoffOrder
    ) {
      clearCredentialCookiesByName(store, names);
      continue;
    }
    candidates.push({
      names,
      accessToken: store.get(names.access)?.value ?? null,
      refreshToken: store.get(names.refresh)?.value ?? null,
      credentialAttempt,
    });
  }
  candidates.sort((left, right) => {
    const timeOrder =
      right.credentialAttempt.authorizationOrder - left.credentialAttempt.authorizationOrder;
    if (timeOrder !== 0) return timeOrder;
    if (
      right.credentialAttempt.providerState ===
      left.credentialAttempt.providerState
    ) return 0;
    return right.credentialAttempt.providerState >
      left.credentialAttempt.providerState
      ? 1
      : -1;
  });
  const selected = candidates[0];
  if (!selected) return null;
  if (
    candidates[1]?.credentialAttempt.authorizationOrder ===
    selected.credentialAttempt.authorizationOrder
  ) {
    return {
      accessToken: null,
      refreshToken: null,
      credentialAttempt: selected.credentialAttempt,
    };
  }
  for (const stale of candidates.slice(1)) {
    clearCredentialCookiesByName(store, stale.names);
  }
  return {
    accessToken: selected.accessToken,
    refreshToken: selected.refreshToken,
    credentialAttempt: selected.credentialAttempt,
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
): {
  accessToken: string | null;
  refreshToken: string | null;
  credentialAttempt?: ProviderCredentialAttempt;
} {
  const credentialCutoffOrder = providerCredentialCutoffForSubject(
    store,
    provider,
    subject,
    secret,
  );
  const attemptCredentials = providerAttemptCredentialsForSubject(
    store,
    provider,
    subject,
    secret,
    credentialCutoffOrder,
  );
  if (attemptCredentials) return attemptCredentials;
  if (credentialCutoffOrder !== null) {
    return { accessToken: null, refreshToken: null };
  }
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

/**
 * Selects the exact subject's credential snapshot without scheduling any
 * response-cookie cleanup or migration. Refresh requests must use this reader:
 * a stale response cannot safely apply mutations selected before the provider
 * exchange finishes.
 */
export function peekProviderTokensForSubject(
  store: MutableProviderCookieStore,
  provider: DirectOAuthProvider,
  subject: string,
  secret: string,
): ReturnType<typeof providerTokensForSubject> {
  const readOnlyStore: MutableProviderCookieStore = {
    get: (name) => store.get(name),
    getAll: () => store.getAll?.() ?? [],
    set: () => undefined,
    delete: () => undefined,
  };
  return providerTokensForSubject(readOnlyStore, provider, subject, secret);
}

/** Returns a signed local refresh revision, or the legacy revision sentinel. */
export function providerRefreshGenerationForSubject(
  store: MutableProviderCookieStore,
  provider: DirectOAuthProvider,
  subject: string,
  secret: string,
  attempt?: ProviderCredentialAttempt,
): string {
  let names: CredentialCookieNames | null = null;
  if (attempt) {
    const attemptNames = attemptCredentialCookieNames(
      provider,
      attempt.providerState,
    );
    const verifiedAttempt = validProviderAttemptOwnerSeal(
      store.get(attemptNames.owner)?.value,
      provider,
      subject,
      secret,
      attempt.providerState,
    );
    if (
      verifiedAttempt?.authorizationOrder === attempt.authorizationOrder
    ) names = attemptNames;
  } else {
    const subjectNames = subjectCredentialCookieNames(provider, subject, secret);
    if (validOwnerSeal(
      store.get(subjectNames.owner)?.value,
      provider,
      subject,
      secret,
    )) {
      names = subjectNames;
    } else {
      const legacyNames = PROVIDER_COOKIES[provider];
      if (validOwnerSeal(
        store.get(legacyNames.owner)?.value,
        provider,
        subject,
        secret,
      )) names = legacyNames;
    }
  }
  if (!names) return "legacy";
  return validProviderRefreshGeneration(
    store.get(names.refreshGeneration)?.value,
    provider,
    subject,
    secret,
    names.owner,
  ) ?? "legacy";
}

/** True only for the exact signed refresh-token generation rejected upstream. */
export function providerRefreshRejectedForSubject(
  store: MutableProviderCookieStore,
  provider: DirectOAuthProvider,
  subject: string,
  secret: string,
  refreshToken: string,
  refreshGeneration: string,
  attempt?: ProviderCredentialAttempt,
): boolean {
  const supplied = store.get(
    providerRefreshRejectionCookieName(
      provider,
      subject,
      secret,
      refreshToken,
      refreshGeneration,
      attempt,
    ),
  )?.value;
  if (!REFRESH_REJECTION_VALUE_PATTERN.test(supplied ?? "")) return false;
  const expected = createProviderRefreshRejectionValue(
    provider,
    subject,
    secret,
    refreshToken,
    refreshGeneration,
    attempt,
  );
  const suppliedBytes = Buffer.from(supplied!);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.length === expectedBytes.length &&
    timingSafeEqual(suppliedBytes, expectedBytes);
}

/** Records a terminal rejection without deleting or exposing the token. */
export function markProviderRefreshRejectedForSubject(
  store: MutableProviderCookieStore,
  provider: DirectOAuthProvider,
  subject: string,
  secret: string,
  refreshToken: string,
  refreshGeneration: string,
  attempt?: ProviderCredentialAttempt,
): void {
  store.set(
    providerRefreshRejectionCookieName(
      provider,
      subject,
      secret,
      refreshToken,
      refreshGeneration,
      attempt,
    ),
    createProviderRefreshRejectionValue(
      provider,
      subject,
      secret,
      refreshToken,
      refreshGeneration,
      attempt,
    ),
    // Bound orphan markers to one access-token lifetime. This suppresses tight
    // retry loops without allowing rotated-token markers to accumulate for the
    // full refresh-token lifetime.
    options(PROVIDER_COOKIES[provider].accessMaxAge),
  );
}

/** A successful rotation supersedes any rejection marker in its response order. */
export function clearProviderRefreshRejectionForGeneration(
  store: MutableProviderCookieStore,
  provider: DirectOAuthProvider,
  subject: string,
  secret: string,
  refreshToken: string,
  refreshGeneration: string,
  attempt?: ProviderCredentialAttempt,
): void {
  store.delete(providerRefreshRejectionCookieName(
    provider,
    subject,
    secret,
    refreshToken,
    refreshGeneration,
    attempt,
  ));
}

function clearProviderRefreshRejectionsForSubject(
  store: MutableProviderCookieStore,
  provider: DirectOAuthProvider,
  subject: string,
  secret: string,
): void {
  const prefix = providerRefreshRejectionCookiePrefix(
    provider,
    subject,
    secret,
  );
  for (const cookie of store.getAll?.() ?? []) {
    if (cookie.name.startsWith(prefix)) store.delete(cookie.name);
  }
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
  const ownerPrefix = `${PROVIDER_COOKIES[provider].owner}_a${CREDENTIAL_ATTEMPT_VERSION}_`;
  for (const cookie of store.getAll?.() ?? []) {
    if (!cookie.name.startsWith(ownerPrefix)) continue;
    const providerState = cookie.name.slice(ownerPrefix.length);
    if (
      validProviderAttemptOwnerSeal(
        cookie.value,
        provider,
        subject,
        secret,
        providerState,
      )
    ) {
      clearCredentialCookiesByName(
        store,
        attemptCredentialCookieNames(provider, providerState),
      );
    }
  }
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
  clearProviderRefreshRejectionsForSubject(store, provider, subject, secret);
}

/** Clears exact-subject credentials and only pending attempts visible in this request snapshot. */
export function clearProviderTokenCookiesForSubject(
  store: MutableProviderCookieStore,
  provider: DirectOAuthProvider,
  subject: string,
  secret: string,
): void {
  const cutoffOrder = providerCredentialCutoffBoundaryForSubject(
    store,
    provider,
    subject,
    secret,
  );
  clearProviderCredentialCookiesForSubject(store, provider, subject, secret);
  const legacyNames = PROVIDER_COOKIES[provider];
  const attemptPrefix = `${legacyNames.oauthPendingState}_a${OAUTH_ATTEMPT_VERSION}_`;
  for (const cookie of store.getAll?.() ?? []) {
    if (
      cookie.name.startsWith(attemptPrefix) &&
      oauthPendingStateBelongsToSubject({
        provider,
        subject,
        secret,
        sealedState: cookie.value,
      })
    ) {
      store.delete(cookie.name);
    }
  }
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
  appendProviderCredentialCutoff(store, provider, subject, secret, cutoffOrder);
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
  store.delete(names.refreshGeneration);
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
    store.set(
      names.refreshGeneration,
      createProviderRefreshGeneration(
        provider,
        subject,
        secret,
        names.owner,
      ),
      options(config.refreshMaxAge),
    );
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
  clearProviderRefreshRejectionsForSubject(store, provider, subject, secret);
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

/** Publishes callback credentials only into the exact signed OAuth attempt. */
export function replaceProviderTokenCookiesForAttempt(
  store: MutableProviderCookieStore,
  provider: DirectOAuthProvider,
  tokens: { accessToken: string; refreshToken?: string; expiresIn?: unknown },
  subject: string,
  secret: string,
  attempt: ProviderCredentialAttempt,
  clearRejections = true,
): void {
  if (!isProfileSubject(subject) || !tokens.accessToken || !secret) {
    throw new Error("PROVIDER_TOKEN_COOKIE_INPUT_INVALID");
  }
  const names = attemptCredentialCookieNames(provider, attempt.providerState);
  const config = PROVIDER_COOKIES[provider];
  clearCredentialCookiesByName(store, names);
  store.set(
    names.access,
    tokens.accessToken,
    options(boundedMaxAge(tokens.expiresIn, config.accessMaxAge)),
  );
  if (tokens.refreshToken) {
    store.set(names.refresh, tokens.refreshToken, options(config.refreshMaxAge));
    store.set(
      names.refreshGeneration,
      createProviderRefreshGeneration(
        provider,
        subject,
        secret,
        names.owner,
      ),
      options(config.refreshMaxAge),
    );
  }
  store.set(
    names.owner,
    createProviderAttemptOwnerSeal(provider, subject, secret, attempt),
    options(config.refreshMaxAge),
  );
  if (clearRejections) {
    clearProviderRefreshRejectionsForSubject(store, provider, subject, secret);
  }
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
  attempt?: ProviderCredentialAttempt,
): void {
  if (!isProfileSubject(subject) || !tokens.accessToken || !secret) {
    throw new Error("PROVIDER_TOKEN_COOKIE_INPUT_INVALID");
  }
  if (attempt) {
    replaceProviderTokenCookiesForAttempt(
      store,
      provider,
      tokens,
      subject,
      secret,
      attempt,
      false,
    );
  } else {
    replaceCredentialCookiesByName(
      store,
      provider,
      subjectCredentialCookieNames(provider, subject, secret),
      tokens,
      subject,
      secret,
    );
  }
}
