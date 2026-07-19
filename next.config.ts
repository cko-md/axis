import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const CSP = [
  "default-src 'self'",
  // Next.js App Router requires unsafe-inline for hydration scripts;
  // cdn.plaid.com loads the Plaid Link iframe initializer
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.plaid.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://api.fontshare.com",
  "font-src 'self' https://fonts.gstatic.com https://api.fontshare.com https://cdn.fontshare.com data:",
  // blob: needed for gallery image previews; data: for inline SVGs
  "img-src 'self' data: blob: https:",
  // external audio/video previews (briefing/literature) need media from any https host
  "media-src 'self' https: blob: data:",
  [
    "connect-src 'self'",
    "http://127.0.0.1:54321 ws://127.0.0.1:54321",
    "https://*.supabase.co wss://*.supabase.co",
    "https://api.pwnedpasswords.com",
    "https://api.anthropic.com",
    "https://generativelanguage.googleapis.com",
    "https://api.polygon.io",
    "https://api.open-meteo.com",
    "https://api.spotify.com https://accounts.spotify.com",
    "https://*.plaid.com",
    "https://www.strava.com",
    "https://www.rijksmuseum.nl",
    "https://api.artic.edu",
    "https://collectionapi.metmuseum.org",
    "https://openaccess-api.clevelandart.org",
    "https://poetrydb.org https://gutendex.com https://openlibrary.org",
    // Sentry error/perf ingest
    "https://*.ingest.sentry.io https://*.ingest.us.sentry.io https://*.ingest.de.sentry.io",
  ].join(" "),
  // 'self' allows the in-app WebViewer's same-origin /api/proxy iframe; cdn.plaid.com
  // for Plaid Link; open.spotify.com for the Listening Vault's official embed player;
  // youtube.com/-nocookie for the Vault's Video Lounge embed player (mirrors the
  // Spotify pattern — direct official embed iframe instead of page-scraping proxy)
  "frame-src 'self' https://cdn.plaid.com https://open.spotify.com https://www.youtube.com https://www.youtube-nocookie.com blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  ...(
    process.env.VERCEL === "1"
    || process.env.NEXT_PUBLIC_APP_URL?.startsWith("https://")
      ? ["upgrade-insecure-requests"]
      : []
  ),
].join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // geolocation=(self) — Location Services (Interface Studio) calls
  // navigator.geolocation from this origin for local weather/air-quality/
  // daylight widgets; an empty allowlist here blocks the API outright
  // before the browser's own permission prompt ever runs. Camera/mic stay
  // fully disabled since nothing in the app uses them.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self)" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Exclude browser-only packages from the server bundle (SSR/prerendering)
  serverExternalPackages: ["@simplewebauthn/browser", "jsdom"],
  webpack(config, { isServer }) {
    config.cache = false;
    config.ignoreWarnings = [
      ...(config.ignoreWarnings ?? []),
      /A Node\.js API is used \(process\.version[\s\S]*Edge Runtime/,
    ];
    // Keep a native (non-WASM) digest to avoid intermittent wasm-hash crashes
    // observed in single-process webpack builds.
    config.output.hashFunction = "sha256";
    // jsdom (used by the reader route via @mozilla/readability) ships a
    // default-stylesheet.css it reads relative to __dirname; bundling it breaks
    // `next build` page-data collection. Keep it external so it's require()d
    // from node_modules at runtime (route pins runtime = 'nodejs').
    if (isServer) {
      const prev = config.externals;
      config.externals = [
        ...(Array.isArray(prev) ? prev : prev ? [prev] : []),
        "jsdom",
      ];
    }

    // ── VECTOR game-engine vendor chunks ─────────────────────────────────────
    // A game engine must land in a chunk named `vector-engine-<engine>` so
    // scripts/check-bundle-budget.mjs can bill it to the route-isolated game
    // budget instead of the shared application bundle. Without this, Next's own
    // `lib` cacheGroup (priority 30) claims Phaser into a hash-named vendor
    // chunk that the budget script cannot classify — which reads as a ~1.1 MB
    // shared-bundle regression even though no non-game route ever loads it.
    //
    // The name MUST come from here and NOT from a `webpackChunkName` magic
    // comment at the import site. Doing both silently defeats both: the magic
    // comment pre-registers the name in `compilation.namedChunks`, and
    // SplitChunksPlugin's existing-chunk guard then finds that chunk is not a
    // parent of the selected chunks and drops this cacheGroup entry without
    // warning (webpack/lib/optimize/SplitChunksPlugin.js — `existingChunk`
    // validation). The engine imports in the game modules are therefore plain
    // `import("phaser")` / `import("three")` calls, deliberately uncommented.
    // `src/lib/vector/engine-chunks.test.ts` guards both halves of that pairing.
    if (!isServer) {
      const splitChunks = config.optimization?.splitChunks;
      if (splitChunks && typeof splitChunks === "object") {
        splitChunks.cacheGroups = {
          ...splitChunks.cacheGroups,
          vectorEnginePhaser: {
            test: /[\\/]node_modules[\\/]phaser[\\/]/,
            name: "vector-engine-phaser",
            chunks: "all",
            // Above Next's `framework` (40) and `lib` (30) so the engine is
            // claimed here rather than hash-named.
            priority: 50,
            minSize: 0,
            minChunks: 1,
            reuseExistingChunk: true,
          },
          vectorEngineThree: {
            test: /[\\/]node_modules[\\/]three[\\/]/,
            name: "vector-engine-three",
            chunks: "all",
            priority: 50,
            minSize: 0,
            minChunks: 1,
            reuseExistingChunk: true,
          },
        };
      }
    }
    return config;
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "*.supabase.co", pathname: "/storage/v1/object/public/**" },
      // external thumbnails/preview images (briefing, literature, gallery, recipes)
      { protocol: "https", hostname: "**" },
    ],
  },
  async headers() {
    // Fail closed: API routes are same-origin only (the app never calls its
    // own API cross-origin). Only emit CORS headers when NEXT_PUBLIC_APP_URL
    // is explicitly configured — omitting the header entirely (rather than
    // falling back to "*") means cross-origin requests are denied by default
    // instead of silently allowed in a misconfigured preview/staging deploy.
    const apiHeaders = [
      { key: "Access-Control-Allow-Methods", value: "GET,POST,PUT,DELETE,OPTIONS" },
      { key: "Access-Control-Allow-Headers", value: "Content-Type,Authorization" },
      ...(process.env.NEXT_PUBLIC_APP_URL
        ? [{ key: "Access-Control-Allow-Origin", value: process.env.NEXT_PUBLIC_APP_URL }]
        : []),
    ];
    return [
      { source: "/(.*)", headers: SECURITY_HEADERS },
      { source: "/api/(.*)", headers: apiHeaders },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/vector-offline.html",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
        ],
      },
      // /api/proxy relays arbitrary third-party HTML chosen by the user into the
      // WebViewer iframe — it must be framable by our own origin (X-Frame-Options),
      // and the relayed page's OWN scripts/styles/connects must not be blocked by
      // our app's strict CSP (they aren't 'self', so the blanket CSP above would
      // silently break any proxied site with real client-side JS). The iframe's
      // sandbox attribute (allow-scripts allow-same-origin allow-forms allow-popups)
      // is the actual security boundary for this content, not CSP — so the CSP here
      // is intentionally permissive. object-src stays locked down regardless.
      {
        source: "/api/proxy",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          {
            key: "Content-Security-Policy",
            value: "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; script-src * 'unsafe-inline' 'unsafe-eval'; style-src * 'unsafe-inline'; img-src * data: blob:; font-src * data:; connect-src *; frame-src *; media-src *; object-src 'none'",
          },
        ],
      },
    ];
  },
  async redirects() {
    return [
      { source: "/console", destination: "/command", permanent: true },
      { source: "/signals", destination: "/dispatch", permanent: true },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  org: "kevin-ogonuwe",
  project: "javascript-nextjs",

  // Only print Sentry output in CI
  silent: !process.env.CI,

  // Upload source maps and delete them from the public bundle after upload
  widenClientFileUpload: true,
  sourcemaps: {
    deleteSourcemapsAfterUpload: true,
  },

  // Proxy Sentry requests through /monitoring to avoid adblockers
  tunnelRoute: "/monitoring",

  webpack: {
    // Tree-shake Sentry logger in production
    treeshake: {
      removeDebugLogging: true,
    },

    // Auto-instrument Vercel Cron routes as Sentry Cron Monitors
    automaticVercelMonitors: true,
  },
});
