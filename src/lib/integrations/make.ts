import { optionalEnv } from "@/lib/env";
import { recordProviderFailure } from "@/lib/observability/providerTiming";
import { codeFromStatus, fail, makeError, ok, type Result } from "@/lib/integrations/types";

// Server-only Make (integromat) client. Make zones are account-specific —
// `MAKE_ZONE` defaults to the zone verified live for this account
// (us2.make.com); override via env if the Make org ever migrates zones.
const DEFAULT_MAKE_ZONE = "us2.make.com";
const MAKE_ZONE_PATTERN = /^[a-z0-9-]+\.make\.com$/i;
const MAKE_WEBHOOK_HOST_PATTERN = /^hook\.[a-z0-9-]+\.make\.com$/i;

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

function getMakeBase(): string {
  const zone = optionalEnv("MAKE_ZONE") || DEFAULT_MAKE_ZONE;
  if (!MAKE_ZONE_PATTERN.test(zone)) {
    throw new MakeError("MAKE_ZONE is invalid", 503);
  }
  return `https://${zone}/api/v2`;
}

async function makeFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${getMakeBase()}${path}`, {
    ...init,
    headers: {
      Authorization: `Token ${getApiKey()}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    throw new MakeError(`Make API request failed (${res.status})`, res.status);
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

export type MakeWebhookReceipt = {
  accepted: true;
  status: number;
};

/** Validate an opaque Make webhook without ever returning/logging its token path. */
export function validateMakeWebhookUrl(raw: string): Result<URL> {
  try {
    const url = new URL(raw);
    const valid =
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      MAKE_WEBHOOK_HOST_PATTERN.test(url.hostname) &&
      url.pathname.length > 1;
    return valid
      ? ok(url)
      : fail("invalid_request", "Make webhook URL is invalid", {
          provider: "make",
          retryable: false,
        });
  } catch {
    return fail("invalid_request", "Make webhook URL is invalid", {
      provider: "make",
      retryable: false,
    });
  }
}

/**
 * Deliver one write event. This intentionally performs one attempt only:
 * automatic retries of external communication can duplicate delivery.
 */
export async function triggerWebhook(
  webhookUrl: string,
  payload: unknown,
): Promise<Result<MakeWebhookReceipt>> {
  const validated = validateMakeWebhookUrl(webhookUrl);
  if (!validated.ok) return validated;

  const startedAt = Date.now();
  try {
    const res = await fetch(validated.data, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) return ok({ accepted: true, status: res.status });

    const error = makeError(
      codeFromStatus(res.status),
      "Make webhook rejected delivery",
      { provider: "make", status: res.status },
    );
    recordProviderFailure(
      { area: "integrations", provider: "make", operation: "trigger_webhook" },
      error,
      Date.now() - startedAt,
    );
    return { ok: false, error };
  } catch {
    const error = makeError("network", "Make webhook delivery failed", {
      provider: "make",
      retryable: true,
    });
    recordProviderFailure(
      { area: "integrations", provider: "make", operation: "trigger_webhook" },
      error,
      Date.now() - startedAt,
    );
    return { ok: false, error };
  }
}
