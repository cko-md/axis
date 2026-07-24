import { createHash, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { classifyAccess, requiresSupabaseAuth } from "@/lib/auth/accessPolicy";

const ORIGIN = "https://axis.example";
const workerSource = readFileSync("public/sw.js", "utf8");
const middleware = readFileSync("src/middleware.ts", "utf8");
const nextConfig = readFileSync("next.config.ts", "utf8");
const offlineDocumentSource = readFileSync("public/vector-offline.html", "utf8");

class WorkerRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(
      typeof input === "string" ? new URL(input, ORIGIN) : input,
      init,
    );
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return new URL(input, ORIGIN).href;
  if (input instanceof URL) return input.href;
  return input.url;
}

class MemoryCache {
  private readonly entries = new Map<string, Response>();

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    this.entries.set(requestUrl(request), response.clone());
  }

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    return this.entries.get(requestUrl(request))?.clone();
  }

  async keys(): Promise<Request[]> {
    return Array.from(this.entries.keys(), (url) => new WorkerRequest(url));
  }

  async delete(request: RequestInfo | URL): Promise<boolean> {
    return this.entries.delete(requestUrl(request));
  }
}

class MemoryCacheStorage {
  private readonly stores = new Map<string, MemoryCache>();

  async open(name: string): Promise<MemoryCache> {
    let cache = this.stores.get(name);
    if (!cache) {
      cache = new MemoryCache();
      this.stores.set(name, cache);
    }
    return cache;
  }

  async keys(): Promise<string[]> {
    return Array.from(this.stores.keys());
  }

  async has(name: string): Promise<boolean> {
    return this.stores.has(name);
  }

  async delete(name: string): Promise<boolean> {
    return this.stores.delete(name);
  }
}

type WorkerListener = (event: Record<string, unknown>) => void;
type RouteBody = BodyInit | null;

