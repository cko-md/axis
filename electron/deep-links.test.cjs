/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { ALLOWED_ROUTES, findDeepLinkInArgv, parseDeepLink } = require("./deep-links.cjs");

test("resolves an allowlisted route to its internal path", () => {
  assert.deepEqual(parseDeepLink("axis://open?route=approvals"), {
    kind: "open",
    path: "/approvals",
  });
  assert.deepEqual(parseDeepLink("axis://open?route=archive-bay"), {
    kind: "open",
    path: "/vector/archive-bay",
  });
});

test("accepts both the host and the path spelling the OS may hand over", () => {
  assert.deepEqual(parseDeepLink("axis://open?route=tasks"), { kind: "open", path: "/tasks" });
  assert.deepEqual(parseDeepLink("axis:open?route=tasks"), { kind: "open", path: "/tasks" });
});

test("appends only a well-formed record id", () => {
  assert.deepEqual(parseDeepLink("axis://open?route=approvals&id=abc-123"), {
    kind: "open",
    path: "/approvals/abc-123",
  });
});

// The allowlist is the security boundary: a deep link names a route key, it
// never supplies a path. These must be structurally impossible, not filtered.
test("rejects any route that is not allowlisted", () => {
  for (const raw of [
    "axis://open?route=admin",
    "axis://open?route=",
    "axis://open",
    "axis://open?route=__proto__",
    "axis://open?route=constructor",
  ]) {
    assert.equal(parseDeepLink(raw), null, `expected null for ${raw}`);
  }
});

test("cannot be used to traverse or redirect", () => {
  for (const raw of [
    "axis://open?route=tasks/../../etc/passwd",
    "axis://open?route=tasks&id=../../secret",
    "axis://open?route=tasks&id=a/b",
    "axis://open?route=https://evil.example.com",
  ]) {
    assert.equal(parseDeepLink(raw), null, `expected null for ${raw}`);
  }
});

test("rejects non-axis protocols outright", () => {
  for (const raw of [
    "https://evil.example.com",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "axisx://open?route=tasks",
  ]) {
    assert.equal(parseDeepLink(raw), null, `expected null for ${raw}`);
  }
});

test("returns an opaque oauth id and never a token", () => {
  const parsed = parseDeepLink("axis://oauth/complete?id=abc123DEF456_-x");
  assert.deepEqual(parsed, { kind: "oauth-complete", id: "abc123DEF456_-x" });
  // Nothing token-shaped may survive parsing.
  assert.equal(parseDeepLink("axis://oauth/complete?id=abc&access_token=secret")?.id, undefined);
});

test("rejects oauth ids that do not look like opaque one-time handles", () => {
  for (const raw of [
    "axis://oauth/complete",
    "axis://oauth/complete?id=",
    "axis://oauth/complete?id=short",
    `axis://oauth/complete?id=${"x".repeat(200)}`,
    "axis://oauth/complete?id=has spaces",
    "axis://oauth/complete?id=has.dots",
  ]) {
    assert.equal(parseDeepLink(raw), null, `expected null for ${raw}`);
  }
});

test("never throws on malformed input", () => {
  for (const raw of [null, undefined, "", 42, {}, [], "axis://", "not a url", "x".repeat(5000)]) {
    assert.doesNotThrow(() => parseDeepLink(raw));
    assert.equal(parseDeepLink(raw), null);
  }
});

test("finds a deep link anywhere in argv", () => {
  assert.equal(
    findDeepLinkInArgv(["/path/to/axis", "--flag", "axis://open?route=tasks"]),
    "axis://open?route=tasks",
  );
  assert.equal(findDeepLinkInArgv(["/path/to/axis", "--dev"]), null);
  assert.equal(findDeepLinkInArgv(undefined), null);
});

test("every allowlisted route is an absolute internal path", () => {
  for (const [key, value] of Object.entries(ALLOWED_ROUTES)) {
    assert.ok(value.startsWith("/"), `${key} must be an absolute internal path`);
    assert.ok(!value.includes(".."), `${key} must not contain traversal`);
    assert.ok(!/^\/\//.test(value), `${key} must not be protocol-relative`);
  }
});
