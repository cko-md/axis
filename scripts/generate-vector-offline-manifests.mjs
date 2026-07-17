import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const IDENTIFIER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i;
const BUILD_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_ASSETS = 500;
const MAX_INSTALL_BYTES = 500 * 1024 * 1024;
const MAP_FILENAME = "build-map.json";
const VECTOR_GAME_IDS = [
  "second-sense",
  "brickrise",
  "time-to-fly",
  "paper-glider",
  "envoy-arena",
  "phantasy-axis",
  "biome-lab",
  "mini-town",
  "neon-rift",
];

function fail(code, detail) {
  throw new Error(`${code}${detail ? `: ${detail}` : ""}`);
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseJson(source, label) {
  try {
    return JSON.parse(source);
  } catch {
    return fail("VECTOR_OFFLINE_JSON_INVALID", label);
  }
}

function relativeAssetPath(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.posix.isAbsolute(value)
  ) {
    return fail("VECTOR_OFFLINE_PATH_INVALID", label);
  }
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    return fail("VECTOR_OFFLINE_PATH_INVALID", label);
  }
  return normalized;
}

function stringList(value, label) {
  if (!Array.isArray(value)) return fail("VECTOR_OFFLINE_CONFIG_INVALID", label);
  return value.map((item, index) => relativeAssetPath(item, `${label}[${index}]`));
}

function nextAssetPath(value, label) {
  const normalized = relativeAssetPath(value, label);
  if (!normalized.startsWith("static/")) {
    return fail("VECTOR_OFFLINE_NEXT_ASSET_INVALID", label);
  }
  return normalized;
}

function nextAssetList(value, label) {
  if (!Array.isArray(value)) return fail("VECTOR_OFFLINE_CONFIG_INVALID", label);
  return value.map((item, index) => nextAssetPath(item, `${label}[${index}]`));
}

function moduleKeyList(value, gameId, label) {
  if (!Array.isArray(value)) return fail("VECTOR_OFFLINE_CONFIG_INVALID", label);
  return value.map((item, index) => {
    if (
      typeof item !== "string" ||
      item.length < 1 ||
      item.length > 500 ||
      !item.toLowerCase().includes(gameId)
    ) {
      return fail("VECTOR_OFFLINE_LOADER_KEY_INVALID", `${label}[${index}]`);
    }
    return item;
  });
}

