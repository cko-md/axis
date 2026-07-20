import { z } from "zod";

export const VECTOR_SERVICE_WORKER_URL = "/sw.js";
export const VECTOR_WORKER_PROTOCOL_VERSION = 3;
export const VECTOR_OFFLINE_DOCUMENT_URL = "/vector-offline.html";
export const VECTOR_OFFLINE_MANIFEST_PREFIX = "/vector-assets/manifests/";
export const VECTOR_OFFLINE_ENTRY_PREFIX = "/vector-assets/offline/";
export const VECTOR_OFFLINE_CACHE_PREFIX = "axis-vector-game:";

const VECTOR_RESERVED_METADATA_PREFIXES = [
  "/vector-assets/.installed/",
  "/vector-assets/.current/",
];
const SHA256_HEX = /^[a-f0-9]{64}$/;
const GAME_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i;
const BUILD_ID = /^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,159}$/;
const MAX_ASSET_BYTES = 250 * 1024 * 1024;
const MAX_INSTALL_BYTES = 500 * 1024 * 1024;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
const DEFAULT_PING_TIMEOUT_MS = 500;
const DEFAULT_POLL_INTERVAL_MS = 100;

export type VectorOfflineAsset = {
  url: string;
  bytes: number;
  sha256: string;
};

export type VectorOfflineManifest = {
  schemaVersion: 1;
  gameId: string;
  gameVersion: string;
  buildId: string;
  offlineEntryUrl: string;
  estimatedBytes: number;
  assets: VectorOfflineAsset[];
};

export type VectorInstalledGame = {
  gameId: string;
  gameVersion: string;
  buildId: string;
  offlineEntryUrl: string;
  installedBytes: number;
  installedAt: number;
  cacheName: string;
  assets: VectorOfflineAsset[];
};

export type VectorOfflineInstallReference = {
  manifestUrl: string;
  manifestSha256: string;
};

export type VectorOfflineStatus = {
  supported: boolean;
  installed: VectorInstalledGame[];
};

type WorkerSuccess<T> = {
  ok: true;
  result: T;
};

type WorkerFailure = {
  ok: false;
  error: {
    code: string;
    message: string;
  };
};

type WorkerResponse<T> = WorkerSuccess<T> | WorkerFailure;

export type VectorWorkerEndpoint = {
  state?: string;
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener?: (
    type: string,
    listener: EventListenerOrEventListenerObject,
  ) => void;
  removeEventListener?: (
    type: string,
    listener: EventListenerOrEventListenerObject,
  ) => void;
};

export type VectorWorkerRegistration = {
  active: VectorWorkerEndpoint | null;
  waiting: VectorWorkerEndpoint | null;
  installing: VectorWorkerEndpoint | null;
  addEventListener?: (
    type: string,
    listener: EventListenerOrEventListenerObject,
  ) => void;
  removeEventListener?: (
    type: string,
    listener: EventListenerOrEventListenerObject,
  ) => void;
};

export type VectorWorkerContainer = {
  controller: VectorWorkerEndpoint | null;
  addEventListener?: (
    type: string,
    listener: EventListenerOrEventListenerObject,
  ) => void;
  removeEventListener?: (
    type: string,
    listener: EventListenerOrEventListenerObject,
  ) => void;
};

export type VectorWorkerHandshakeOptions = {
  totalTimeoutMs?: number;
  pingTimeoutMs?: number;
  pollIntervalMs?: number;
};

const offlineAssetSchema = z.object({
  url: z.string().min(1).max(500),
  bytes: z.number().int().nonnegative().max(MAX_ASSET_BYTES),
  sha256: z.string().regex(SHA256_HEX),
}).strict();

const offlineManifestSchema = z.object({
  schemaVersion: z.literal(1),
  gameId: z.string().regex(GAME_ID),
  gameVersion: z.string().regex(VERSION),
  buildId: z.string().regex(BUILD_ID),
  offlineEntryUrl: z.string().min(1).max(500),
  estimatedBytes: z.number().int().nonnegative().max(MAX_INSTALL_BYTES),
  assets: z.array(offlineAssetSchema).min(1).max(500),
}).strict();

const installedGameSchema = z.object({
  gameId: z.string().regex(GAME_ID),
  gameVersion: z.string().regex(VERSION),
  buildId: z.string().regex(BUILD_ID),
  offlineEntryUrl: z.string().min(1).max(500),
  installedBytes: z.number().int().nonnegative().max(MAX_INSTALL_BYTES),
  installedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  cacheName: z.string().min(1).max(500),
  assets: z.array(offlineAssetSchema).min(1).max(500),
}).strict();

export class VectorOfflineWorkerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "VectorOfflineWorkerError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

