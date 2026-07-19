"use strict";

/**
 * axis:// deep-link parsing.
 *
 * A deep link arrives from the operating system and is therefore UNTRUSTED
 * input — anything on the machine can invoke `axis://...`. This module exists so
 * that parsing is pure, total, and unit-testable, and so the main process never
 * hands a raw OS-supplied string to a navigation call.
 *
 * Two hard rules:
 *
 * 1. Only an allowlisted internal route may result. The link names a route by
 *    an opaque key; it does NOT carry a path that gets navigated to. That makes
 *    open-redirect and path-traversal structurally impossible rather than
 *    merely filtered.
 *
 * 2. A deep link never carries a credential. OAuth completion passes an opaque
 *    one-time id that the hosted app exchanges server-side; tokens, codes, and
 *    session material must never appear in an argv string, which is visible to
 *    every process on the machine and lands in shell history and crash dumps.
 */

const PROTOCOL = "axis:";

/**
 * Route keys the desktop shell may ask the web app to open. Adding a route here
 * is a deliberate act; anything not listed is rejected.
 */
const ALLOWED_ROUTES = Object.freeze({
  command: "/command",
  tasks: "/tasks",
  approvals: "/approvals",
  schedule: "/schedule",
  mail: "/mail",
  notes: "/notes",
  vector: "/vector",
  "archive-bay": "/vector/archive-bay",
  "control-room": "/control-room",
});

/** Opaque one-time ids only — no tokens, ever. */
const OAUTH_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/** A single approval/task id, when a route addresses one record. */
const RECORD_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Parse an OS-supplied string into an action the main process may perform.
 * Returns null for anything unrecognised — callers must treat null as "ignore",
 * never as "navigate anyway".
 */
function parseDeepLink(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return null;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== PROTOCOL) return null;

  // `axis://open?route=tasks` parses with host="open"; `axis:open?...` parses
  // with pathname="open". Accept both so platform differences in how the OS
  // hands over the string do not silently drop a valid link.
  const action = (url.hostname || url.pathname.replace(/^\/+/, "")).toLowerCase();

  if (action === "open") {
    const routeKey = (url.searchParams.get("route") ?? "").toLowerCase();
    const target = Object.prototype.hasOwnProperty.call(ALLOWED_ROUTES, routeKey)
      ? ALLOWED_ROUTES[routeKey]
      : null;
    if (!target) return null;

    const id = url.searchParams.get("id");
    if (id !== null) {
      if (!RECORD_ID_PATTERN.test(id)) return null;
      return { kind: "open", path: `${target}/${id}` };
    }
    return { kind: "open", path: target };
  }

  if (action === "oauth" || action === "oauth/complete") {
    const id = url.searchParams.get("id");
    if (!id || !OAUTH_ID_PATTERN.test(id)) return null;
    // Deliberately does NOT return a token. The renderer asks the hosted app to
    // consume a server-owned one-time record keyed by this id.
    return { kind: "oauth-complete", id };
  }

  return null;
}

/**
 * Pick the first axis:// argument out of a process argv vector. Windows and
 * Linux deliver deep links this way on both cold and warm start.
 */
function findDeepLinkInArgv(argv) {
  if (!Array.isArray(argv)) return null;
  for (const entry of argv) {
    if (typeof entry === "string" && /^axis:/i.test(entry.trim())) return entry.trim();
  }
  return null;
}

module.exports = {
  ALLOWED_ROUTES,
  PROTOCOL,
  findDeepLinkInArgv,
  parseDeepLink,
};