function loaderPatternList(value, gameId, label) {
  if (!Array.isArray(value)) return fail("VECTOR_OFFLINE_CONFIG_INVALID", label);
  return value.map((item, index) => {
    if (
      typeof item !== "string" ||
      !item.startsWith("static/chunks/") ||
      !item.endsWith(".js") ||
      !item.includes("*") ||
      item.includes("**") ||
      !item.includes(gameId) ||
      !/^[a-zA-Z0-9._/*-]+$/.test(item)
    ) {
      return fail("VECTOR_OFFLINE_LOADER_PATTERN_INVALID", `${label}[${index}]`);
    }
    return item;
  });
}

function parseConfig(value) {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.games)) {
    return fail("VECTOR_OFFLINE_CONFIG_INVALID", "root");
  }
  const seen = new Set();
  const games = value.games.map((raw, index) => {
    if (
      !isRecord(raw) ||
      !IDENTIFIER.test(raw.gameId) ||
      typeof raw.enabled !== "boolean" ||
      seen.has(raw.gameId)
    ) {
      return fail("VECTOR_OFFLINE_CONFIG_INVALID", `games[${index}]`);
    }
    seen.add(raw.gameId);
    if (!raw.enabled) return { gameId: raw.gameId, enabled: false };
    if (
      !VERSION.test(raw.gameVersion) ||
      typeof raw.offlineEntry !== "string"
    ) {
      return fail("VECTOR_OFFLINE_CONFIG_INVALID", `games[${index}]`);
    }
    const offlineEntry = relativeAssetPath(
      raw.offlineEntry,
      `games[${index}].offlineEntry`,
    );
    if (!offlineEntry.startsWith("vector-assets/offline/") || !offlineEntry.endsWith(".html")) {
      return fail("VECTOR_OFFLINE_ENTRY_INVALID", raw.gameId);
    }
    const publicAssets = stringList(raw.publicAssets, `games[${index}].publicAssets`);
    const nextAssets = nextAssetList(raw.nextAssets ?? [], `games[${index}].nextAssets`);
    const loadableModules = moduleKeyList(
      raw.loadableModules ?? [],
      raw.gameId,
      `games[${index}].loadableModules`,
    );
    const loaderChunkPatterns = loaderPatternList(
      raw.loaderChunkPatterns ?? [],
      raw.gameId,
      `games[${index}].loaderChunkPatterns`,
    );
    const appPaths = Array.isArray(raw.appPaths) ? raw.appPaths : [];
    if (appPaths.some((item) => typeof item !== "string" || !item.startsWith("/"))) {
      return fail("VECTOR_OFFLINE_APP_PATH_INVALID", raw.gameId);
    }
    if (!publicAssets.includes(offlineEntry)) {
      return fail("VECTOR_OFFLINE_ENTRY_MISSING", raw.gameId);
    }
    if (loadableModules.length === 0 && loaderChunkPatterns.length === 0) {
      return fail("VECTOR_OFFLINE_LOADER_RESOLUTION_REQUIRED", raw.gameId);
    }
    return {
      gameId: raw.gameId,
      enabled: true,
      gameVersion: raw.gameVersion,
      offlineEntry,
      publicAssets,
      nextAssets,
      appPaths: [...new Set(appPaths)],
      loadableModules: [...new Set(loadableModules)],
      loaderChunkPatterns: [...new Set(loaderChunkPatterns)],
    };
  });
  const ids = [...seen].sort(compareText);
  const expected = [...VECTOR_GAME_IDS].sort(compareText);
  if (JSON.stringify(ids) !== JSON.stringify(expected)) {
    return fail("VECTOR_OFFLINE_CATALOG_MISMATCH");
  }
  return games;
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function readContainedFile(root, relativePath, label) {
  const rootReal = await realpath(root).catch(() => fail("VECTOR_OFFLINE_ROOT_MISSING", root));
  const candidate = path.resolve(root, relativePath);
  if (!isContained(path.resolve(root), candidate)) {
    return fail("VECTOR_OFFLINE_PATH_ESCAPE", label);
  }
  const sourceStat = await lstat(candidate).catch(() => fail("VECTOR_OFFLINE_ASSET_MISSING", label));
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    return fail("VECTOR_OFFLINE_ASSET_INVALID", label);
  }
  const candidateReal = await realpath(candidate).catch(() => fail("VECTOR_OFFLINE_ASSET_MISSING", label));
  if (!isContained(rootReal, candidateReal)) {
    return fail("VECTOR_OFFLINE_PATH_ESCAPE", label);
  }
  const stat = await lstat(candidateReal);
  if (!stat.isFile()) {
    return fail("VECTOR_OFFLINE_ASSET_INVALID", label);
  }
  return readFile(candidateReal);
}

function digest(buffer) {
  const value = createHash("sha256").update(buffer).digest("hex");
  if (!SHA256.test(value)) return fail("VECTOR_OFFLINE_DIGEST_MISSING");
  return value;
}

async function atomicWrite(filename, body) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, body, { flag: "wx" });
  await rename(temporary, filename);
}

function generatedManifestFilename(filename) {
  if (filename === MAP_FILENAME || !filename.endsWith(".json")) return false;
  return VECTOR_GAME_IDS.some((gameId) => {
    const prefix = `${gameId}-`;
    if (!filename.startsWith(prefix)) return false;
    const buildId = filename.slice(prefix.length, -".json".length);
    return BUILD_ID.test(buildId);
  });
}

async function cleanupStaleGeneratedManifests(outputRoot, currentNames) {
  const entries = await readdir(outputRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (
      entry.isFile() &&
      generatedManifestFilename(entry.name) &&
      !currentNames.has(entry.name)
    ) {
      await unlink(path.join(outputRoot, entry.name));
    }
  }
}

function jsonDocument(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function patternExpression(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", "[^/]*")}$`);
}

async function listBuildChunkFiles(buildRoot) {
  const root = path.join(buildRoot, "static/chunks");
  const files = [];
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => (
      fail("VECTOR_OFFLINE_CHUNK_ROOT_MISSING", directory)
    ));
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) fail("VECTOR_OFFLINE_ASSET_INVALID", filename);
      if (entry.isDirectory()) {
        await visit(filename);
      } else if (entry.isFile()) {
        files.push(path.relative(buildRoot, filename).split(path.sep).join("/"));
      }
    }
  };
  await visit(root);
  return files.sort(compareText);
}

function buildAssetSources(
  game,
  appBuildManifest,
  loadableManifest,
  buildChunkFiles,
) {
  const sources = new Map();
  const add = (url, root, relativePath) => {
    if (!sources.has(url)) sources.set(url, { url, root, relativePath });
  };
  for (const relativePath of game.publicAssets) {
    add(`/${relativePath}`, "public", relativePath);
  }
  for (const relativePath of game.nextAssets) {
    add(`/_next/${relativePath}`, "build", relativePath);
  }
  for (const appPath of game.appPaths) {
    const assets = appBuildManifest?.pages?.[appPath];
    if (!Array.isArray(assets) || assets.length < 1) {
      fail("VECTOR_OFFLINE_APP_PATH_MISSING", `${game.gameId}:${appPath}`);
    }
    for (const rawAsset of assets) {
      const relativePath = nextAssetPath(rawAsset, `${game.gameId}:${appPath}`);
      add(`/_next/${relativePath}`, "build", relativePath);
    }
  }
  for (const moduleKey of game.loadableModules) {
    const declaration = loadableManifest?.[moduleKey];
    if (!isRecord(declaration) || !Array.isArray(declaration.files) || declaration.files.length < 1) {
      fail("VECTOR_OFFLINE_LOADER_KEY_MISSING", `${game.gameId}:${moduleKey}`);
    }
    let javascriptFiles = 0;
    for (const rawAsset of declaration.files) {
      const relativePath = nextAssetPath(rawAsset, `${game.gameId}:${moduleKey}`);
      if (relativePath.endsWith(".js")) javascriptFiles += 1;
      add(`/_next/${relativePath}`, "build", relativePath);
    }
    if (javascriptFiles === 0) {
      fail("VECTOR_OFFLINE_LOADER_CHUNK_MISSING", `${game.gameId}:${moduleKey}`);
    }
  }
  for (const pattern of game.loaderChunkPatterns) {
    const expression = patternExpression(pattern);
    const matches = buildChunkFiles.filter((filename) => expression.test(filename));
    if (matches.length < 1 || matches.length > 20) {
      fail("VECTOR_OFFLINE_LOADER_PATTERN_MISMATCH", `${game.gameId}:${pattern}`);
    }
    for (const relativePath of matches) {
      add(`/_next/${relativePath}`, "build", relativePath);
    }
  }
  return [...sources.values()].sort((left, right) => compareText(left.url, right.url));
}

export async function generateVectorOfflineManifests({
  projectRoot = process.cwd(),
  configPath = path.join(projectRoot, "config/vector-offline-packages.json"),
  buildRoot = path.join(projectRoot, ".next"),
  publicRoot = path.join(projectRoot, "public"),
  outputRoot = path.join(publicRoot, "vector-assets/manifests"),
} = {}) {
  const config = parseConfig(parseJson(await readFile(configPath, "utf8"), configPath));
  const buildId = (await readFile(path.join(buildRoot, "BUILD_ID"), "utf8")).trim();
  if (!BUILD_ID.test(buildId)) fail("VECTOR_OFFLINE_BUILD_ID_INVALID");

  const enabled = config.filter((game) => game.enabled);
  let appBuildManifest = null;
  if (enabled.some((game) => game.appPaths.length > 0)) {
    const filename = path.join(buildRoot, "app-build-manifest.json");
    appBuildManifest = parseJson(await readFile(filename, "utf8"), filename);
    if (!isRecord(appBuildManifest) || !isRecord(appBuildManifest.pages)) {
      fail("VECTOR_OFFLINE_APP_MANIFEST_INVALID");
    }
  }
  let loadableManifest = null;
  if (enabled.some((game) => game.loadableModules.length > 0)) {
    const filename = path.join(buildRoot, "react-loadable-manifest.json");
    loadableManifest = parseJson(await readFile(filename, "utf8"), filename);
    if (!isRecord(loadableManifest)) fail("VECTOR_OFFLINE_LOADABLE_MANIFEST_INVALID");
  }
  const buildChunkFiles = enabled.some((game) => game.loaderChunkPatterns.length > 0)
    ? await listBuildChunkFiles(buildRoot)
    : [];

  const mappingGames = [];
  const manifestDocuments = [];
  for (const game of enabled.sort((left, right) => compareText(left.gameId, right.gameId))) {
    const sources = buildAssetSources(
      game,
      appBuildManifest,
      loadableManifest,
      buildChunkFiles,
    );
    if (sources.length < 1 || sources.length > MAX_ASSETS) {
      fail("VECTOR_OFFLINE_ASSET_COUNT_INVALID", game.gameId);
    }
    const assets = [];
    let estimatedBytes = 0;
    for (const source of sources) {
      const root = source.root === "public" ? publicRoot : buildRoot;
      const body = await readContainedFile(root, source.relativePath, `${game.gameId}:${source.url}`);
      estimatedBytes += body.byteLength;
      if (estimatedBytes > MAX_INSTALL_BYTES) {
        fail("VECTOR_OFFLINE_PACKAGE_TOO_LARGE", game.gameId);
      }
      assets.push({
        url: source.url,
        bytes: body.byteLength,
        sha256: digest(body),
      });
    }

    const offlineEntryUrl = `/${game.offlineEntry}`;
    if (!assets.some((asset) => asset.url === offlineEntryUrl)) {
      fail("VECTOR_OFFLINE_ENTRY_MISSING", game.gameId);
    }
    const manifest = {
      schemaVersion: 1,
      gameId: game.gameId,
      gameVersion: game.gameVersion,
      buildId,
      offlineEntryUrl,
      estimatedBytes,
      assets,
    };
    const manifestBody = Buffer.from(jsonDocument(manifest));
    const manifestName = `${game.gameId}-${buildId}.json`;
    manifestDocuments.push({ manifestName, manifestBody });
    mappingGames.push({
      gameId: game.gameId,
      gameVersion: game.gameVersion,
      buildId,
      manifestUrl: `/vector-assets/manifests/${manifestName}`,
      manifestSha256: digest(manifestBody),
      offlineEntryUrl,
      estimatedBytes,
    });
  }

  const mapping = {
    schemaVersion: 1,
    buildId,
    games: mappingGames,
  };
  for (const document of manifestDocuments) {
    await atomicWrite(
      path.join(outputRoot, document.manifestName),
      document.manifestBody,
    );
  }
  await atomicWrite(path.join(outputRoot, MAP_FILENAME), jsonDocument(mapping));
  await cleanupStaleGeneratedManifests(
    outputRoot,
    new Set(manifestDocuments.map((document) => document.manifestName)),
  );
  return mapping;
}

async function main() {
  const mapping = await generateVectorOfflineManifests();
  process.stdout.write(`VECTOR offline manifests: ${mapping.games.length} enabled game(s) for ${mapping.buildId}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "VECTOR_OFFLINE_GENERATION_FAILED"}\n`);
    process.exitCode = 1;
  });
}