export function decodeVectorWorkerResponse<T>(payload: unknown): T {
  if (isRecord(payload) && payload.ok === true && "result" in payload) {
    return payload.result as T;
  }
  if (isRecord(payload) && payload.ok === false && isRecord(payload.error)) {
    const code = typeof payload.error.code === "string"
      ? payload.error.code
      : "VECTOR_WORKER_FAILED";
    const message = typeof payload.error.message === "string" && payload.error.message.trim()
      ? payload.error.message
      : "The offline worker could not complete the request.";
    throw new VectorOfflineWorkerError(code, message);
  }
  throw new VectorOfflineWorkerError(
    "VECTOR_WORKER_RESPONSE_INVALID",
    "The offline worker returned an invalid response.",
  );
}

function parsedSameOriginUrl(rawUrl: string, baseUrl: string): URL | null {
  try {
    const base = new URL(baseUrl);
    const url = new URL(rawUrl, base);
    return (
      url.origin === base.origin &&
      !url.username &&
      !url.password &&
      !url.hash
    ) ? url : null;
  } catch {
    return null;
  }
}

function isReservedVectorOfflineAssetUrl(rawUrl: string, baseUrl: string): boolean {
  const url = parsedSameOriginUrl(rawUrl, baseUrl);
  return Boolean(url && VECTOR_RESERVED_METADATA_PREFIXES.some(
    (prefix) => url.pathname.startsWith(prefix),
  ));
}

export function isAllowedVectorOfflineEntryUrl(rawUrl: string, baseUrl: string): boolean {
  const url = parsedSameOriginUrl(rawUrl, baseUrl);
  return Boolean(
    url &&
    url.pathname.startsWith(VECTOR_OFFLINE_ENTRY_PREFIX) &&
    url.pathname.endsWith(".html"),
  );
}

export function isAllowedVectorOfflineAssetUrl(rawUrl: string, baseUrl: string): boolean {
  const url = parsedSameOriginUrl(rawUrl, baseUrl);
  if (!url || isReservedVectorOfflineAssetUrl(rawUrl, baseUrl)) return false;

  return (
    url.pathname === VECTOR_OFFLINE_DOCUMENT_URL ||
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/vector-assets/")
  );
}

export function isAllowedVectorManifestUrl(rawUrl: string, baseUrl: string): boolean {
  const url = parsedSameOriginUrl(rawUrl, baseUrl);
  return Boolean(
    url &&
    url.pathname.startsWith(VECTOR_OFFLINE_MANIFEST_PREFIX) &&
    url.pathname.endsWith(".json"),
  );
}

export function parseVectorOfflineManifest(
  input: unknown,
  baseUrl: string,
): { ok: true; manifest: VectorOfflineManifest } | { ok: false; error: string } {
  const parsed = offlineManifestSchema.safeParse(input);
  if (!parsed.success || !isAllowedVectorOfflineEntryUrl(parsed.data.offlineEntryUrl, baseUrl)) {
    return { ok: false, error: "INVALID_OFFLINE_MANIFEST" };
  }

  const seen = new Set<string>();
  let declaredBytes = 0;
  for (const asset of parsed.data.assets) {
    if (!isAllowedVectorOfflineAssetUrl(asset.url, baseUrl)) {
      return { ok: false, error: "OFFLINE_ASSET_NOT_ALLOWED" };
    }
    const normalized = new URL(asset.url, baseUrl).href;
    if (seen.has(normalized)) {
      return { ok: false, error: "DUPLICATE_OFFLINE_ASSET" };
    }
    seen.add(normalized);
    declaredBytes += asset.bytes;
  }

  if (declaredBytes !== parsed.data.estimatedBytes) {
    return { ok: false, error: "OFFLINE_SIZE_MISMATCH" };
  }
  if (!seen.has(new URL(parsed.data.offlineEntryUrl, baseUrl).href)) {
    return { ok: false, error: "INVALID_OFFLINE_MANIFEST" };
  }

  return { ok: true, manifest: parsed.data };
}

export function vectorOfflineCacheName(
  manifest: Pick<VectorOfflineManifest, "gameId" | "gameVersion" | "buildId">,
): string {
  return `${VECTOR_OFFLINE_CACHE_PREFIX}${manifest.gameId}:${manifest.gameVersion}:${manifest.buildId}`;
}

export function isQuotaExceededError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  const code = "code" in error ? Number(error.code) : NaN;
  return name === "QuotaExceededError" || code === 22 || code === 1014;
}

export async function registerVectorServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (
    typeof window === "undefined" ||
    typeof navigator === "undefined" ||
    !("serviceWorker" in navigator)
  ) {
    throw new VectorOfflineWorkerError(
      "VECTOR_OFFLINE_UNSUPPORTED",
      "Offline games are not supported in this browser.",
    );
  }
  const registration = await navigator.serviceWorker.register(
    VECTOR_SERVICE_WORKER_URL,
    { scope: "/", updateViaCache: "none" },
  );
  void registration.update().catch(() => undefined);
  return registration;
}

