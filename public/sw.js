/* VECTOR offline worker.
 *
 * This worker caches only explicitly declared, same-origin immutable Next
 * chunks, public /vector-assets/, and the minimal offline document. It never
 * caches APIs, auth, RSC, protected route HTML, Supabase/private assets, opaque
 * responses, or responses carrying Set-Cookie.
 */

const WORKER_PROTOCOL_VERSION = 3;
const SHELL_CACHE = "axis-vector-shell:v3";
const META_CACHE = "axis-vector-meta:v3";
const GAME_CACHE_PREFIX = "axis-vector-game:";
const STAGING_CACHE_PREFIX = "axis-vector-stage:";
const OFFLINE_DOCUMENT = "/vector-offline.html";
const MANIFEST_PREFIX = "/vector-assets/manifests/";
const BUILD_MAP_URL = "/vector-assets/manifests/build-map.json";
const OFFLINE_ENTRY_PREFIX = "/vector-assets/offline/";
const MARKER_PATH = "/vector-assets/.installed/";
const CURRENT_PATH = "/vector-assets/.current/";
const MAX_ASSET_BYTES = 250 * 1024 * 1024;
const MAX_INSTALL_BYTES = 500 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const LEGACY_CACHE_PREFIXES = [
  "workbox-precache-v2-",
  "workbox-runtime-",
  "axis-vector-cache:",
];
const LEGACY_CACHE_NAMES = new Set([
  "start-url",
  "static-assets",
  "google-fonts",
  "api-cache",
  "pages-cache",
]);

const USER_MESSAGES = {
  VECTOR_OFFLINE_QUOTA_EXCEEDED: "There is not enough browser storage to install this game.",
  VECTOR_MANIFEST_NOT_ALLOWED: "This offline package manifest is not allowed.",
  VECTOR_MANIFEST_DIGEST_INVALID: "The offline package manifest reference is invalid.",
  VECTOR_MANIFEST_NOT_PUBLISHED: "This deploy does not publish the requested offline package.",
  OFFLINE_MANIFEST_DIGEST_MISMATCH: "The offline package manifest failed integrity verification.",
  OFFLINE_MANIFEST_RESPONSE_REJECTED: "The offline package manifest could not be verified.",
  INVALID_OFFLINE_MANIFEST: "The offline package manifest is invalid.",
  INVALID_OFFLINE_ASSET: "The offline package contains an invalid asset declaration.",
  DUPLICATE_OFFLINE_ASSET: "The offline package repeats an asset.",
  OFFLINE_SIZE_MISMATCH: "The offline package size does not match its manifest.",
  OFFLINE_ASSET_RESPONSE_REJECTED: "An offline asset could not be verified.",
  OFFLINE_ASSET_SIZE_MISMATCH: "An offline asset size does not match its manifest.",
  OFFLINE_ASSET_DIGEST_MISMATCH: "An offline asset failed integrity verification.",
  OFFLINE_STAGE_INCOMPLETE: "The staged offline package is incomplete.",
  INVALID_GAME_ID: "The requested game identifier is invalid.",
  VECTOR_WORKER_MESSAGE_INVALID: "The offline worker received an unsupported request.",
};

let operationQueue = Promise.resolve();

function runSerialized(work) {
  const pending = operationQueue.then(work, work);
  operationQueue = pending.then(() => undefined, () => undefined);
  return pending;
}

function reply(event, payload) {
  const port = event.ports && event.ports[0];
  if (!port) return;
  try {
    port.postMessage(payload);
  } catch {
    // The client may have navigated away after starting a durable cache action.
  }
}

function errorCode(error) {
  return error && typeof error.code === "string"
    ? error.code
    : "VECTOR_OFFLINE_FAILED";
}

function fail(event, error) {
  const quota = error && (
    error.name === "QuotaExceededError" ||
    error.code === 22 ||
    error.code === 1014
  );
  const code = quota ? "VECTOR_OFFLINE_QUOTA_EXCEEDED" : errorCode(error);
  reply(event, {
    ok: false,
    error: {
      code,
      message: USER_MESSAGES[code] || "The offline copy could not be completed.",
    },
  });
}

