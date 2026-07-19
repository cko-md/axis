# VECTOR offline package gate

`npm run build` runs `scripts/generate-vector-offline-manifests.mjs` after the
Next build. The generator reads `config/vector-offline-packages.json`, hashes
the exact public and `/_next/static/` files in that deploy, writes an immutable
per-game manifest, and publishes
`/vector-assets/manifests/build-map.json`. The service worker accepts an install
only when that build map names the manifest and its SHA-256 digest.
After the new map is published, the generator removes only stale files matching
the validated `<catalog-game>-<build-id>.json` format; unrelated operator files
are left untouched.
The client and worker use protocol v3; activation removes v1/v2 VECTOR shell
and metadata caches so the former inventory-less contract cannot appear
compatible.

An enabled game must declare its standalone public HTML entry and a dynamic
loader-chunk resolution method:

- `loadableModules`: exact keys from `.next/react-loadable-manifest.json`; or
- `loaderChunkPatterns`: game-specific `static/chunks/*.js` patterns that match
  one to twenty files in the completed build.

`appPaths` adds the route's files from `.next/app-build-manifest.json`, but does
not replace loader-chunk resolution. Missing paths, missing files, non-static
Next paths, ambiguous patterns, absent digests, and catalog drift fail the
post-build step.

## Wave 15.3: Second Sense is the first enabled game

`config/vector-offline-packages.json` flips `second-sense` to `enabled: true`
(every other catalog entry stays `false` — Wave 15.2's rule that a title must
pass its own complete-game gate before enabling still holds). Its standalone
offline shell has two parts:

- `public/vector-assets/offline/second-sense.html` — the static HTML the
  service worker substitutes for the real `/vector/second-sense` Next route
  when the network is unreachable (see `matchInstalledGameNavigation` in
  `public/sw.js`).
- `public/vector-assets/offline/second-sense.js` — a framework-free bundle of
  the actual game engine (`src/lib/vector/games/second-sense/game.ts`),
  persistence (`persistence.ts`), and runtime host (`runtime.ts`), built by
  `scripts/build-vector-offline-bootstrap.mjs` via esbuild. It is deliberately
  NOT part of the webpack/Next build: it has to keep working when the Next
  server (and therefore the webpack runtime that resolves content-hashed
  chunk URLs) is unreachable. `npm run build`'s `postbuild` hook runs this
  esbuild step before the manifest generator, since the generator hashes
  whatever exists in `public/` at that moment.
- `loaderChunkPatterns: ["static/chunks/second-sense.*.js"]` additionally
  caches the real in-app webpack loader chunk
  (`src/lib/vector/loaders.ts`'s `webpackChunkName: "second-sense"` dynamic
  import), so the online in-app runtime also works from cache if the Next
  app shell itself was already cached from an earlier visit.

Both bundles run against the SAME `"axis-vector"` IndexedDB database and the
SAME owner key already established while online (`openVectorRepository()`
requires no network) — there is no separate offline data silo, and a save
made fully offline is picked up by the normal reconnect push/pull/merge flow
the next time the app runs online.

The remaining eight games stay disabled until each passes its own
complete-game gate.
