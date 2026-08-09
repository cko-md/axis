import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { oauthPendingStateCookieName } from "@/lib/auth/directProviderCookies";
import {
  authenticatedOAuthPendingStateOrder,
  oauthPendingStateBelongsToSubject,
  type DirectOAuthProvider,
} from "@/lib/auth/oauthState.server";
import { isProfileSubject } from "@/lib/auth/profileSubject";
import {
  normalizeDirectProviderCookieKeyring,
  type DirectProviderCookieKey,
  type DirectProviderCookieKeyInput,
} from "@/lib/auth/directProviderKeyring.server";

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

const OWNER_SEAL_PATTERN = /^po([12])_[A-Za-z0-9_-]{43}$/;
const OAUTH_ATTEMPT_VERSION = 1;
const OAUTH_PROVIDER_STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CREDENTIAL_ATTEMPT_VERSION = 1;
const CREDENTIAL_ATTEMPT_OWNER_PATTERN = /^pa([12])_([0-9a-z]+)_([A-Za-z0-9_-]{43})$/;
const CREDENTIAL_CUTOFF_SUFFIX_PATTERN = /^([0-9a-z]+)_([a-f0-9]{16})$/;
const CREDENTIAL_CUTOFF_VALUE_PATTERN = /^pc([12])_[A-Za-z0-9_-]{43}$/;
const CREDENTIAL_CUTOFF_MAX_AGE = 60 * 60 * 24 * 365;
const REFRESH_REJECTION_VALUE_PATTERN = /^pr([12])_[A-Za-z0-9_-]{43}$/;
const REFRESH_GENERATION_PATTERN = /^rg([12])_([A-Za-z0-9_-]{22})_([A-Za-z0-9_-]{43})$/;

function cookieKeys(secret: DirectProviderCookieKeyInput): readonly DirectProviderCookieKey[] {
  const keyring = normalizeDirectProviderCookieKeyring(secret);
  return [keyring.current, ...keyring.legacy];
}

function currentCookieKey(secret: DirectProviderCookieKeyInput): DirectProviderCookieKey {
  return normalizeDirectProviderCookieKeyring(secret).current;
}

function sameCookieKey(
  left: DirectProviderCookieKey,
  right: DirectProviderCookieKey,
): boolean {
  return left.version === right.version && left.secret === right.secret;
}

function oauthSigningSecret(secret: DirectProviderCookieKeyInput): string {
  return normalizeDirectProviderCookieKeyring(secret).current.secret;
}

function oauthLegacySigningSecrets(
  secret: DirectProviderCookieKeyInput,
): readonly string[] {
  const keyring = normalizeDirectProviderCookieKeyring(secret);
  return keyring.legacy.map((key) => key.secret).filter((candidate, index, all) =>
    candidate !== keyring.current.secret && all.indexOf(candidate) === index);
}

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

function ownerSealKey(key: DirectProviderCookieKey, provider: DirectOAuthProvider): Buffer {
  return createHmac("sha256", key.secret)
    .update(`axis:direct-provider-owner:key:v${key.version}:${provider}`)
    .digest();
}

function subjectCookieSlot(
  provider: DirectOAuthProvider,
  subject: string,
  key: DirectProviderCookieKey,
): string {
  if (!isProfileSubject(subject) || !key.secret) {
    throw new Error("PROVIDER_CREDENTIAL_SLOT_INPUT_INVALID");
  }
  return createHmac("sha256", ownerSealKey(key, provider))
    .update(`axis:direct-provider-cookie-slot:v${key.version}\0${subject}`)
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
  secret: DirectProviderCookieKeyInput,
  key = currentCookieKey(secret),
): CredentialCookieNames {
  const config = PROVIDER_COOKIES[provider];
  const slot = subjectCookieSlot(provider, subject, key);
  return {
    access: `${config.access}_s${key.version}_${slot}`,
    refresh: `${config.refresh}_s${key.version}_${slot}`,
    refreshGeneration: `${config.refreshGeneration}_s${key.version}_${slot}`,
    owner: `${config.owner}_s${key.version}_${slot}`,
  };
}

