import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateVectorOfflineManifests } from "../../../scripts/generate-vector-offline-manifests.mjs";
import deploymentConfig from "../../../config/vector-offline-packages.json";
import { VECTOR_GAME_SLUGS } from "@/lib/vector/types";

const roots: string[] = [];
const CATALOG = [...VECTOR_GAME_SLUGS];

function catalogWith(
  enabled?: Record<string, unknown> & { gameId: (typeof VECTOR_GAME_SLUGS)[number] },
) {
  return CATALOG.map((gameId) => (
    enabled?.gameId === gameId ? enabled : { gameId, enabled: false }
  ));
}

async function fixtureRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "vector-offline-generator-"));
  roots.push(root);
  await mkdir(path.join(root, ".next/static/chunks"), { recursive: true });
  await mkdir(path.join(root, "public/vector-assets/offline"), { recursive: true });
  await mkdir(path.join(root, "config"), { recursive: true });
  await writeFile(path.join(root, ".next/BUILD_ID"), "fixture-build\n");
  return root;
}

function digest(body: Buffer | string) {
  return createHash("sha256").update(body).digest("hex");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("VECTOR deploy-specific offline manifest generator", () => {
  it("keeps deployment config game IDs exactly aligned with the typed registry", () => {
    expect(deploymentConfig.games.map((game) => game.gameId)).toEqual(CATALOG);
  });

  it("publishes an honest empty build map while every game is disabled", async () => {
    const root = await fixtureRoot();
    const outputRoot = path.join(root, "public/vector-assets/manifests");
    await mkdir(outputRoot, { recursive: true });
    const staleManifest = path.join(outputRoot, "second-sense-old-build.json");
    const unrelatedJson = path.join(outputRoot, "operator-notes.json");
    await writeFile(staleManifest, "{}\n");
    await writeFile(unrelatedJson, "{}\n");
    await writeFile(path.join(root, "config/vector-offline-packages.json"), JSON.stringify({
      schemaVersion: 1,
      games: catalogWith(),
    }));

    const mapping = await generateVectorOfflineManifests({ projectRoot: root });
    expect(mapping).toEqual({
      schemaVersion: 1,
      buildId: "fixture-build",
      games: [],
    });
    await expect(readFile(
      path.join(root, "public/vector-assets/manifests/build-map.json"),
      "utf8",
    )).resolves.toContain('"games": []');
    await expect(readFile(staleManifest, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(unrelatedJson, "utf8")).resolves.toBe("{}\n");
  });

  it("hashes the exact route and public files and publishes a digest-bound mapping", async () => {
    const root = await fixtureRoot();
    const entry = "<!doctype html><title>Second Sense Offline</title>";
    const chunk = "self.SECOND_SENSE = true;";
    const publicAsset = "fixture-tone";
    const loaderChunk = "self.SECOND_SENSE_LOADER = true;";
    await writeFile(path.join(root, "public/vector-assets/offline/second-sense.html"), entry);
    await writeFile(path.join(root, "public/vector-assets/offline/tone.bin"), publicAsset);
    await writeFile(path.join(root, ".next/static/chunks/second-sense.js"), chunk);
    await writeFile(
      path.join(root, ".next/static/chunks/vector-second-sense-loader.js"),
      loaderChunk,
    );
    await writeFile(path.join(root, ".next/app-build-manifest.json"), JSON.stringify({
      pages: { "/vector/[game]/page": ["static/chunks/second-sense.js"] },
    }));
    const loadableKey = "src/lib/vector/loaders.ts -> @/games/second-sense";
    await writeFile(path.join(root, ".next/react-loadable-manifest.json"), JSON.stringify({
      [loadableKey]: {
        id: 42,
        files: ["static/chunks/vector-second-sense-loader.js"],
      },
    }));
    await writeFile(path.join(root, "config/vector-offline-packages.json"), JSON.stringify({
      schemaVersion: 1,
      games: catalogWith({
        gameId: "second-sense",
        enabled: true,
        gameVersion: "1.2.3",
        offlineEntry: "vector-assets/offline/second-sense.html",
        publicAssets: [
          "vector-assets/offline/second-sense.html",
          "vector-assets/offline/tone.bin",
        ],
        appPaths: ["/vector/[game]/page"],
        loadableModules: [loadableKey],
      }),
    }));

    const mapping = await generateVectorOfflineManifests({ projectRoot: root });
    expect(mapping.games).toHaveLength(1);
    const deployment = mapping.games[0];
    const manifestFilename = path.join(
      root,
      "public",
      deployment.manifestUrl.slice(1),
    );
    const manifestBody = await readFile(manifestFilename);
    const manifest = JSON.parse(manifestBody.toString());

    expect(deployment).toMatchObject({
      gameId: "second-sense",
      gameVersion: "1.2.3",
      buildId: "fixture-build",
      manifestSha256: digest(manifestBody),
    });
    expect(manifest.assets).toEqual([
      {
        url: "/_next/static/chunks/second-sense.js",
        bytes: Buffer.byteLength(chunk),
        sha256: digest(chunk),
      },
      {
        url: "/_next/static/chunks/vector-second-sense-loader.js",
        bytes: Buffer.byteLength(loaderChunk),
        sha256: digest(loaderChunk),
      },
      {
        url: "/vector-assets/offline/second-sense.html",
        bytes: Buffer.byteLength(entry),
        sha256: digest(entry),
      },
      {
        url: "/vector-assets/offline/tone.bin",
        bytes: Buffer.byteLength(publicAsset),
        sha256: digest(publicAsset),
      },
    ]);
    expect(manifest.estimatedBytes).toBe(
      Buffer.byteLength(chunk)
      + Buffer.byteLength(loaderChunk)
      + Buffer.byteLength(entry)
      + Buffer.byteLength(publicAsset),
    );
  });

  it("fails closed when an enabled package declares a missing built asset", async () => {
    const root = await fixtureRoot();
    await writeFile(
      path.join(root, "public/vector-assets/offline/second-sense.html"),
      "<!doctype html>",
    );
    await writeFile(
      path.join(root, ".next/static/chunks/vector-second-sense-loader.js"),
      "loader",
    );
    await writeFile(path.join(root, "config/vector-offline-packages.json"), JSON.stringify({
      schemaVersion: 1,
      games: catalogWith({
        gameId: "second-sense",
        enabled: true,
        gameVersion: "1.0.0",
        offlineEntry: "vector-assets/offline/second-sense.html",
        publicAssets: ["vector-assets/offline/second-sense.html"],
        nextAssets: ["static/chunks/missing.js"],
        loaderChunkPatterns: ["static/chunks/vector-second-sense-*.js"],
      }),
    }));

    await expect(generateVectorOfflineManifests({ projectRoot: root })).rejects.toThrow(
      "VECTOR_OFFLINE_ASSET_MISSING",
    );
  });

  it("rejects server-only build paths that the worker can never cache", async () => {
    const root = await fixtureRoot();
    await writeFile(
      path.join(root, "public/vector-assets/offline/second-sense.html"),
      "<!doctype html>",
    );
    await writeFile(path.join(root, "config/vector-offline-packages.json"), JSON.stringify({
      schemaVersion: 1,
      games: catalogWith({
        gameId: "second-sense",
        enabled: true,
        gameVersion: "1.0.0",
        offlineEntry: "vector-assets/offline/second-sense.html",
        publicAssets: ["vector-assets/offline/second-sense.html"],
        nextAssets: ["server/app/vector/page.js"],
        loaderChunkPatterns: ["static/chunks/vector-second-sense-*.js"],
      }),
    }));

    await expect(generateVectorOfflineManifests({ projectRoot: root })).rejects.toThrow(
      "VECTOR_OFFLINE_NEXT_ASSET_INVALID",
    );
  });
});