function parsedUrl(rawUrl) {
  try {
    return new URL(rawUrl, self.location.origin);
  } catch {
    return null;
  }
}

function isAllowedAssetUrl(rawUrl) {
  const url = parsedUrl(rawUrl);
  if (!url || url.origin !== self.location.origin || url.username || url.password || url.hash) {
    return false;
  }
  return (
    url.pathname === OFFLINE_DOCUMENT ||
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/vector-assets/")
  );
}

function isReservedMetadataUrl(rawUrl) {
  const url = parsedUrl(rawUrl);
  return Boolean(url && (
    url.pathname.startsWith(MARKER_PATH) ||
    url.pathname.startsWith(CURRENT_PATH)
  ));
}

function isAllowedOfflineEntryUrl(rawUrl) {
  const url = parsedUrl(rawUrl);
  return Boolean(
    url &&
    url.origin === self.location.origin &&
    !url.username &&
    !url.password &&
    !url.hash &&
    url.pathname.startsWith(OFFLINE_ENTRY_PREFIX) &&
    url.pathname.endsWith(".html"),
  );
}

function isAllowedManifestUrl(rawUrl) {
  const url = parsedUrl(rawUrl);
  return Boolean(
    url &&
    url.origin === self.location.origin &&
    !url.username &&
    !url.password &&
    !url.hash &&
    url.pathname.startsWith(MANIFEST_PREFIX) &&
    url.pathname.endsWith(".json"),
  );
}

function validIdentifier(value) {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function validVersion(value) {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(value);
}

function validBuildId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(value);
}

function validDigest(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

async function publishedManifestReference(manifestUrl, manifestSha256) {
  const request = new Request(new URL(BUILD_MAP_URL, self.location.origin), {
    credentials: "omit",
    cache: "no-store",
  });
  const response = await fetch(request);
  if (
    !response.ok ||
    response.type === "opaque" ||
    response.headers.has("Set-Cookie") ||
    (response.url && response.url !== request.url)
  ) {
    throw Object.assign(new Error("build map response rejected"), { code: "VECTOR_MANIFEST_NOT_PUBLISHED" });
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_MANIFEST_BYTES) {
    throw Object.assign(new Error("build map response too large"), { code: "VECTOR_MANIFEST_NOT_PUBLISHED" });
  }
  let value;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw Object.assign(new Error("build map JSON invalid"), { code: "VECTOR_MANIFEST_NOT_PUBLISHED" });
  }
  if (
    !value ||
    value.schemaVersion !== 1 ||
    !validBuildId(value.buildId) ||
    !Array.isArray(value.games) ||
    value.games.length > 100
  ) {
    throw Object.assign(new Error("build map invalid"), { code: "VECTOR_MANIFEST_NOT_PUBLISHED" });
  }
  const normalizedManifestUrl = new URL(manifestUrl, self.location.origin).href;
  const seenGames = new Set();
  let published = null;
  for (const candidate of value.games) {
    if (
      !candidate ||
      !validIdentifier(candidate.gameId) ||
      !validVersion(candidate.gameVersion) ||
      !validBuildId(candidate.buildId) ||
      candidate.buildId !== value.buildId ||
      !isAllowedManifestUrl(candidate.manifestUrl) ||
      !validDigest(candidate.manifestSha256) ||
      !isAllowedOfflineEntryUrl(candidate.offlineEntryUrl) ||
      !Number.isSafeInteger(candidate.estimatedBytes) ||
      candidate.estimatedBytes < 0 ||
      candidate.estimatedBytes > MAX_INSTALL_BYTES ||
      seenGames.has(candidate.gameId)
    ) {
      throw Object.assign(new Error("build map game invalid"), { code: "VECTOR_MANIFEST_NOT_PUBLISHED" });
    }
    seenGames.add(candidate.gameId);
    if (new URL(candidate.manifestUrl, self.location.origin).href === normalizedManifestUrl) {
      if (published) {
        throw Object.assign(new Error("build map manifest duplicated"), { code: "VECTOR_MANIFEST_NOT_PUBLISHED" });
      }
      published = candidate;
    }
  }
  if (!published) {
    throw Object.assign(new Error("manifest absent from build map"), { code: "VECTOR_MANIFEST_NOT_PUBLISHED" });
  }
  if (published.manifestSha256 !== manifestSha256) {
    throw Object.assign(new Error("manifest digest mismatch"), { code: "OFFLINE_MANIFEST_DIGEST_MISMATCH" });
  }
  return published;
}

