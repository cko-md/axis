import { describe, expect, it } from "vitest";
import {
  decodeVectorWorkerResponse,
  isAllowedVectorManifestUrl,
  isAllowedVectorOfflineAssetUrl,
  isAllowedVectorOfflineEntryUrl,
  isQuotaExceededError,
  parseVectorOfflineManifest,
  VectorOfflineWorkerError,
  vectorOfflineCacheName,
  waitForCompatibleVectorWorker,
  type VectorWorkerContainer,
  type VectorWorkerEndpoint,
  type VectorWorkerRegistration,
} from "@/lib/vector/offline";

const BASE = "https://axis.example";

function asset(url: string, bytes = 10) {
  return { url, bytes, sha256: "a".repeat(64) };
}

class FakeWorker extends EventTarget implements VectorWorkerEndpoint {
  state = "activated";

  constructor(
    private readonly handler: (
      message: unknown,
      responsePort: MessagePort | undefined,
    ) => void,
  ) {
    super();
  }

  postMessage(message: unknown, transfer: Transferable[]): void {
    this.handler(message, transfer[0] instanceof MessagePort ? transfer[0] : undefined);
  }
}

function eventMethods(target: EventTarget) {
  return {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  };
}

describe("VECTOR offline boundary", () => {
  it("allows only same-origin immutable chunks, public vector assets, and the offline document", () => {
    expect(isAllowedVectorOfflineAssetUrl("/_next/static/chunks/game.js", BASE)).toBe(true);
    expect(isAllowedVectorOfflineAssetUrl("/vector-assets/second-sense/tone.ogg", BASE)).toBe(true);
    expect(isAllowedVectorOfflineAssetUrl("/vector-offline.html", BASE)).toBe(true);

    expect(isAllowedVectorOfflineAssetUrl("/api/vector/bootstrap", BASE)).toBe(false);
    expect(isAllowedVectorOfflineAssetUrl("/auth/callback", BASE)).toBe(false);
    expect(isAllowedVectorOfflineAssetUrl("/vector/second-sense", BASE)).toBe(false);
    expect(isAllowedVectorOfflineAssetUrl("https://cdn.example/game.js", BASE)).toBe(false);
    expect(isAllowedVectorOfflineAssetUrl("https://axis.example@evil.example/game.js", BASE)).toBe(false);
    expect(isAllowedVectorOfflineAssetUrl("/vector-assets/.installed/forged.json", BASE)).toBe(false);
    expect(isAllowedVectorOfflineAssetUrl("/vector-assets/.current/forged.json", BASE)).toBe(false);
  });

  it("requires a dedicated same-origin HTML entry point for offline navigation", () => {
    expect(isAllowedVectorOfflineEntryUrl("/vector-assets/offline/second-sense.html", BASE)).toBe(true);
    expect(isAllowedVectorOfflineEntryUrl("/vector-assets/offline/second-sense.js", BASE)).toBe(false);
    expect(isAllowedVectorOfflineEntryUrl("/vector/second-sense", BASE)).toBe(false);
    expect(isAllowedVectorOfflineEntryUrl("https://other.example/vector-assets/offline/game.html", BASE)).toBe(false);
  });

  it("accepts only same-origin JSON build manifests in the dedicated public directory", () => {
    expect(isAllowedVectorManifestUrl("/vector-assets/manifests/second-sense.json", BASE)).toBe(true);
    expect(isAllowedVectorManifestUrl("/vector-assets/manifests/second-sense.txt", BASE)).toBe(false);
    expect(isAllowedVectorManifestUrl("/api/vector/manifest.json", BASE)).toBe(false);
    expect(isAllowedVectorManifestUrl("https://other.example/vector-assets/manifests/x.json", BASE)).toBe(false);
  });

  it("validates digest, uniqueness, and exact declared byte totals", () => {
    const valid = {
      schemaVersion: 1 as const,
      gameId: "second-sense",
      gameVersion: "1.0.0",
      buildId: "build-1",
      offlineEntryUrl: "/vector-assets/offline/second-sense.html",
      estimatedBytes: 20,
      assets: [
        asset("/_next/static/chunks/second-sense.js"),
        asset("/vector-assets/offline/second-sense.html"),
      ],
    };
    expect(parseVectorOfflineManifest(valid, BASE)).toEqual({ ok: true, manifest: valid });
    expect(parseVectorOfflineManifest({ ...valid, estimatedBytes: 19 }, BASE)).toEqual({
      ok: false,
      error: "OFFLINE_SIZE_MISMATCH",
    });
    expect(parseVectorOfflineManifest({ ...valid, assets: [valid.assets[0], valid.assets[0]] }, BASE)).toEqual({
      ok: false,
      error: "DUPLICATE_OFFLINE_ASSET",
    });
    expect(parseVectorOfflineManifest({
      ...valid,
      assets: [asset("/api/vector/sync"), valid.assets[1]],
    }, BASE)).toEqual({
      ok: false,
      error: "OFFLINE_ASSET_NOT_ALLOWED",
    });
    expect(parseVectorOfflineManifest({ ...valid, buildId: "../other-cache" }, BASE)).toEqual({
      ok: false,
      error: "INVALID_OFFLINE_MANIFEST",
    });
    expect(parseVectorOfflineManifest({
      ...valid,
      estimatedBytes: 500 * 1024 * 1024 + 1,
    }, BASE)).toEqual({
      ok: false,
      error: "INVALID_OFFLINE_MANIFEST",
    });
    expect(parseVectorOfflineManifest({
      ...valid,
      offlineEntryUrl: "/vector-assets/offline/not-in-assets.html",
    }, BASE)).toEqual({
      ok: false,
      error: "INVALID_OFFLINE_MANIFEST",
    });
  });

  it("creates deploy-specific game cache names", () => {
    expect(vectorOfflineCacheName({
      gameId: "second-sense",
      gameVersion: "1.2.0",
      buildId: "build-abc",
    })).toBe("axis-vector-game:second-sense:1.2.0:build-abc");
  });

  it("normalizes browser quota failures without swallowing unrelated errors", () => {
    expect(isQuotaExceededError({ name: "QuotaExceededError" })).toBe(true);
    expect(isQuotaExceededError({ code: 22 })).toBe(true);
    expect(isQuotaExceededError(new Error("network"))).toBe(false);
  });

  it("preserves safe worker error messages and normalized codes", () => {
    expect(decodeVectorWorkerResponse<number>({ ok: true, result: 7 })).toBe(7);
    expect(() => decodeVectorWorkerResponse({
      ok: false,
      error: {
        code: "VECTOR_OFFLINE_QUOTA_EXCEEDED",
        message: "There is not enough browser storage to install this game.",
      },
    })).toThrowError("There is not enough browser storage to install this game.");

    try {
      decodeVectorWorkerResponse({
        ok: false,
        error: {
          code: "VECTOR_OFFLINE_QUOTA_EXCEEDED",
          message: "There is not enough browser storage to install this game.",
        },
      });
      throw new Error("expected decoder failure");
    } catch (error) {
      expect(error).toBeInstanceOf(VectorOfflineWorkerError);
      expect((error as VectorOfflineWorkerError).code).toBe("VECTOR_OFFLINE_QUOTA_EXCEEDED");
    }
  });

  it("waits for protocol v3 instead of accepting an incompatible v2 controller", async () => {
    const oldWorker = new FakeWorker((message, port) => {
      if (
        port &&
        typeof message === "object" &&
        message &&
        "type" in message &&
        message.type === "VECTOR_PING"
      ) {
        port.postMessage({ ok: true, result: { protocolVersion: 2 } });
      }
    });
    const newWorker = new FakeWorker((message, port) => {
      if (
        port &&
        typeof message === "object" &&
        message &&
        "type" in message &&
        message.type === "VECTOR_PING"
      ) {
        port.postMessage({ ok: true, result: { protocolVersion: 3 } });
      }
    });
    const registrationEvents = new EventTarget();
    const containerEvents = new EventTarget();
    const registration: VectorWorkerRegistration = {
      active: oldWorker,
      waiting: null,
      installing: null,
      ...eventMethods(registrationEvents),
    };
    const container: VectorWorkerContainer = {
      controller: oldWorker,
      ...eventMethods(containerEvents),
    };

    const pending = waitForCompatibleVectorWorker(registration, container, {
      totalTimeoutMs: 500,
      pingTimeoutMs: 30,
      pollIntervalMs: 10,
    });
    setTimeout(() => {
      registration.waiting = newWorker;
      registrationEvents.dispatchEvent(new Event("updatefound"));
    }, 5);

    await expect(pending).resolves.toBe(newWorker);
  });
});