function sha256(body: string | Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

function byteLength(body: string | Uint8Array): number {
  return typeof body === "string"
    ? new TextEncoder().encode(body).byteLength
    : body.byteLength;
}

function createWorkerHarness() {
  const storage = new MemoryCacheStorage();
  const listeners = new Map<string, WorkerListener[]>();
  const routes = new Map<string, () => Response>();
  let navigationOffline = false;
  let claimed = false;
  let skippedWaiting = false;

  const self = {
    location: { origin: ORIGIN },
    clients: {
      async claim() {
        claimed = true;
      },
    },
    async skipWaiting() {
      skippedWaiting = true;
    },
    addEventListener(type: string, listener: WorkerListener) {
      const existing = listeners.get(type) ?? [];
      existing.push(listener);
      listeners.set(type, existing);
    },
  };

  const fetch = async (input: RequestInfo | URL) => {
    const url = new URL(requestUrl(input));
    if (
      navigationOffline &&
      (url.pathname === "/vector" || url.pathname.startsWith("/vector/"))
    ) {
      throw new TypeError("network unavailable");
    }
    const route = routes.get(url.href);
    if (!route) throw new TypeError(`No route for ${url.href}`);
    return route();
  };

  vm.runInNewContext(workerSource, {
    self,
    caches: storage,
    fetch,
    Request: WorkerRequest,
    Response,
    Headers,
    URL,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    crypto: webcrypto,
    console,
    setTimeout,
    clearTimeout,
  }, { filename: "public/sw.js" });

  async function dispatchExtendable(type: "install" | "activate"): Promise<void> {
    const pending: Promise<unknown>[] = [];
    for (const listener of listeners.get(type) ?? []) {
      listener({
        waitUntil(value: Promise<unknown>) {
          pending.push(Promise.resolve(value));
        },
      });
    }
    await Promise.all(pending);
  }

  async function message(data: Record<string, unknown>): Promise<unknown> {
    const pending: Promise<unknown>[] = [];
    let response: unknown;
    let responded = false;
    for (const listener of listeners.get("message") ?? []) {
      listener({
        data,
        ports: [{
          postMessage(value: unknown) {
            response = value;
            responded = true;
          },
        }],
        waitUntil(value: Promise<unknown>) {
          pending.push(Promise.resolve(value));
        },
      });
    }
    await Promise.all(pending);
    if (!responded) throw new Error("worker did not reply");
    return response;
  }

  async function navigation(pathname: string): Promise<Response> {
    let responsePromise: Promise<Response> | undefined;
    const request = {
      method: "GET",
      mode: "navigate",
      url: new URL(pathname, ORIGIN).href,
    };
    for (const listener of listeners.get("fetch") ?? []) {
      listener({
        request,
        respondWith(value: Promise<Response> | Response) {
          responsePromise = Promise.resolve(value);
        },
      });
    }
    if (!responsePromise) throw new Error("worker did not handle navigation");
    return responsePromise;
  }

  async function asset(pathname: string): Promise<Response> {
    let responsePromise: Promise<Response> | undefined;
    const request = new WorkerRequest(new URL(pathname, ORIGIN), {
      method: "GET",
    });
    for (const listener of listeners.get("fetch") ?? []) {
      listener({
        request,
        respondWith(value: Promise<Response> | Response) {
          responsePromise = Promise.resolve(value);
        },
      });
    }
    if (!responsePromise) throw new Error("worker did not handle asset");
    return responsePromise;
  }

  function route(
    pathname: string,
    body: RouteBody,
    init?: ResponseInit,
    finalUrl?: string,
  ): void {
    const url = new URL(pathname, ORIGIN).href;
    routes.set(url, () => {
      const response = new Response(body, init);
      Object.defineProperty(response, "url", {
        configurable: true,
        value: new URL(finalUrl ?? url, ORIGIN).href,
      });
      return response;
    });
  }

  route("/vector-offline.html", offlineDocumentSource, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });

  return {
    storage,
    dispatchExtendable,
    message,
    navigation,
    asset,
    route,
    setNavigationOffline(value: boolean) {
      navigationOffline = value;
    },
    wasClaimed: () => claimed,
    skippedWaiting: () => skippedWaiting,
  };
}