function validateManifest(value) {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    !validIdentifier(value.gameId) ||
    !validVersion(value.gameVersion) ||
    !validBuildId(value.buildId) ||
    !isAllowedOfflineEntryUrl(value.offlineEntryUrl) ||
    !Number.isSafeInteger(value.estimatedBytes) ||
    value.estimatedBytes < 0 ||
    value.estimatedBytes > MAX_INSTALL_BYTES ||
    !Array.isArray(value.assets) ||
    value.assets.length < 1 ||
    value.assets.length > 500
  ) {
    throw Object.assign(new Error("invalid manifest"), { code: "INVALID_OFFLINE_MANIFEST" });
  }

  const seen = new Set();
  let bytes = 0;
  for (const asset of value.assets) {
    if (
      !asset ||
      typeof asset.url !== "string" ||
      !isAllowedAssetUrl(asset.url) ||
      isReservedMetadataUrl(asset.url) ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes < 0 ||
      asset.bytes > MAX_ASSET_BYTES ||
      !validDigest(asset.sha256)
    ) {
      throw Object.assign(new Error("invalid asset"), { code: "INVALID_OFFLINE_ASSET" });
    }
    const normalized = new URL(asset.url, self.location.origin).href;
    if (seen.has(normalized)) {
      throw Object.assign(new Error("duplicate asset"), { code: "DUPLICATE_OFFLINE_ASSET" });
    }
    seen.add(normalized);
    bytes += asset.bytes;
  }
  if (bytes !== value.estimatedBytes) {
    throw Object.assign(new Error("size mismatch"), { code: "OFFLINE_SIZE_MISMATCH" });
  }
  if (!seen.has(new URL(value.offlineEntryUrl, self.location.origin).href)) {
    throw Object.assign(new Error("offline entry missing"), { code: "INVALID_OFFLINE_MANIFEST" });
  }
  return value;
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function verifiedResponse(asset) {
  const request = new Request(new URL(asset.url, self.location.origin), {
    credentials: "omit",
    cache: "no-store",
  });
  const response = await fetch(request);
  if (
    !response.ok ||
    response.type === "opaque" ||
    response.headers.has("Set-Cookie") ||
    !isAllowedAssetUrl(response.url || request.url)
  ) {
    throw Object.assign(new Error("asset response rejected"), { code: "OFFLINE_ASSET_RESPONSE_REJECTED" });
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== asset.bytes) {
    throw Object.assign(new Error("asset size mismatch"), { code: "OFFLINE_ASSET_SIZE_MISMATCH" });
  }
  if (await sha256Hex(bytes) !== asset.sha256) {
    throw Object.assign(new Error("asset digest mismatch"), { code: "OFFLINE_ASSET_DIGEST_MISMATCH" });
  }
  const headers = new Headers();
  for (const name of [
    "Content-Type",
    "Cache-Control",
    "ETag",
    "Last-Modified",
    "Content-Language",
    "X-Content-Type-Options",
  ]) {
    const value = response.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set("Content-Length", String(bytes.byteLength));
  return new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function finalCacheName(manifest) {
  return `${GAME_CACHE_PREFIX}${manifest.gameId}:${manifest.gameVersion}:${manifest.buildId}`;
}

function markerUrl(gameId) {
  return new URL(`${MARKER_PATH}${encodeURIComponent(gameId)}.json`, self.location.origin).href;
}

function currentUrl(gameId) {
  return new URL(`${CURRENT_PATH}${encodeURIComponent(gameId)}.json`, self.location.origin).href;
}

function markerPayload(installed) {
  return {
    schemaVersion: 2,
    gameId: installed.gameId,
    gameVersion: installed.gameVersion,
    buildId: installed.buildId,
    offlineEntryUrl: installed.offlineEntryUrl,
    installedBytes: installed.installedBytes,
    installedAt: installed.installedAt,
    cacheName: installed.cacheName,
    assets: installed.assets,
  };
}

function validatedInstalledAssets(value, offlineEntryUrl, installedBytes) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 500) return null;
  const seen = new Set();
  const assets = [];
  let bytes = 0;
  for (const asset of value) {
    if (
      !asset ||
      typeof asset.url !== "string" ||
      !isAllowedAssetUrl(asset.url) ||
      isReservedMetadataUrl(asset.url) ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes < 0 ||
      asset.bytes > MAX_ASSET_BYTES ||
      !validDigest(asset.sha256)
    ) {
      return null;
    }
    const url = new URL(asset.url, self.location.origin).href;
    if (seen.has(url)) return null;
    seen.add(url);
    bytes += asset.bytes;
    assets.push({ url, bytes: asset.bytes, sha256: asset.sha256 });
  }
  if (bytes !== installedBytes || !seen.has(offlineEntryUrl)) return null;
  return assets.sort((left, right) => compareText(left.url, right.url));
}

