import { optionalEnv } from "@/lib/env";

// Server-only Make (integromat) client. Make zones are account-specific —
// `MAKE_ZONE` defaults to the zone verified live for this account
// (us2.make.com); override via env if the Make org ever migrates zones.
const MAKE_ZONE = optionalEnv("MAKE_ZONE") || "us2.make.com";
const MAKE_BASE = `https://${MAKE_ZONE}/api/v2`;

export class MakeError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function getApiKey(): string {
  const key = optionalEnv("MAKE_API_KEY");
  if (!key) throw new MakeError("MAKE_API_KEY is not configured", 503);
  return key;
}

async function makeFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${MAKE_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Token ${getApiKey()}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new MakeError(`Make ${path} failed: ${res.status} ${text.slice(0, 300)}`, res.status);
  }
  return (await res.json()) as T;
}

type MakeOrganization = { id: number; name: string; zone: string };
type MakeTeam = { id: number; name: string; organizationId: number };

let cachedTeamId: number | null = null;

// Most Make accounts have exactly one org/team; resolve + cache the team id
// lazily rather than hardcoding account-specific numbers in source. Override
// via MAKE_TEAM_ID if the account has multiple teams.
async function resolveTeamId(): Promise<number> {
  const configuredTeamId = optionalEnv("MAKE_TEAM_ID");
  if (configuredTeamId) return Number(configuredTeamId);
  if (cachedTeamId) return cachedTeamId;
  const orgs = await makeFetch<{ organizations: MakeOrganization[] }>("/organizations");
  const org = orgs.organizations[0];
  if (!org) throw new MakeError("No Make organization found for this API key", 404);
  const teams = await makeFetch<{ teams: MakeTeam[] }>(`/teams?organizationId=${org.id}`);
  const team = teams.teams[0];
  if (!team) throw new MakeError("No Make team found for this organization", 404);
  cachedTeamId = team.id;
  return team.id;
}

export type MakeScenario = {
  id: number;
  name: string;
  isActive: boolean;
  teamId: number;
  scheduling?: unknown;
};

export async function listScenarios(): Promise<MakeScenario[]> {
  const teamId = await resolveTeamId();
  const data = await makeFetch<{ scenarios: MakeScenario[] }>(`/scenarios?teamId=${teamId}`);
  return data.scenarios;
}

export async function getScenario(scenarioId: number): Promise<MakeScenario> {
  const data = await makeFetch<{ scenario: MakeScenario }>(`/scenarios/${scenarioId}`);
  return data.scenario;
}

export async function runScenario(
  scenarioId: number,
  input?: Record<string, unknown>,
): Promise<unknown> {
  return makeFetch(`/scenarios/${scenarioId}/run`, {
    method: "POST",
    body: JSON.stringify({ responsive: true, input: input ?? {} }),
  });
}

export async function setScenarioActive(scenarioId: number, active: boolean): Promise<void> {
  await makeFetch(`/scenarios/${scenarioId}/${active ? "start" : "stop"}`, { method: "POST" });
}

// Instant-trigger scenarios run off an opaque webhook URL minted in the Make
// UI (not the management API) — this just posts to it. Caller is responsible
// for not leaking the URL (it carries an embedded secret token).
export async function triggerWebhook(webhookUrl: string, payload: unknown): Promise<unknown> {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
