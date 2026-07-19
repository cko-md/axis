#!/usr/bin/env node
/**
 * Bundles the standalone VECTOR offline bootstrap(s) into
 * public/vector-assets/offline/<gameId>.js — a stable, non-webpack-hashed
 * path referenced directly from each game's static offline entry HTML (see
 * public/vector-assets/offline/<gameId>.html and
 * config/vector-offline-packages.json).
 *
 * Must run BEFORE scripts/generate-vector-offline-manifests.mjs (see the
 * "postbuild" script in package.json): the manifest generator hashes exactly
 * the public/ files that exist on disk when it runs, so the bundle has to be
 * written first.
 *
 * Deliberately esbuild, not the Next/webpack pipeline: this bundle boots
 * completely outside the Next app (the whole point is that it still works
 * when the network — and therefore the Next server — is unreachable), so it
 * cannot depend on a webpack runtime, content-hashed chunk URLs, or any
 * Next-specific module resolution.
 */
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");

const BOOTSTRAPS = [
  {
    gameId: "second-sense",
    entry: "src/lib/vector/games/second-sense/offline-bootstrap.ts",
    outfile: "public/vector-assets/offline/second-sense.js",
  },
];

async function main() {
  for (const bootstrap of BOOTSTRAPS) {
    await build({
      absWorkingDir: projectRoot,
      entryPoints: [bootstrap.entry],
      outfile: bootstrap.outfile,
      bundle: true,
      format: "esm",
      target: "es2020",
      minify: true,
      sourcemap: false,
      platform: "browser",
      logLevel: "silent",
      alias: { "@": path.join(projectRoot, "src") },
      define: {
        // The bundled tree can reach code that branches on NODE_ENV (e.g.
        // shared observability helpers); force the production branch since
        // this artifact is only ever served to real players.
        "process.env.NODE_ENV": '"production"',
      },
    });
    process.stdout.write(`VECTOR offline bootstrap: built ${bootstrap.outfile}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`VECTOR offline bootstrap build failed: ${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