async function readInstalled(cacheName) {
  if (!await caches.has(cacheName)) return null;
  const cache = await caches.open(cacheName);
  const markerRequests = (await cache.keys()).filter(
    (request) => new URL(request.url).pathname.startsWith(MARKER_PATH),
  );
  if (markerRequests.length !== 1) return null;
  const markerRequest = markerRequests[0];
  const response = await cache.match(markerRequest);
  if (!response) return null;
  try {
    const value = await response.json();
    if (
      value.schemaVersion !== 2 ||
      !validIdentifier(value.gameId) ||
      !validVersion(value.gameVersion) ||
      !validBuildId(value.buildId) ||
      !isAllowedOfflineEntryUrl(value.offlineEntryUrl) ||
      !Number.isSafeInteger(value.installedBytes) ||
      value.installedBytes < 0 ||
      value.installedBytes > MAX_INSTALL_BYTES ||
      !Number.isSafeInteger(value.installedAt) ||
      value.installedAt < 0 ||
      cacheName !== finalCacheName(value) ||
      markerRequest.url !== markerUrl(value.gameId)
    ) {
      return null;
    }
    const offlineEntryUrl = new URL(value.offlineEntryUrl, self.location.origin).href;
    const assets = validatedInstalledAssets(
      value.assets,
      offlineEntryUrl,
      value.installedBytes,
    );
    if (!assets) return null;
    for (const asset of assets) {
      if (!await cache.match(new Request(asset.url))) return null;
    }
    return {
      gameId: value.gameId,
      gameVersion: value.gameVersion,
      buildId: value.buildId,
      offlineEntryUrl,
      installedBytes: value.installedBytes,
      installedAt: value.installedAt,
      cacheName,
      assets,
    };
  } catch {
    return null;
  }
}

async function writeCurrent(installed) {
  const cache = await caches.open(META_CACHE);
  await cache.put(
    new Request(currentUrl(installed.gameId)),
    new Response(JSON.stringify(markerPayload(installed)), {
      headers: { "Content-Type": "application/json" },
    }),
  );
}

async function deleteCurrent(gameId) {
  const cache = await caches.open(META_CACHE);
  return cache.delete(new Request(currentUrl(gameId)));
}

