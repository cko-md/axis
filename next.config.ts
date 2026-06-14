import type { NextConfig } from "next";
// @ts-ignore — next-pwa ships CJS without bundled types
import withPWAInit from "next-pwa";

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

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async redirects() {
    return [
      { source: "/console", destination: "/command", permanent: true },
      { source: "/signals", destination: "/dispatch", permanent: true },
    ];
  },
};

export default withPWA(nextConfig);
