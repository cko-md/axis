/**
 * Envoy identity domain (Wave 15.4).
 *
 * An Envoy is a visual identity only — it never changes Focus, Intel, or Ask
 * behavior (binding invariant 6, docs/axis-redesign/15-vector-arcade-and-envoys.md).
 * Starter entries are honest "candidate" identities: their generated art
 * packages arrive in Wave 15.5 (hatch-pet pipeline), so nothing here claims a
 * rendered asset exists. The registry is pure data — no React, no DOM.
 */

export const ENVOY_IDS = [
  "meridian",
  "cairn",
  "vesper",
  "solace",
] as const;

export type EnvoyId = (typeof ENVOY_IDS)[number];

export type EnvoyStatus = "candidate" | "hatched";

export type EnvoyRecord = {
  id: EnvoyId;
  name: string;
  motif: string;
  description: string;
  /** "candidate" until a validated hatch-pet package exists (Wave 15.5). */
  status: EnvoyStatus;
};

export const ENVOY_REGISTRY: readonly EnvoyRecord[] = [
  {
    id: "meridian",
    name: "Meridian",
    motif: "navigator",
    description: "A steady route-finder; the default continuation of the legacy monolith presence.",
    status: "candidate",
  },
  {
    id: "cairn",
    name: "Cairn",
    motif: "waymark",
    description: "A patient marker-stacker; the continuation of the legacy deck presence.",
    status: "candidate",
  },
  {
    id: "vesper",
    name: "Vesper",
    motif: "signal",
    description: "A luminous signal-watcher; the continuation of the legacy nova presence.",
    status: "candidate",
  },
  {
    id: "solace",
    name: "Solace",
    motif: "harbor",
    description: "A calm harbor-keeper; a new identity with no legacy ancestor.",
    status: "candidate",
  },
];

const ENVOY_ID_SET = new Set<string>(ENVOY_IDS);

export function isEnvoyId(value: unknown): value is EnvoyId {
  return typeof value === "string" && ENVOY_ID_SET.has(value);
}

export function getEnvoy(id: EnvoyId): EnvoyRecord {
  const record = ENVOY_REGISTRY.find((candidate) => candidate.id === id);
  if (!record) throw new Error(`Unknown Envoy: ${id}`);
  return record;
}

export const DEFAULT_ENVOY_ID: EnvoyId = "meridian";

/**
 * VE-RISK-009: pure parser mapping every legacy companion form to a stable
 * starter Envoy id. Legacy values exist in two vocabularies:
 * - interface-settings `Companion`: "monolith" | "deck" | "nova"
 * - the Mascot component's internal naming: "axiom" | "codex" | "nova"
 * Corrupt/unknown values fall back to the default rather than throwing —
 * a stored preference must never break the shell.
 */
const LEGACY_COMPANION_TO_ENVOY = new Map<string, EnvoyId>([
  ["monolith", "meridian"],
  ["axiom", "meridian"],
  ["deck", "cairn"],
  ["codex", "cairn"],
  ["nova", "vesper"],
]);

export function envoyIdFromLegacyCompanion(value: unknown): EnvoyId {
  if (isEnvoyId(value)) return value;
  if (typeof value === "string") {
    // Map lookup (not an object literal) so hostile keys like "__proto__"
    // cannot resolve through the prototype chain.
    const mapped = LEGACY_COMPANION_TO_ENVOY.get(value.trim().toLowerCase());
    if (mapped) return mapped;
  }
  return DEFAULT_ENVOY_ID;
}