async function readCurrentPointers() {
  const cache = await caches.open(META_CACHE);
  const pointers = new Map();
  for (const request of await cache.keys()) {
    if (!new URL(request.url).pathname.startsWith(CURRENT_PATH)) {
      await cache.delete(request);
      continue;
    }
    const response = await cache.match(request);
    if (!response) {
      await cache.delete(request);
      continue;
    }
    try {
      const value = await response.json();
      if (
        value.schemaVersion !== 2 ||
        !validIdentifier(value.gameId) ||
        !validVersion(value.gameVersion) ||
        !validBuildId(value.buildId) ||
        !isAllowedOfflineEntryUrl(value.offlineEntryUrl) ||
        !Number.isSafeInteger(value.installedBytes) ||
        value.installedBytes < 0 ||
        value.installedBytes > MAX_INSTALL_BYTES ||
        !Number.isSafeInteger(value.installedAt) ||
        value.installedAt < 0 ||
        value.cacheName !== finalCacheName(value) ||
        request.url !== currentUrl(value.gameId)
      ) {
        await cache.delete(request);
        continue;
      }
      const offlineEntryUrl = new URL(value.offlineEntryUrl, self.location.origin).href;
      const assets = validatedInstalledAssets(
        value.assets,
        offlineEntryUrl,
        value.installedBytes,
      );
      if (!assets) {
        await cache.delete(request);
        continue;
      }
      value.offlineEntryUrl = offlineEntryUrl;
      value.assets = assets;
      pointers.set(value.gameId, value);
    } catch {
      await cache.delete(request);
    }
  }
  return pointers;
}

function compareInstalled(left, right) {
  if (left.installedAt !== right.installedAt) return right.installedAt - left.installedAt;
  return compareText(right.cacheName, left.cacheName);
}

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function pointerMatchesInstalled(pointer, installed) {
  return Boolean(
    pointer &&
    pointer.gameId === installed.gameId &&
    pointer.gameVersion === installed.gameVersion &&
    pointer.buildId === installed.buildId &&
    pointer.cacheName === installed.cacheName &&
    pointer.installedBytes === installed.installedBytes &&
    pointer.installedAt === installed.installedAt &&
    new URL(pointer.offlineEntryUrl, self.location.origin).href === installed.offlineEntryUrl &&
    Array.isArray(pointer.assets) &&
    pointer.assets.length === installed.assets.length &&
    pointer.assets.every((asset, index) => (
      asset.url === installed.assets[index].url &&
      asset.bytes === installed.assets[index].bytes &&
      asset.sha256 === installed.assets[index].sha256
    ))
  );
}

function shouldDeleteBaseCache(name) {
  return (
    LEGACY_CACHE_NAMES.has(name) ||
    LEGACY_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
    name.startsWith(STAGING_CACHE_PREFIX) ||
    (name.startsWith("axis-vector-shell:") && name !== SHELL_CACHE) ||
    (name.startsWith("axis-vector-meta:") && name !== META_CACHE)
  );
}

async function reconcileCaches() {
  let names = await caches.keys();
  await Promise.all(
    names.filter(shouldDeleteBaseCache).map((name) => caches.delete(name)),
  );

  names = await caches.keys();
  const grouped = new Map();
  for (const name of names.filter((value) => value.startsWith(GAME_CACHE_PREFIX))) {
    const installed = await readInstalled(name);
    if (!installed) {
      await caches.delete(name);
      continue;
    }
    const candidates = grouped.get(installed.gameId) || [];
    candidates.push(installed);
    grouped.set(installed.gameId, candidates);
  }

  const pointers = await readCurrentPointers();
  const current = [];
  for (const [gameId, candidates] of grouped) {
    candidates.sort(compareInstalled);
    const pointer = pointers.get(gameId);
    const winner = candidates.find((candidate) => (
      pointerMatchesInstalled(pointer, candidate)
    )) || candidates[0];
    await writeCurrent(winner);
    current.push(winner);
    for (const candidate of candidates) {
      if (candidate.cacheName !== winner.cacheName) {
        await caches.delete(candidate.cacheName);
      }
    }
    pointers.delete(gameId);
  }
  for (const gameId of pointers.keys()) {
    await deleteCurrent(gameId);
  }
  return current.sort((left, right) => compareText(left.gameId, right.gameId));
}