function createProviderRefreshGeneration(
  provider: DirectOAuthProvider,
  subject: string,
  secret: DirectProviderCookieKeyInput,
  slotName: string,
  nonce = randomBytes(16).toString("base64url"),
  key = currentCookieKey(secret),
): string {
  if (
    !isProfileSubject(subject) ||
    !key.secret ||
    !slotName ||
    !/^[A-Za-z0-9_-]{22}$/.test(nonce)
  ) {
    throw new Error("PROVIDER_REFRESH_GENERATION_INPUT_INVALID");
  }
  const digest = createHmac("sha256", ownerSealKey(key, provider))
    .update(
      `axis:direct-provider-refresh-generation:v${key.version}\0${subject}\0${slotName}\0${nonce}`,
    )
    .digest("base64url");
  return `rg${key.version}_${nonce}_${digest}`;
}

function validProviderRefreshGeneration(
  supplied: string | undefined,
  provider: DirectOAuthProvider,
  subject: string,
  secret: DirectProviderCookieKeyInput,
  slotName: string,
): string | null {
  const match = supplied?.match(REFRESH_GENERATION_PATTERN);
  if (!match?.[1] || !match[2]) return null;
  const version = Number(match[1]);
  for (const key of cookieKeys(secret)) {
    if (key.version !== version) continue;
    const expected = createProviderRefreshGeneration(
      provider,
      subject,
      secret,
      slotName,
      match[2],
      key,
    );
    const suppliedBytes = Buffer.from(supplied!);
    const expectedBytes = Buffer.from(expected);
    if (suppliedBytes.length === expectedBytes.length &&
      timingSafeEqual(suppliedBytes, expectedBytes)) return supplied!;
  }
  return null;
}

function providerRefreshRejectionCookiePrefix(
  provider: DirectOAuthProvider,
  subject: string,
  secret: DirectProviderCookieKeyInput,
  key = currentCookieKey(secret),
): string {
  return `${PROVIDER_COOKIES[provider].owner}_refresh_rejected_v${key.version}_${subjectCookieSlot(provider, subject, key)}_`;
}

