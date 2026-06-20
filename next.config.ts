import type { NextConfig } from "next";
// @ts-ignore — next-pwa ships CJS without bundled types
import withPWAInit from "next-pwa";
import { withSentryConfig } from "@sentry/nextjs";

const withPWA = withPWAInit({
  dest: "public",
  disable: process.env.NODE_ENV === "development",
  register: true,
  skipWaiting: true,
  runtimeCaching: [
    // app shell static assets — cache first
    {
      urlPattern: /^https:\/\/[^/]+\/_next\/static\/.*/i,
      handler: "CacheFirst",
      options: {
        cacheName: "static-assets",
        expiration: { maxEntries: 200, maxAgeSeconds: 604800 },
      },
    },
    // google fonts — cache first, long TTL
    {
      urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/i,
      handler: "CacheFirst",
      options: {
        cacheName: "google-fonts",
        expiration: { maxEntries: 20, maxAgeSeconds: 2592000 },
      },
    },
    // internal API routes — network first with cache fallback
    {
      urlPattern: /^https:\/\/[^/]+\/api\/.*/i,
      handler: "NetworkFirst",
      options: {
        cacheName: "api-cache",
        networkTimeoutSeconds: 10,
        expiration: { maxEntries: 100, maxAgeSeconds: 86400 },
      },
    },
    // pages — network first
    {
      urlPattern: /^https:\/\/[^/]+\/((?!api\/).)*$/i,
      handler: "NetworkFirst",
      options: {
        cacheName: "pages-cache",
        networkTimeoutSeconds: 10,
        expiration: { maxEntries: 50, maxAgeSeconds: 86400 },
      },
    },
  ],
});

const CSP = [
  "default-src 'self'",
  // Next.js App Router requires unsafe-inline for hydration scripts;
  // cdn.plaid.com loads the Plaid Link iframe initializer
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.plaid.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  // blob: needed for gallery image previews; data: for inline SVGs
  "img-src 'self' data: blob: https:",
  // external audio/video previews (briefing/literature) need media from any https host
  "media-src 'self' https: blob: data:",
  [
    "connect-src 'self'",
    "https://*.supabase.co wss://*.supabase.co",
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
  // 'self' allows the in-app WebViewer's same-origin /api/proxy iframe; cdn.plaid.com for Plaid Link
  "frame-src 'self' https://cdn.plaid.com blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "upgrade-insecure-requests",
].join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Exclude browser-only packages from the server bundle (SSR/prerendering)
  serverExternalPackages: ["@simplewebauthn/browser"],
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "*.supabase.co", pathname: "/storage/v1/object/public/**" },
      // external thumbnails/preview images (briefing, literature, gallery, recipes)
      { protocol: "https", hostname: "**" },
    ],
  },
  async headers() {
    return [
      { source: "/(.*)", headers: SECURITY_HEADERS },
      {
        source: "/api/(.*)",
        headers: [
          { key: "Access-Control-Allow-Origin", value: process.env.NEXT_PUBLIC_APP_URL ?? "*" },
          { key: "Access-Control-Allow-Methods", value: "GET,POST,PUT,DELETE,OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Content-Type,Authorization" },
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

export default withSentryConfig(withPWA(nextConfig), {
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

  // Tree-shake Sentry logger in production
  disableLogger: true,

  // Auto-instrument Vercel Cron routes as Sentry Cron Monitors
  automaticVercelMonitors: true,
});