async function currentInstalled() {
  const pointers = await readCurrentPointers();
  const installed = [];
  for (const pointer of pointers.values()) {
    const candidate = await readInstalled(pointer.cacheName);
    if (candidate && pointerMatchesInstalled(pointer, candidate)) {
      installed.push(candidate);
    }
  }
  return installed.sort((left, right) => compareText(left.gameId, right.gameId));
}

async function status() {
  return reconcileCaches();
}

async function matchCommittedAsset(request) {
  const url = new URL(request.url);
  if (url.pathname === OFFLINE_DOCUMENT) {
    const shell = await caches.open(SHELL_CACHE);
    return shell.match(OFFLINE_DOCUMENT);
  }

  for (const installed of await currentInstalled()) {
    const cache = await caches.open(installed.cacheName);
    const response = await cache.match(request);
    if (response) return response;
  }
  return undefined;
}

async function offlineDocument() {
  const shell = await caches.open(SHELL_CACHE);
  return shell.match(OFFLINE_DOCUMENT);
}

function gameIdFromVectorPath(pathname) {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "vector" || segments.length < 2) return null;
  try {
    const gameId = decodeURIComponent(segments[1]);
    return validIdentifier(gameId) ? gameId : null;
  } catch {
    return null;
  }
}

async function matchOfflineNavigation(request) {
  const response = await matchInstalledGameNavigation(request);
  if (response) return response;
  return offlineDocument();
}

async function matchInstalledGameNavigation(request) {
  const installed = await runSerialized(reconcileCaches);
  const gameId = gameIdFromVectorPath(new URL(request.url).pathname);
  if (gameId) {
    const current = installed.find((candidate) => candidate.gameId === gameId);
    if (current) {
      const cache = await caches.open(current.cacheName);
      const response = await cache.match(new Request(current.offlineEntryUrl));
      const contentType = response && response.headers.get("Content-Type");
      if (response && contentType && contentType.toLowerCase().includes("text/html")) {
        return response;
      }
    }
  }
  return undefined;
}

function isEligibleGameNavigationFailure(request, response) {
  const requestUrl = new URL(request.url);
  const responseUrl = new URL(response.url || request.url);
  const segments = requestUrl.pathname.split("/").filter(Boolean);
  return (
    requestUrl.origin === self.location.origin &&
    responseUrl.origin === self.location.origin &&
    !response.redirected &&
    response.status >= 500 &&
    response.status <= 599 &&
    segments.length === 2 &&
    segments[0] === "vector" &&
    validIdentifier(segments[1])
  );
}

async function navigationResponse(request) {
  try {
    const response = await fetch(request);
    if (!isEligibleGameNavigationFailure(request, response)) return response;
    return (await matchInstalledGameNavigation(request)) || response;
  } catch {
    return (
      (await matchOfflineNavigation(request)) ||
      new Response("VECTOR is offline and no verified offline shell is available.", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      })
    );
  }
}

async function cleanupSupersededGameCaches(gameId, targetName) {
  const names = await caches.keys();
  await Promise.all(names.map((name) => {
    if (
      name.startsWith(`${GAME_CACHE_PREFIX}${gameId}:`) &&
      name !== targetName
    ) {
      return caches.delete(name);
    }
    return Promise.resolve(false);
  }));
}

