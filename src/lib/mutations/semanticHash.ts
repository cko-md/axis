import crypto from "crypto";

/**
 * Canonical semantic hashes bind idempotency keys to the actual requested
 * action without retaining private action content. Undefined object fields are
 * omitted; arrays keep order because order can be action-significant.
 */
const MAX_DEPTH = 24;
const MAX_NODES = 2_000;
const MAX_CANONICAL_BYTES = 64_000;

function canonicalize(value: unknown, depth = 0, seen = new Set<object>(), counter = { nodes: 0 }): string {
  if (depth > MAX_DEPTH || ++counter.nodes > MAX_NODES) throw new Error("semantic hash input exceeds structural limits");
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    const output = JSON.stringify(value);
    if (Buffer.byteLength(output, "utf8") > MAX_CANONICAL_BYTES) throw new Error("semantic hash input exceeds byte limit");
    return output;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("semantic hash does not accept non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("semantic hash does not accept cycles");
    seen.add(value);
    const output = `[${value.map((item) => canonicalize(item, depth + 1, seen, counter)).join(",")}]`;
    seen.delete(value);
    if (Buffer.byteLength(output, "utf8") > MAX_CANONICAL_BYTES) throw new Error("semantic hash input exceeds byte limit");
    return output;
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) throw new Error("semantic hash does not accept cycles");
    seen.add(value);
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    const output = `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child, depth + 1, seen, counter)}`).join(",")}}`;
    seen.delete(value);
    if (Buffer.byteLength(output, "utf8") > MAX_CANONICAL_BYTES) throw new Error("semantic hash input exceeds byte limit");
    return output;
  }
  throw new Error("semantic hash accepts JSON-compatible values only");
}

/** A database-visible digest must not be an unkeyed content fingerprint. */
export function providerMutationSemanticHash(value: unknown): string {
  const key = process.env.PROVIDER_MUTATION_HMAC_KEY?.trim();
  if (!key || key.length < 32) throw new Error("Provider mutation HMAC key is unavailable");
  return crypto.createHmac("sha256", key)
    .update("axis/provider-mutation-semantic/v1\0", "utf8")
    .update(canonicalize(value), "utf8")
    .digest("hex");
}

/** Stable, non-sensitive command identity. It deliberately survives HMAC key rotation. */
export function providerMutationStableIdempotencyKey(value: unknown): string {
  return crypto.createHash("sha256")
    .update("axis/provider-mutation-idempotency/v1\0", "utf8")
    .update(canonicalize(value), "utf8")
    .digest("hex");
}
