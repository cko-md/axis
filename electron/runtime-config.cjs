/* eslint-disable @typescript-eslint/no-require-imports */
const packageMetadata = require("./package.json");

const LOCAL_DESKTOP_URL = "http://127.0.0.1:3000";
const PRODUCTION_DESKTOP_URL = "https://axis-cko.vercel.app";

function normalizeDesktopUrl(raw, { production = false } = {}) {
  const url = new URL(String(raw || "").trim());
  if (url.username || url.password) throw new Error("Desktop URL must not contain credentials");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && !production)) {
    throw new Error(production ? "Production desktop URL must use HTTPS" : "Desktop URL must use HTTP(S)");
  }
  if (production && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1")) {
    throw new Error("Production desktop URL must not target localhost");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.origin;
}

function parseSentryDsn(raw) {
  if (!raw) return null;
  const dsn = new URL(String(raw).trim());
  const pathSegments = dsn.pathname.split("/").filter(Boolean);
  const projectId = pathSegments.pop();
  if (dsn.protocol !== "https:" || !dsn.username || !projectId || !/^\d+$/.test(projectId)) {
    throw new Error("Desktop Sentry DSN is invalid");
  }

  const basePath = pathSegments.length ? `/${pathSegments.join("/")}` : "";
  const key = encodeURIComponent(dsn.username);
  const ingestBase = `${dsn.origin}${basePath}/api/${projectId}`;
  const publicDsn = `${dsn.protocol}//${dsn.username}@${dsn.host}${dsn.pathname}`;

  return {
    envelopeUrl: `${ingestBase}/envelope/?sentry_version=7&sentry_key=${key}`,
    minidumpUrl: `${ingestBase}/minidump/?sentry_key=${key}`,
    publicDsn,
    projectId,
  };
}

function resolveRuntimeConfig({
  isPackaged,
  env = process.env,
  metadata = packageMetadata,
} = {}) {
  const packagedConfig = metadata.axisDesktop || {};
  const productionUrl = normalizeDesktopUrl(
    packagedConfig.productionUrl || PRODUCTION_DESKTOP_URL,
    { production: true },
  );
  const axisUrl = isPackaged
    ? productionUrl
    : normalizeDesktopUrl(env.AXIS_DESKTOP_URL || LOCAL_DESKTOP_URL);
  const sentryDsn = isPackaged
    ? packagedConfig.sentryDsn
    : env.AXIS_DESKTOP_SENTRY_DSN || env.NEXT_PUBLIC_SENTRY_DSN || packagedConfig.sentryDsn;

  return {
    axisUrl,
    axisOrigin: new URL(axisUrl).origin,
    environment: isPackaged ? "production" : "development",
    isPackaged: Boolean(isPackaged),
    productionUrl,
    release: `axis-desktop@${metadata.version || "0.0.0"}`,
    sentry: parseSentryDsn(sentryDsn),
  };
}

module.exports = {
  LOCAL_DESKTOP_URL,
  PRODUCTION_DESKTOP_URL,
  normalizeDesktopUrl,
  parseSentryDsn,
  resolveRuntimeConfig,
};