async function postWorkerRequest<T>(
  worker: VectorWorkerEndpoint,
  message: Record<string, unknown>,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const channel = new MessageChannel();
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.port1.close();
      callback();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new VectorOfflineWorkerError(
        "VECTOR_WORKER_TIMEOUT",
        "The offline worker did not respond. Check offline status before retrying.",
      )));
    }, timeoutMs);

    channel.port1.onmessage = (event: MessageEvent<WorkerResponse<T>>) => {
      finish(() => {
        try {
          resolve(decodeVectorWorkerResponse<T>(event.data));
        } catch (error) {
          reject(error);
        }
      });
    };
    channel.port1.onmessageerror = () => {
      finish(() => reject(new VectorOfflineWorkerError(
        "VECTOR_WORKER_RESPONSE_INVALID",
        "The offline worker returned an unreadable response.",
      )));
    };
    channel.port1.start?.();

    try {
      worker.postMessage(message, [channel.port2]);
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

async function pingWorker(
  worker: VectorWorkerEndpoint,
  timeoutMs: number,
): Promise<VectorWorkerEndpoint> {
  if (worker.state === "redundant") {
    throw new VectorOfflineWorkerError(
      "VECTOR_WORKER_UNAVAILABLE",
      "The offline worker is being replaced.",
    );
  }
  const result = await postWorkerRequest<{ protocolVersion: number }>(
    worker,
    { type: "VECTOR_PING" },
    timeoutMs,
  );
  if (result.protocolVersion !== VECTOR_WORKER_PROTOCOL_VERSION) {
    throw new VectorOfflineWorkerError(
      "VECTOR_WORKER_PROTOCOL_MISMATCH",
      "Offline support is updating. Reload VECTOR when the update completes.",
    );
  }
  return worker;
}

function uniqueWorkerCandidates(
  registration: VectorWorkerRegistration,
  container: VectorWorkerContainer,
): VectorWorkerEndpoint[] {
  const candidates = [
    registration.waiting,
    registration.installing,
    container.controller,
    registration.active,
  ];
  return candidates.filter((
    candidate,
    index,
    all,
  ): candidate is VectorWorkerEndpoint => Boolean(
    candidate &&
    candidate.state !== "redundant" &&
    all.indexOf(candidate) === index,
  ));
}

async function firstCompatibleWorker(
  candidates: VectorWorkerEndpoint[],
  pingTimeoutMs: number,
): Promise<VectorWorkerEndpoint | null> {
  if (candidates.length === 0) return null;
  return new Promise((resolve) => {
    let unresolved = candidates.length;
    let settled = false;
    for (const candidate of candidates) {
      void pingWorker(candidate, pingTimeoutMs).then((worker) => {
        if (settled) return;
        settled = true;
        resolve(worker);
      }).catch(() => {
        unresolved -= 1;
        if (!settled && unresolved === 0) resolve(null);
      });
    }
  });
}

async function waitForWorkerChange(
  registration: VectorWorkerRegistration,
  container: VectorWorkerContainer,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const sources: Array<{
      target: VectorWorkerRegistration | VectorWorkerContainer | VectorWorkerEndpoint;
      type: string;
    }> = [
      { target: registration, type: "updatefound" },
      { target: container, type: "controllerchange" },
      ...uniqueWorkerCandidates(registration, container).map((target) => ({
        target,
        type: "statechange",
      })),
    ];
    const cleanup = () => {
      for (const { target, type } of sources) {
        target.removeEventListener?.(type, onChange);
      }
    };
    const onChange = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve();
    };
    for (const { target, type } of sources) {
      target.addEventListener?.(type, onChange);
    }
    const timer = setTimeout(onChange, timeoutMs);
  });
}

export async function waitForCompatibleVectorWorker(
  registration: VectorWorkerRegistration,
  container: VectorWorkerContainer,
  options: VectorWorkerHandshakeOptions = {},
): Promise<VectorWorkerEndpoint> {
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const pingTimeoutMs = options.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + totalTimeoutMs;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const compatible = await firstCompatibleWorker(
      uniqueWorkerCandidates(registration, container),
      Math.max(1, Math.min(pingTimeoutMs, remaining)),
    );
    if (compatible) return compatible;

    const afterPing = deadline - Date.now();
    if (afterPing <= 0) break;
    await waitForWorkerChange(
      registration,
      container,
      Math.max(1, Math.min(pollIntervalMs, afterPing)),
    );
  }

  throw new VectorOfflineWorkerError(
    "VECTOR_WORKER_UNAVAILABLE",
    "Offline support is updating or unavailable. Reload VECTOR and try again.",
  );
}