function providerRefreshRejectionDigest(
  provider: DirectOAuthProvider,
  subject: string,
  secret: DirectProviderCookieKeyInput,
  refreshToken: string,
  refreshGeneration: string,
  attempt?: ProviderCredentialAttempt,
  key = currentCookieKey(secret),
): string {
  if (
    !isProfileSubject(subject) ||
    !key.secret ||
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
  return createHmac("sha256", ownerSealKey(key, provider))
    .update(
      `axis:direct-provider-refresh-rejection:v${key.version}\0${subject}\0${generation}\0${refreshGeneration}\0${refreshToken}`,
    )
    .digest("base64url");
}

function providerRefreshRejectionCookieName(
  provider: DirectOAuthProvider,
  subject: string,
  secret: DirectProviderCookieKeyInput,
  refreshToken: string,
  refreshGeneration: string,
  attempt?: ProviderCredentialAttempt,
  key = currentCookieKey(secret),
): string {
  const digest = providerRefreshRejectionDigest(
    provider,
    subject,
    secret,
    refreshToken,
    refreshGeneration,
    attempt,
    key,
  );
  return `${providerRefreshRejectionCookiePrefix(provider, subject, secret, key)}${digest.slice(0, 22)}`;
}

function createProviderRefreshRejectionValue(
  provider: DirectOAuthProvider,
  subject: string,
  secret: DirectProviderCookieKeyInput,
  refreshToken: string,
  refreshGeneration: string,
  attempt?: ProviderCredentialAttempt,
  key = currentCookieKey(secret),
): string {
  return `pr${key.version}_${providerRefreshRejectionDigest(
    provider,
    subject,
    secret,
    refreshToken,
    refreshGeneration,
    attempt,
    key,
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
  secret: DirectProviderCookieKeyInput,
  attempt: ProviderCredentialAttempt,
  key = currentCookieKey(secret),
): string {
  if (
    !isProfileSubject(subject) ||
    !key.secret ||
    !OAUTH_PROVIDER_STATE_PATTERN.test(attempt.providerState) ||
    !Number.isSafeInteger(attempt.authorizationOrder) ||
    attempt.authorizationOrder < 0
  ) {
    throw new Error("PROVIDER_ATTEMPT_OWNER_SEAL_INPUT_INVALID");
  }
  const encodedOrder = attempt.authorizationOrder.toString(36);
  const digest = createHmac("sha256", ownerSealKey(key, provider))
    .update(
      `axis:direct-provider-attempt-owner:v${key.version}\0${subject}\0${attempt.providerState}\0${encodedOrder}`,
    )
    .digest("base64url");
  return `pa${key.version}_${encodedOrder}_${digest}`;
}

function verifiedProviderAttemptOwnerSeal(
  supplied: string | undefined,
  provider: DirectOAuthProvider,
  subject: string,
  secret: DirectProviderCookieKeyInput,
  providerState: string,
): { attempt: ProviderCredentialAttempt; key: DirectProviderCookieKey } | null {
  const match = supplied?.match(CREDENTIAL_ATTEMPT_OWNER_PATTERN);
  if (!match || !match[1] || !match[2] || !match[3]) return null;
  const version = Number(match[1]);
  const authorizationOrder = Number.parseInt(match[2], 36);
  if (!Number.isSafeInteger(authorizationOrder) || authorizationOrder < 0) return null;
  const attempt = { providerState, authorizationOrder };
  for (const key of cookieKeys(secret)) {
    if (key.version !== version) continue;
    const expected = createProviderAttemptOwnerSeal(
      provider,
      subject,
      secret,
      attempt,
      key,
    );
    const suppliedBytes = Buffer.from(supplied!);
    const expectedBytes = Buffer.from(expected);
    if (suppliedBytes.length === expectedBytes.length &&
      timingSafeEqual(suppliedBytes, expectedBytes)) return { attempt, key };
  }
  return null;
}

function validProviderAttemptOwnerSeal(
  supplied: string | undefined,
  provider: DirectOAuthProvider,
  subject: string,
  secret: DirectProviderCookieKeyInput,
  providerState: string,
): ProviderCredentialAttempt | null {
  return verifiedProviderAttemptOwnerSeal(
    supplied,
    provider,
    subject,
    secret,
    providerState,
  )?.attempt ?? null;
}

function credentialCutoffPrefix(
  provider: DirectOAuthProvider,
  subject: string,
  secret: DirectProviderCookieKeyInput,
  key = currentCookieKey(secret),
): string {
  return `${PROVIDER_COOKIES[provider].owner}_cut${key.version}_${subjectCookieSlot(provider, subject, key)}_`;
}

function createCredentialCutoffValue(
  provider: DirectOAuthProvider,
  subject: string,
  secret: DirectProviderCookieKeyInput,
  suffix: string,
  key = currentCookieKey(secret),
): string {
  if (!isProfileSubject(subject) || !key.secret || !CREDENTIAL_CUTOFF_SUFFIX_PATTERN.test(suffix)) {
    throw new Error("PROVIDER_CREDENTIAL_CUTOFF_INPUT_INVALID");
  }
  const digest = createHmac("sha256", ownerSealKey(key, provider))
    .update(
      `axis:direct-provider-credential-cutoff:v${key.version}\0${subject}\0${suffix}`,
    )
    .digest("base64url");
  return `pc${key.version}_${digest}`;
}

function providerCredentialCutoffForSubject(
  store: MutableProviderCookieStore,
  provider: DirectOAuthProvider,
  subject: string,
  secret: DirectProviderCookieKeyInput,
): number | null {
  const valid: Array<{
    name: string;
    cutoffOrder: number;
    key: DirectProviderCookieKey;
  }> = [];
  for (const key of cookieKeys(secret)) {
    const prefix = credentialCutoffPrefix(provider, subject, secret, key);
    for (const cookie of store.getAll?.() ?? []) {
      if (!cookie.name.startsWith(prefix)) continue;
      const suffix = cookie.name.slice(prefix.length);
      const match = suffix.match(CREDENTIAL_CUTOFF_SUFFIX_PATTERN);
      const valueMatch = cookie.value.match(CREDENTIAL_CUTOFF_VALUE_PATTERN);
      if (!match?.[1] || Number(valueMatch?.[1]) !== key.version) continue;
      const cutoffOrder = Number.parseInt(match[1], 36);
      if (!Number.isSafeInteger(cutoffOrder) || cutoffOrder < 0) continue;
      const expected = createCredentialCutoffValue(
        provider,
        subject,
        secret,
        suffix,
        key,
      );
      const suppliedBytes = Buffer.from(cookie.value);
      const expectedBytes = Buffer.from(expected);
      if (
        suppliedBytes.length === expectedBytes.length &&
        timingSafeEqual(suppliedBytes, expectedBytes)
      ) {
        valid.push({ name: cookie.name, cutoffOrder, key });
      }
    }
  }
  valid.sort((left, right) => right.cutoffOrder - left.cutoffOrder);
  const newest = valid[0];
  if (!newest) return null;
  const currentKey = currentCookieKey(secret);
  if (!sameCookieKey(newest.key, currentKey)) {
    appendProviderCredentialCutoff(
      store,
      provider,
      subject,
      secret,
      newest.cutoffOrder,
    );
  }
  for (const stale of valid) {
    if (!sameCookieKey(stale.key, currentKey) || stale !== newest) {
      store.delete(stale.name);
    }
  }
  return newest.cutoffOrder;
}

function appendProviderCredentialCutoff(
  store: MutableProviderCookieStore,
  provider: DirectOAuthProvider,
  subject: string,
  secret: DirectProviderCookieKeyInput,
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
  secret: DirectProviderCookieKeyInput,
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
        secret: oauthSigningSecret(secret),
        legacySecrets: oauthLegacySigningSecrets(secret),
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
    secret: oauthSigningSecret(secret),
    legacySecrets: oauthLegacySigningSecrets(secret),
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
  secret: DirectProviderCookieKeyInput,
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
  secret: DirectProviderCookieKeyInput,
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
    verifiedKey: DirectProviderCookieKey;
  }> = [];
  for (const cookie of store.getAll?.() ?? []) {
    if (!cookie.name.startsWith(ownerPrefix)) continue;
    const providerState = cookie.name.slice(ownerPrefix.length);
    if (!OAUTH_PROVIDER_STATE_PATTERN.test(providerState)) continue;
    const verifiedOwner = verifiedProviderAttemptOwnerSeal(
      cookie.value,
      provider,
      subject,
      secret,
      providerState,
    );
    if (!verifiedOwner) continue;
    const credentialAttempt = verifiedOwner.attempt;
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
      verifiedKey: verifiedOwner.key,
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
    selected.accessToken &&
    !sameCookieKey(selected.verifiedKey, currentCookieKey(secret))
  ) {
    replaceProviderTokenCookiesForAttempt(
      store,
      provider,
      {
        accessToken: selected.accessToken,
        ...(selected.refreshToken ? { refreshToken: selected.refreshToken } : {}),
      },
      subject,
      secret,
      selected.credentialAttempt,
    );
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
  secret: DirectProviderCookieKeyInput,
  key = currentCookieKey(secret),
): string {
  if (!isProfileSubject(subject) || !key.secret) {
    throw new Error("PROVIDER_OWNER_SEAL_INPUT_INVALID");
  }
  const digest = createHmac("sha256", ownerSealKey(key, provider))
    .update(`axis:direct-provider-owner:subject:v${key.version}\0${subject}`)
    .digest("base64url");
  return `po${key.version}_${digest}`;
}

function verifiedOwnerSeal(
  supplied: string | undefined,
  provider: DirectOAuthProvider,
  subject: string,
  secret: DirectProviderCookieKeyInput,
): DirectProviderCookieKey | null {
  const match = supplied?.match(OWNER_SEAL_PATTERN);
  if (!match?.[1] || !isProfileSubject(subject)) {
    return null;
  }
  const version = Number(match[1]);
  for (const key of cookieKeys(secret)) {
    if (key.version !== version) continue;
    const expected = createProviderOwnerSeal(provider, subject, secret, key);
    const suppliedBytes = Buffer.from(supplied!);
    const expectedBytes = Buffer.from(expected);
    if (suppliedBytes.length === expectedBytes.length &&
      timingSafeEqual(suppliedBytes, expectedBytes)) return key;
  }
  return null;
}

function validOwnerSeal(
  supplied: string | undefined,
  provider: DirectOAuthProvider,
  subject: string,
  secret: DirectProviderCookieKeyInput,
): boolean {
  return verifiedOwnerSeal(supplied, provider, subject, secret) !== null;
}

function clearObsoleteAuthenticatedCredentialCopies(
  store: MutableProviderCookieStore,
  provider: DirectOAuthProvider,
  subject: string,
  secret: DirectProviderCookieKeyInput,
): void {
  const currentKey = currentCookieKey(secret);
  for (const key of cookieKeys(secret)) {
    if (sameCookieKey(key, currentKey)) continue;
    const names = subjectCredentialCookieNames(provider, subject, secret, key);
    const verifiedKey = verifiedOwnerSeal(
      store.get(names.owner)?.value,
      provider,
      subject,
      secret,
    );
    if (verifiedKey && sameCookieKey(verifiedKey, key)) {
      clearCredentialCookiesByName(store, names);
    }
  }
  const sharedNames = PROVIDER_COOKIES[provider];
  if (currentKey.version === 2 && validOwnerSeal(
    store.get(sharedNames.owner)?.value,
    provider,
    subject,
    secret,
  )) {
    clearProviderCredentialCookies(store, provider);
  }
}

export function providerTokensForSubject(
  store: MutableProviderCookieStore,
  provider: DirectOAuthProvider,
  subject: string,
  secret: DirectProviderCookieKeyInput,
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
  for (const key of cookieKeys(secret)) {
    const slotNames = subjectCredentialCookieNames(provider, subject, secret, key);
    const slotOwner = store.get(slotNames.owner)?.value;
    const slotAccessToken = store.get(slotNames.access)?.value ?? null;
    const slotRefreshToken = store.get(slotNames.refresh)?.value ?? null;
    const verifiedKey = verifiedOwnerSeal(slotOwner, provider, subject, secret);
    if (verifiedKey && sameCookieKey(verifiedKey, key)) {
      const currentKey = currentCookieKey(secret);
      if (
        !sameCookieKey(key, currentKey) &&
        slotAccessToken
      ) {
        const currentNames = subjectCredentialCookieNames(provider, subject, secret);
        replaceCredentialCookiesByName(
          store,
          provider,
          currentNames,
          {
            accessToken: slotAccessToken,
            ...(slotRefreshToken ? { refreshToken: slotRefreshToken } : {}),
          },
          subject,
          secret,
        );
        clearCredentialCookiesByName(store, slotNames);
      }
      clearObsoleteAuthenticatedCredentialCopies(
        store,
        provider,
        subject,
        secret,
      );
      return {
        accessToken: slotAccessToken,
        refreshToken: slotRefreshToken,
      };
    }
    if (slotOwner || slotAccessToken || slotRefreshToken) {
      clearCredentialCookiesByName(store, slotNames);
    }
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
    const currentSlotNames = subjectCredentialCookieNames(
      provider,
      subject,
      secret,
    );
    replaceCredentialCookiesByName(
      store,
      provider,
      currentSlotNames,
      { accessToken, ...(refreshToken ? { refreshToken } : {}) },
      subject,
      secret,
    );
    clearProviderCredentialCookies(store, provider);
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
  secret: DirectProviderCookieKeyInput,
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
  secret: DirectProviderCookieKeyInput,
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
    for (const key of cookieKeys(secret)) {
      const subjectNames = subjectCredentialCookieNames(
        provider,
        subject,
        secret,
        key,
      );
      const verifiedKey = verifiedOwnerSeal(
        store.get(subjectNames.owner)?.value,
        provider,
        subject,
        secret,
      );
      if (verifiedKey && sameCookieKey(verifiedKey, key)) {
        names = subjectNames;
        break;
      }
    }
    if (!names) {
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
  secret: DirectProviderCookieKeyInput,
  refreshToken: string,
  refreshGeneration: string,
  attempt?: ProviderCredentialAttempt,
): boolean {
  for (const key of cookieKeys(secret)) {
    const supplied = store.get(
      providerRefreshRejectionCookieName(
        provider,
        subject,
        secret,
        refreshToken,
        refreshGeneration,
        attempt,
        key,
      ),
    )?.value;
    const match = supplied?.match(REFRESH_REJECTION_VALUE_PATTERN);
    if (Number(match?.[1]) !== key.version) continue;
    const expected = createProviderRefreshRejectionValue(
      provider,
      subject,
      secret,
      refreshToken,
      refreshGeneration,
      attempt,
      key,
    );
    const suppliedBytes = Buffer.from(supplied!);
    const expectedBytes = Buffer.from(expected);
    if (suppliedBytes.length === expectedBytes.length &&
      timingSafeEqual(suppliedBytes, expectedBytes)) {
      const currentKey = currentCookieKey(secret);
      if (!sameCookieKey(key, currentKey)) {
        markProviderRefreshRejectedForSubject(
          store,
          provider,
          subject,
          secret,
          refreshToken,
          refreshGeneration,
          attempt,
        );
        store.delete(providerRefreshRejectionCookieName(
          provider,
          subject,
          secret,
          refreshToken,
          refreshGeneration,
          attempt,
          key,
        ));
      }
      return true;
    }
  }
  return false;
}

/** Records a terminal rejection without deleting or exposing the token. */
export function markProviderRefreshRejectedForSubject(
  store: MutableProviderCookieStore,
  provider: DirectOAuthProvider,
  subject: string,
  secret: DirectProviderCookieKeyInput,
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
  secret: DirectProviderCookieKeyInput,
  refreshToken: string,
  refreshGeneration: string,
  attempt?: ProviderCredentialAttempt,
): void {
  for (const key of cookieKeys(secret)) {
    store.delete(providerRefreshRejectionCookieName(
      provider,
      subject,
      secret,
      refreshToken,
      refreshGeneration,
      attempt,
      key,
    ));
  }
}

function clearProviderRefreshRejectionsForSubject(
  store: MutableProviderCookieStore,
  provider: DirectOAuthProvider,
  subject: string,
  secret: DirectProviderCookieKeyInput,
): void {
  for (const key of cookieKeys(secret)) {
    const prefix = providerRefreshRejectionCookiePrefix(
      provider,
      subject,
      secret,
      key,
    );
    for (const cookie of store.getAll?.() ?? []) {
      if (cookie.name.startsWith(prefix)) store.delete(cookie.name);
    }
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
  secret: DirectProviderCookieKeyInput,
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
  for (const key of cookieKeys(secret)) {
    clearCredentialCookiesByName(
      store,
      subjectCredentialCookieNames(provider, subject, secret, key),
    );
  }
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
  secret: DirectProviderCookieKeyInput,
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
        secret: oauthSigningSecret(secret),
        legacySecrets: oauthLegacySigningSecrets(secret),
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
      secret: oauthSigningSecret(secret),
      legacySecrets: oauthLegacySigningSecrets(secret),
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
  secret: DirectProviderCookieKeyInput,
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
  secret: DirectProviderCookieKeyInput,
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
  secret: DirectProviderCookieKeyInput,
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
  secret: DirectProviderCookieKeyInput,
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
    clearObsoleteAuthenticatedCredentialCopies(
      store,
      provider,
      subject,
      secret,
    );
  }
}