function createManifest(
  harness: ReturnType<typeof createWorkerHarness>,
  options: {
    gameVersion?: string;
    buildId?: string;
    entryBody?: string;
  } = {},
) {
  const gameVersion = options.gameVersion ?? "1.0.0";
  const buildId = options.buildId ?? "build-1";
  const entryBody = options.entryBody ?? "<!doctype html><title>Second Sense Offline</title>";
  const chunkBody = "self.SECOND_SENSE = true;";
  const offlineEntryUrl = "/vector-assets/offline/second-sense.html";
  const manifestUrl = `/vector-assets/manifests/second-sense-${buildId}.json`;
  const assets = [
    {
      url: offlineEntryUrl,
      bytes: byteLength(entryBody),
      sha256: sha256(entryBody),
    },
    {
      url: `/_next/static/chunks/second-sense-${buildId}.js`,
      bytes: byteLength(chunkBody),
      sha256: sha256(chunkBody),
    },
  ];
  const manifest = {
    schemaVersion: 1,
    gameId: "second-sense",
    gameVersion,
    buildId,
    offlineEntryUrl,
    estimatedBytes: assets.reduce((total, asset) => total + asset.bytes, 0),
    assets,
  };
  const manifestBody = JSON.stringify(manifest);
  const manifestSha256 = sha256(manifestBody);
  harness.route(manifestUrl, manifestBody, {
    headers: { "Content-Type": "application/json" },
  });
  harness.route(offlineEntryUrl, entryBody, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
  harness.route(assets[1].url, chunkBody, {
    headers: { "Content-Type": "text/javascript; charset=utf-8" },
  });
  harness.route("/vector-assets/manifests/build-map.json", JSON.stringify({
    schemaVersion: 1,
    buildId,
    games: [{
      gameId: manifest.gameId,
      gameVersion,
      buildId,
      manifestUrl,
      manifestSha256,
      offlineEntryUrl,
      estimatedBytes: manifest.estimatedBytes,
    }],
  }), {
    headers: { "Content-Type": "application/json" },
  });
  return {
    manifest,
    manifestUrl,
    manifestSha256,
    entryBody,
  };
}

async function seedCompleteCache(
  storage: MemoryCacheStorage,
  options: {
    gameVersion: string;
    buildId: string;
    installedAt: number;
    current?: boolean;
  },
) {
  const gameId = "second-sense";
  const offlineEntryUrl = new URL(
    "/vector-assets/offline/second-sense.html",
    ORIGIN,
  ).href;
  const chunkUrl = new URL(
    `/_next/static/chunks/second-sense-${options.buildId}.js`,
    ORIGIN,
  ).href;
  const entryBody = "<!doctype html><title>cached</title>";
  const chunkBody = "self.SECOND_SENSE = true;";
  const assets = [
    {
      url: chunkUrl,
      bytes: byteLength(chunkBody),
      sha256: sha256(chunkBody),
    },
    {
      url: offlineEntryUrl,
      bytes: byteLength(entryBody),
      sha256: sha256(entryBody),
    },
  ].sort((left, right) => left.url.localeCompare(right.url));
  const cacheName = `axis-vector-game:${gameId}:${options.gameVersion}:${options.buildId}`;
  const marker = {
    schemaVersion: 2,
    gameId,
    gameVersion: options.gameVersion,
    buildId: options.buildId,
    offlineEntryUrl,
    installedBytes: assets.reduce((total, asset) => total + asset.bytes, 0),
    installedAt: options.installedAt,
    cacheName,
    assets,
  };
  const cache = await storage.open(cacheName);
  await cache.put(offlineEntryUrl, new Response(entryBody, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  }));
  await cache.put(chunkUrl, new Response(chunkBody, {
    headers: { "Content-Type": "text/javascript; charset=utf-8" },
  }));
  await cache.put(
    new URL(`/vector-assets/.installed/${gameId}.json`, ORIGIN),
    new Response(JSON.stringify(marker), {
      headers: { "Content-Type": "application/json" },
    }),
  );
  if (options.current) {
    const meta = await storage.open("axis-vector-meta:v3");
    await meta.put(
      new URL(`/vector-assets/.current/${gameId}.json`, ORIGIN),
      new Response(JSON.stringify(marker), {
        headers: { "Content-Type": "application/json" },
      }),
    );
  }
  return { cacheName, marker };
}