async function install(manifestUrl, manifestSha256) {
  await reconcileCaches();
  if (!isAllowedManifestUrl(manifestUrl)) {
    throw Object.assign(new Error("manifest URL rejected"), { code: "VECTOR_MANIFEST_NOT_ALLOWED" });
  }
  if (!validDigest(manifestSha256)) {
    throw Object.assign(new Error("manifest digest rejected"), { code: "VECTOR_MANIFEST_DIGEST_INVALID" });
  }
  const published = await publishedManifestReference(manifestUrl, manifestSha256);
  const manifestRequest = new Request(new URL(manifestUrl, self.location.origin), {
    credentials: "omit",
    cache: "no-store",
  });
  const manifestResponse = await fetch(manifestRequest);
  if (
    !manifestResponse.ok ||
    manifestResponse.type === "opaque" ||
    manifestResponse.headers.has("Set-Cookie") ||
    (manifestResponse.url && !isAllowedManifestUrl(manifestResponse.url))
  ) {
    throw Object.assign(new Error("manifest response rejected"), { code: "OFFLINE_MANIFEST_RESPONSE_REJECTED" });
  }
  const declaredManifestBytes = Number(manifestResponse.headers.get("Content-Length"));
  if (Number.isFinite(declaredManifestBytes) && declaredManifestBytes > MAX_MANIFEST_BYTES) {
    throw Object.assign(new Error("manifest response too large"), { code: "OFFLINE_MANIFEST_RESPONSE_REJECTED" });
  }
  const manifestBytes = await manifestResponse.arrayBuffer();
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) {
    throw Object.assign(new Error("manifest response too large"), { code: "OFFLINE_MANIFEST_RESPONSE_REJECTED" });
  }
  if (await sha256Hex(manifestBytes) !== manifestSha256) {
    throw Object.assign(new Error("manifest digest mismatch"), { code: "OFFLINE_MANIFEST_DIGEST_MISMATCH" });
  }
  let manifestValue;
  try {
    manifestValue = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    throw Object.assign(new Error("manifest JSON invalid"), { code: "INVALID_OFFLINE_MANIFEST" });
  }
  const manifest = validateManifest(manifestValue);
  if (
    manifest.gameId !== published.gameId ||
    manifest.gameVersion !== published.gameVersion ||
    manifest.buildId !== published.buildId ||
    new URL(manifest.offlineEntryUrl, self.location.origin).href !==
      new URL(published.offlineEntryUrl, self.location.origin).href ||
    manifest.estimatedBytes !== published.estimatedBytes
  ) {
    throw Object.assign(new Error("manifest disagrees with build map"), { code: "VECTOR_MANIFEST_NOT_PUBLISHED" });
  }
  const targetName = finalCacheName(manifest);
  const existing = await readInstalled(targetName);
  if (existing) {
    await writeCurrent(existing);
    await cleanupSupersededGameCaches(existing.gameId, targetName);
    return existing;
  }
  if (await caches.has(targetName)) await caches.delete(targetName);

  const stageName = `${STAGING_CACHE_PREFIX}${manifest.gameId}:${crypto.randomUUID()}`;
  const stage = await caches.open(stageName);
  const installedAt = Date.now();
  const installed = {
    gameId: manifest.gameId,
    gameVersion: manifest.gameVersion,
    buildId: manifest.buildId,
    offlineEntryUrl: new URL(manifest.offlineEntryUrl, self.location.origin).href,
    installedBytes: manifest.estimatedBytes,
    installedAt,
    cacheName: targetName,
    assets: manifest.assets.map((asset) => ({
      url: new URL(asset.url, self.location.origin).href,
      bytes: asset.bytes,
      sha256: asset.sha256,
    })).sort((left, right) => compareText(left.url, right.url)),
  };
  let targetCreated = false;
  let pointerCommitted = false;
  try {
    for (const asset of manifest.assets) {
      const response = await verifiedResponse(asset);
      await stage.put(new Request(new URL(asset.url, self.location.origin)), response);
    }
    const markerRequest = new Request(markerUrl(manifest.gameId));
    await stage.put(
      markerRequest,
      new Response(JSON.stringify(markerPayload(installed)), {
        headers: { "Content-Type": "application/json" },
      }),
    );

    const target = await caches.open(targetName);
    targetCreated = true;
    const requests = await stage.keys();
    for (const request of requests.filter((candidate) => candidate.url !== markerRequest.url)) {
      const response = await stage.match(request);
      if (!response) throw Object.assign(new Error("staging response missing"), { code: "OFFLINE_STAGE_INCOMPLETE" });
      await target.put(request, response);
    }
    const markerResponse = await stage.match(markerRequest);
    if (!markerResponse) {
      throw Object.assign(new Error("staging marker missing"), { code: "OFFLINE_STAGE_INCOMPLETE" });
    }
    await target.put(markerRequest, markerResponse);

    const committed = await readInstalled(targetName);
    if (!committed) {
      throw Object.assign(new Error("committed cache invalid"), { code: "OFFLINE_STAGE_INCOMPLETE" });
    }
    await writeCurrent(committed);
    pointerCommitted = true;
    await cleanupSupersededGameCaches(manifest.gameId, targetName);
    return committed;
  } catch (error) {
    if (targetCreated && !pointerCommitted) await caches.delete(targetName);
    throw error;
  } finally {
    await caches.delete(stageName);
  }
}

