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
post-build step. All games remain disabled in Wave 15.2, so the committed
development map and generated deploy map are honestly empty until a playable
game passes this gate.