async function requestWorker<T>(
  message: Record<string, unknown>,
  timeoutMs: number,
): Promise<T> {
  const registration = await registerVectorServiceWorker();
  const worker = await waitForCompatibleVectorWorker(
    registration as unknown as VectorWorkerRegistration,
    navigator.serviceWorker as unknown as VectorWorkerContainer,
  );
  return postWorkerRequest<T>(worker, message, timeoutMs);
}

export async function getVectorOfflineStatus(): Promise<VectorOfflineStatus> {
  if (
    typeof window === "undefined" ||
    typeof navigator === "undefined" ||
    !("serviceWorker" in navigator)
  ) {
    return { supported: false, installed: [] };
  }
  const result = await requestWorker<unknown>(
    { type: "VECTOR_STATUS" },
    10_000,
  );
  const decoded = z.array(installedGameSchema).max(100).safeParse(result);
  if (!decoded.success) {
    throw new VectorOfflineWorkerError(
      "VECTOR_WORKER_RESPONSE_INVALID",
      "The offline worker returned an invalid installation inventory.",
    );
  }
  const seen = new Set<string>();
  const installed: VectorInstalledGame[] = [];
  for (const candidate of decoded.data) {
    const manifest = parseVectorOfflineManifest({
      schemaVersion: 1,
      gameId: candidate.gameId,
      gameVersion: candidate.gameVersion,
      buildId: candidate.buildId,
      offlineEntryUrl: candidate.offlineEntryUrl,
      estimatedBytes: candidate.installedBytes,
      assets: candidate.assets,
    }, window.location.origin);
    if (
      !manifest.ok ||
      candidate.cacheName !== vectorOfflineCacheName(candidate) ||
      seen.has(candidate.gameId)
    ) {
      throw new VectorOfflineWorkerError(
        "VECTOR_WORKER_RESPONSE_INVALID",
        "The offline worker returned an invalid installation inventory.",
      );
    }
    seen.add(candidate.gameId);
    installed.push(candidate);
  }
  return { supported: true, installed };
}

export async function installVectorOffline(
  reference: VectorOfflineInstallReference,
): Promise<VectorInstalledGame> {
  if (
    typeof window === "undefined" ||
    !isAllowedVectorManifestUrl(reference.manifestUrl, window.location.origin) ||
    !SHA256_HEX.test(reference.manifestSha256)
  ) {
    throw new VectorOfflineWorkerError(
      "VECTOR_MANIFEST_NOT_ALLOWED",
      "This offline package manifest is not allowed.",
    );
  }
  const result = await requestWorker<unknown>(
    {
      type: "VECTOR_INSTALL",
      manifestUrl: reference.manifestUrl,
      manifestSha256: reference.manifestSha256,
    },
    10 * 60_000,
  );
  const parsed = installedGameSchema.safeParse(result);
  if (!parsed.success) {
    throw new VectorOfflineWorkerError(
      "VECTOR_WORKER_RESPONSE_INVALID",
      "The offline worker returned an invalid installation record.",
    );
  }
  const manifest = parseVectorOfflineManifest({
    schemaVersion: 1,
    gameId: parsed.data.gameId,
    gameVersion: parsed.data.gameVersion,
    buildId: parsed.data.buildId,
    offlineEntryUrl: parsed.data.offlineEntryUrl,
    estimatedBytes: parsed.data.installedBytes,
    assets: parsed.data.assets,
  }, window.location.origin);
  if (!manifest.ok || parsed.data.cacheName !== vectorOfflineCacheName(parsed.data)) {
    throw new VectorOfflineWorkerError(
      "VECTOR_WORKER_RESPONSE_INVALID",
      "The offline worker returned an invalid installation record.",
    );
  }
  return parsed.data;
}

export async function removeVectorOffline(gameId: string): Promise<{ removed: number }> {
  if (!GAME_ID.test(gameId)) {
    throw new VectorOfflineWorkerError(
      "INVALID_GAME_ID",
      "The requested game identifier is invalid.",
    );
  }
  return requestWorker<{ removed: number }>(
    { type: "VECTOR_REMOVE", gameId },
    30_000,
  );
}

export async function estimateVectorStorage(): Promise<{
  usage: number | null;
  quota: number | null;
  persisted: boolean | null;
}> {
  if (typeof navigator === "undefined" || !navigator.storage) {
    return { usage: null, quota: null, persisted: null };
  }
  const estimate = await navigator.storage.estimate();
  const persisted = typeof navigator.storage.persisted === "function"
    ? await navigator.storage.persisted()
    : null;
  return {
    usage: typeof estimate.usage === "number" ? estimate.usage : null,
    quota: typeof estimate.quota === "number" ? estimate.quota : null,
    persisted,
  };
}

export async function requestPersistentVectorStorage(): Promise<boolean | null> {
  if (typeof navigator === "undefined" || !navigator.storage) return null;
  if (typeof navigator.storage.persist !== "function") return null;
  return navigator.storage.persist();
}