async function remove(gameId) {
  if (!validIdentifier(gameId)) {
    throw Object.assign(new Error("invalid game id"), { code: "INVALID_GAME_ID" });
  }
  await reconcileCaches();
  const names = await caches.keys();
  const targets = names.filter((name) =>
    name.startsWith(`${GAME_CACHE_PREFIX}${gameId}:`) ||
    name.startsWith(`${STAGING_CACHE_PREFIX}${gameId}:`),
  );
  const gameTargets = targets.filter((name) => name.startsWith(`${GAME_CACHE_PREFIX}${gameId}:`));
  const results = await Promise.all(targets.map(async (name) => ({
    name,
    deleted: await caches.delete(name),
  })));
  await deleteCurrent(gameId);
  return {
    removed: results.filter(({ name, deleted }) => (
      deleted && gameTargets.includes(name)
    )).length,
  };
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const request = new Request(OFFLINE_DOCUMENT, {
      cache: "reload",
      credentials: "omit",
    });
    const response = await fetch(request);
    if (
      !response.ok ||
      response.type === "opaque" ||
      response.headers.has("Set-Cookie") ||
      response.url !== request.url
    ) {
      throw new Error("VECTOR offline document unavailable");
    }
    await cache.put(OFFLINE_DOCUMENT, response);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(runSerialized(async () => {
    await reconcileCaches();
    await self.clients.claim();
  }));
});

self.addEventListener("message", (event) => {
  event.waitUntil((async () => {
    try {
      const message = event.data || {};
      if (message.type === "VECTOR_PING") {
        reply(event, {
          ok: true,
          result: { protocolVersion: WORKER_PROTOCOL_VERSION },
        });
        return;
      }
      if (message.type === "VECTOR_STATUS") {
        reply(event, { ok: true, result: await runSerialized(status) });
        return;
      }
      if (message.type === "VECTOR_INSTALL") {
        reply(event, {
          ok: true,
          result: await runSerialized(() => install(
            message.manifestUrl,
            message.manifestSha256,
          )),
        });
        return;
      }
      if (message.type === "VECTOR_REMOVE") {
        reply(event, { ok: true, result: await runSerialized(() => remove(message.gameId)) });
        return;
      }
      throw Object.assign(new Error("unknown message"), { code: "VECTOR_WORKER_MESSAGE_INVALID" });
    } catch (error) {
      fail(event, error);
    }
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (request.mode === "navigate" && (
    url.pathname === "/vector" ||
    url.pathname.startsWith("/vector/")
  )) {
    event.respondWith(navigationResponse(request));
    return;
  }

  if (!isAllowedAssetUrl(request.url)) return;
  event.respondWith(
    matchCommittedAsset(request).then((cached) => cached || fetch(new Request(request, {
      credentials: "omit",
    }))),
  );
});