describe("VECTOR offline worker", () => {
  it("rejects an offline shell response redirected away from its exact app-origin URL", async () => {
    const harness = createWorkerHarness();
    harness.route(
      "/vector-offline.html",
      "<!doctype html><title>external</title>",
      { headers: { "Content-Type": "text/html" } },
      "https://cdn.example/vector-offline.html",
    );

    await expect(harness.dispatchExtendable("install")).rejects.toThrow(
      "VECTOR offline document unavailable",
    );
  });

  it("deletes exact legacy caches and stale VECTOR generations on activation", async () => {
    const harness = createWorkerHarness();
    const deletedNames = [
      "start-url",
      "static-assets",
      "google-fonts",
      "api-cache",
      "pages-cache",
      "workbox-precache-v2-old",
      "workbox-runtime-old",
      "axis-vector-cache:old",
      "axis-vector-stage:second-sense:crashed",
      "axis-vector-shell:v1",
      "axis-vector-shell:v2",
      "axis-vector-meta:v1",
      "axis-vector-meta:v2",
    ];
    for (const name of [...deletedNames, "unrelated-cache"]) {
      await harness.storage.open(name);
    }

    await harness.dispatchExtendable("activate");

    const names = await harness.storage.keys();
    expect(names).not.toEqual(expect.arrayContaining(deletedNames));
    expect(names).toContain("unrelated-cache");
    expect(harness.wasClaimed()).toBe(true);
  });

  it("installs, reports, and removes a verified offline package", async () => {
    const harness = createWorkerHarness();
    const { manifest, manifestUrl, manifestSha256 } = createManifest(harness);
    await harness.dispatchExtendable("install");
    expect(harness.skippedWaiting()).toBe(true);

    const installed = await harness.message({
      type: "VECTOR_INSTALL",
      manifestUrl,
      manifestSha256,
    });
    expect(installed).toMatchObject({
      ok: true,
      result: {
        gameId: manifest.gameId,
        gameVersion: manifest.gameVersion,
        buildId: manifest.buildId,
        offlineEntryUrl: new URL(manifest.offlineEntryUrl, ORIGIN).href,
      },
    });
    const targetName = `axis-vector-game:${manifest.gameId}:${manifest.gameVersion}:${manifest.buildId}`;
    expect(await harness.storage.has(targetName)).toBe(true);
    const target = await harness.storage.open(targetName);
    const targetRequests = await target.keys();
    expect(new URL(targetRequests.at(-1)?.url ?? ORIGIN).pathname).toBe(
      "/vector-assets/.installed/second-sense.json",
    );
    const markerResponse = await target.match(
      "/vector-assets/.installed/second-sense.json",
    );
    await expect(markerResponse?.json()).resolves.toMatchObject({
      schemaVersion: 2,
      installedBytes: manifest.estimatedBytes,
      assets: manifest.assets.map((asset) => ({
        ...asset,
        url: new URL(asset.url, ORIGIN).href,
      })).sort((left, right) => left.url.localeCompare(right.url)),
    });
    expect((await harness.storage.keys()).some((name) => (
      name.startsWith("axis-vector-stage:")
    ))).toBe(false);

    const status = await harness.message({ type: "VECTOR_STATUS" });
    expect(status).toMatchObject({
      ok: true,
      result: [{
        gameId: "second-sense",
        cacheName: targetName,
      }],
    });

    await expect(harness.message({
      type: "VECTOR_REMOVE",
      gameId: "second-sense",
    })).resolves.toEqual({ ok: true, result: { removed: 1 } });
    await expect(harness.message({ type: "VECTOR_STATUS" })).resolves.toEqual({
      ok: true,
      result: [],
    });
    expect(await harness.storage.has(targetName)).toBe(false);
  });

  it("rejects a manifest whose published build-map digest does not match", async () => {
    const harness = createWorkerHarness();
    const { manifestUrl } = createManifest(harness);
    await expect(harness.message({
      type: "VECTOR_INSTALL",
      manifestUrl,
      manifestSha256: "0".repeat(64),
    })).resolves.toEqual({
      ok: false,
      error: {
        code: "OFFLINE_MANIFEST_DIGEST_MISMATCH",
        message: "The offline package manifest failed integrity verification.",
      },
    });
    expect((await harness.storage.keys()).some((name) => (
      name.startsWith("axis-vector-game:")
    ))).toBe(false);
  });

  it("stores decoded asset bytes without stale compression response headers", async () => {
    const harness = createWorkerHarness();
    const { manifest, manifestUrl, manifestSha256 } = createManifest(harness);
    const chunkUrl = `/_next/static/chunks/second-sense-${manifest.buildId}.js`;
    const chunkBody = "self.SECOND_SENSE = true;";
    harness.route(chunkUrl, chunkBody, {
      headers: {
        "Content-Type": "text/javascript; charset=utf-8",
        "Content-Encoding": "gzip",
        "Content-Length": "3",
      },
    });

    await harness.message({ type: "VECTOR_INSTALL", manifestUrl, manifestSha256 });
    const cache = await harness.storage.open(
      `axis-vector-game:${manifest.gameId}:${manifest.gameVersion}:${manifest.buildId}`,
    );
    const stored = await cache.match(chunkUrl);
    expect(stored?.headers.get("Content-Encoding")).toBeNull();
    expect(stored?.headers.get("Content-Length")).toBe(String(byteLength(chunkBody)));
    await expect(stored?.text()).resolves.toBe(chunkBody);
  });

  it("reconciles staging debris and partial target caches after a crash", async () => {
    const harness = createWorkerHarness();
    const stageName = "axis-vector-stage:second-sense:crashed";
    const partialName = "axis-vector-game:second-sense:1.0.0:partial";
    await harness.storage.open(stageName);
    const partial = await harness.storage.open(partialName);
    await partial.put(
      "/vector-assets/offline/second-sense.html",
      new Response("<!doctype html><title>partial</title>", {
        headers: { "Content-Type": "text/html" },
      }),
    );

    await expect(harness.message({ type: "VECTOR_STATUS" })).resolves.toEqual({
      ok: true,
      result: [],
    });
    expect(await harness.storage.has(stageName)).toBe(false);
    expect(await harness.storage.has(partialName)).toBe(false);
  });

  it("deletes a committed cache when any declared non-entry asset is missing", async () => {
    const harness = createWorkerHarness();
    const { manifest, manifestUrl, manifestSha256 } = createManifest(harness);
    await harness.message({ type: "VECTOR_INSTALL", manifestUrl, manifestSha256 });
    const targetName = `axis-vector-game:${manifest.gameId}:${manifest.gameVersion}:${manifest.buildId}`;
    const target = await harness.storage.open(targetName);
    await target.delete(`/_next/static/chunks/second-sense-${manifest.buildId}.js`);

    await expect(harness.message({ type: "VECTOR_STATUS" })).resolves.toEqual({
      ok: true,
      result: [],
    });
    expect(await harness.storage.has(targetName)).toBe(false);
    const meta = await harness.storage.open("axis-vector-meta:v3");
    expect(await meta.match("/vector-assets/.current/second-sense.json")).toBeUndefined();
  });

  it("keeps a fully valid current pointer authoritative over an uncommitted cache", async () => {
    const harness = createWorkerHarness();
    const oldCache = await seedCompleteCache(harness.storage, {
      gameVersion: "1.0.0",
      buildId: "old",
      installedAt: 100,
      current: true,
    });
    const recoveredCache = await seedCompleteCache(harness.storage, {
      gameVersion: "1.1.0",
      buildId: "recovered",
      installedAt: 200,
    });

    const status = await harness.message({ type: "VECTOR_STATUS" });
    expect(status).toMatchObject({
      ok: true,
      result: [{
        gameVersion: "1.0.0",
        buildId: "old",
        cacheName: oldCache.cacheName,
      }],
    });
    expect(await harness.storage.has(oldCache.cacheName)).toBe(true);
    expect(await harness.storage.has(recoveredCache.cacheName)).toBe(false);

    const meta = await harness.storage.open("axis-vector-meta:v3");
    const pointer = await meta.match(
      new URL("/vector-assets/.current/second-sense.json", ORIGIN),
    );
    await expect(pointer?.json()).resolves.toMatchObject({
      cacheName: oldCache.cacheName,
      buildId: "old",
    });
  });

  it("falls back to the newest complete cache when the current pointer is absent", async () => {
    const harness = createWorkerHarness();
    const oldCache = await seedCompleteCache(harness.storage, {
      gameVersion: "1.0.0",
      buildId: "old",
      installedAt: 100,
    });
    const recoveredCache = await seedCompleteCache(harness.storage, {
      gameVersion: "1.1.0",
      buildId: "recovered",
      installedAt: 200,
    });

    const status = await harness.message({ type: "VECTOR_STATUS" });
    expect(status).toMatchObject({
      ok: true,
      result: [{
        gameVersion: "1.1.0",
        buildId: "recovered",
        cacheName: recoveredCache.cacheName,
      }],
    });
    expect(await harness.storage.has(oldCache.cacheName)).toBe(false);
    expect(await harness.storage.has(recoveredCache.cacheName)).toBe(true);
  });

  it("does not serve cached assets through a partially mismatched current pointer", async () => {
    const harness = createWorkerHarness();
    const committed = await seedCompleteCache(harness.storage, {
      gameVersion: "1.0.0",
      buildId: "current",
      installedAt: 100,
      current: true,
    });
    const meta = await harness.storage.open("axis-vector-meta:v3");
    await meta.put(
      new URL("/vector-assets/.current/second-sense.json", ORIGIN),
      new Response(JSON.stringify({
        ...committed.marker,
        installedAt: committed.marker.installedAt + 1,
      }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    harness.route(
      "/vector-assets/offline/second-sense.html",
      "<!doctype html><title>network</title>",
      { headers: { "Content-Type": "text/html" } },
    );

    const response = await harness.asset("/vector-assets/offline/second-sense.html");
    expect(await response.text()).toContain("<title>network</title>");
  });

  it("serves a committed game entry for offline navigation and the lobby otherwise", async () => {
    const harness = createWorkerHarness();
    const { manifestUrl, manifestSha256, entryBody } = createManifest(harness);
    await harness.dispatchExtendable("install");
    await harness.message({ type: "VECTOR_INSTALL", manifestUrl, manifestSha256 });
    harness.setNavigationOffline(true);

    const gameResponse = await harness.navigation("/vector/second-sense");
    expect(await gameResponse.text()).toBe(entryBody);

    const lobbyResponse = await harness.navigation("/vector/not-installed");
    const lobby = await lobbyResponse.text();
    expect(lobby).toContain("No verified offline games are installed");
    expect(lobby).toContain("VECTOR_STATUS");
  });

  it("uses a verified game entry for same-origin 5xx without masking auth responses", async () => {
    const harness = createWorkerHarness();
    const { manifestUrl, manifestSha256, entryBody } = createManifest(harness);
    await harness.message({ type: "VECTOR_INSTALL", manifestUrl, manifestSha256 });

    harness.route("/vector/second-sense", "temporary upstream failure", { status: 503 });
    const fallback = await harness.navigation("/vector/second-sense");
    expect(fallback.status).toBe(200);
    expect(await fallback.text()).toBe(entryBody);

    harness.route("/vector/second-sense", "authentication required", { status: 401 });
    const unauthorized = await harness.navigation("/vector/second-sense");
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.text()).toBe("authentication required");

    harness.route("/vector/second-sense", "forbidden", { status: 403 });
    const forbidden = await harness.navigation("/vector/second-sense");
    expect(forbidden.status).toBe(403);
    expect(await forbidden.text()).toBe("forbidden");
  });

  it("exposes a protocol probe for controller upgrade handshakes", async () => {
    const harness = createWorkerHarness();
    await expect(harness.message({ type: "VECTOR_PING" })).resolves.toEqual({
      ok: true,
      result: { protocolVersion: 3 },
    });
  });
});

describe("VECTOR offline deployment boundaries", () => {
  it("keeps only reviewed worker artifacts public and guards VECTOR APIs by default", () => {
    expect(middleware).toContain("isPublicVectorArtifactPath(pathname)");
    expect(classifyAccess("/api/vector")).toBe("authenticated");
    expect(classifyAccess("/api/vector/install")).toBe("authenticated");
    expect(requiresSupabaseAuth(classifyAccess("/api/vector/install"))).toBe(true);
  });

  it("serves the root worker with explicit scope and no-cache headers", () => {
    expect(nextConfig).toContain('source: "/sw.js"');
    expect(nextConfig).toContain('"Service-Worker-Allowed", value: "/"');
    expect(nextConfig).toContain('"Cache-Control", value: "no-cache, no-store, must-revalidate"');
  });
});
