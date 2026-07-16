import { z } from "zod";
import { optionalEnv } from "@/lib/env";
import {
  recordProviderFailure,
  timedProviderFetch,
} from "@/lib/observability/providerTiming";
import {
  codeFromStatus,
  fail,
  makeError,
  ok,
  type IntegrationError,
  type Result,
} from "@/lib/integrations/types";

// Server-only Make (integromat) client. Make zones are account-specific —
// `MAKE_ZONE` defaults to the zone verified live for this account
// (us2.make.com); override via env if the Make org ever migrates zones.
const DEFAULT_MAKE_ZONE = "us2.make.com";
const MAKE_ZONE_PATTERN = /^[a-z0-9-]+\.make\.com$/i;
const MAKE_WEBHOOK_HOST_PATTERN = /^hook\.[a-z0-9-]+\.make\.com$/i;
const MAKE_MANAGEMENT_READ_ATTEMPTS = 3;

type MakeManagementConfig = { apiKey: string; baseUrl: string };

function getManagementConfig(): Result<MakeManagementConfig> {
  const key = optionalEnv("MAKE_API_KEY");
  if (!key) {
    return fail("provider_error", "Make management API is not configured", {
      provider: "make",
      retryable: false,
    });
  }
  const zone = optionalEnv("MAKE_ZONE") || DEFAULT_MAKE_ZONE;
  if (!MAKE_ZONE_PATTERN.test(zone)) {
    return fail("provider_error", "Make management API zone is invalid", {
      provider: "make",
      retryable: false,
    });
  }
  return ok({ apiKey: key, baseUrl: `https://${zone}/api/v2` });
}

function recordManagementFailure(
  operation: string,
  error: IntegrationError,
  startedAt: number,
) {
  recordProviderFailure(
    { area: "integrations", provider: "make", operation },
    error,
    Date.now() - startedAt,
  );
}

async function makeManagementFetch<T>(input: {
  path: string;
  operation: string;
  schema: z.ZodType<T>;
  init?: RequestInit;
}): Promise<Result<T>> {
  const startedAt = Date.now();
  const config = getManagementConfig();
  if (!config.ok) {
    recordManagementFailure(input.operation, config.error, startedAt);
    return config;
  }
  if (!input.path.startsWith("/") || input.path.startsWith("//")) {
    return fail("invalid_request", "Make management path is invalid", {
      provider: "make",
      retryable: false,
    });
  }

  const method = input.init?.method?.toUpperCase() ?? "GET";
  const readOnly = method === "GET" || method === "HEAD";
  let response: Response;
  try {
    response = await timedProviderFetch(
      `${config.data.baseUrl}${input.path}`,
      {
        ...input.init,
        method,
        headers: {
          ...(input.init?.headers ?? {}),
          Authorization: `Token ${config.data.apiKey}`,
          "Content-Type": "application/json",
        },
        redirect: "error",
      },
      {
        area: "integrations",
        provider: "make",
        operation: input.operation,
        timeoutMs: 20_000,
        captureFailures: false,
        ...(readOnly
          ? {
              retry: {
                maxAttempts: MAKE_MANAGEMENT_READ_ATTEMPTS,
                baseDelayMs: 250,
                maxDelayMs: 1_000,
              },
            }
          : {}),
      },
    );
  } catch {
    const error = makeError("network", "Make management request failed", {
      provider: "make",
      retryable: true,
    });
    recordManagementFailure(input.operation, error, startedAt);
    return { ok: false, error };
  }

  if (!response.ok) {
    const error = makeError(codeFromStatus(response.status), "Make management request was rejected", {
      provider: "make",
      status: response.status,
    });
    recordManagementFailure(input.operation, error, startedAt);
    return { ok: false, error };
  }

  let body: unknown;
  try {
    body = response.status === 204 ? undefined : await response.json();
  } catch {
    const error = makeError("provider_error", "Make management response was invalid", {
      provider: "make",
      retryable: true,
    });
    recordManagementFailure(input.operation, error, startedAt);
    return { ok: false, error };
  }

  const parsed = input.schema.safeParse(body);
  if (!parsed.success) {
    const error = makeError("provider_error", "Make management response was invalid", {
      provider: "make",
      retryable: true,
    });
    recordManagementFailure(input.operation, error, startedAt);
    return { ok: false, error };
  }
  return ok(parsed.data);
}

const makeOrganizationSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  zone: z.string(),
});
const makeTeamSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  organizationId: z.number().int().positive(),
});
const makeScenarioSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  isActive: z.boolean(),
  teamId: z.number().int().positive(),
  scheduling: z.unknown().optional(),
});
const makeScenarioRunSchema = z.object({
  executionId: z.string().min(1),
  status: z.string().optional(),
}).passthrough();
const makeScenarioActivationSchema = z.object({
  scenario: z.object({
    id: z.number().int().positive(),
    isActive: z.boolean(),
  }),
});

let cachedTeamId: number | null = null;

// Most Make accounts have exactly one org/team; resolve + cache the team id
// lazily rather than hardcoding account-specific numbers in source. Override
// via MAKE_TEAM_ID if the account has multiple teams.
async function resolveTeamId(): Promise<Result<number>> {
  const startedAt = Date.now();
  const configuredTeamId = optionalEnv("MAKE_TEAM_ID");
  if (configuredTeamId) {
    const teamId = Number(configuredTeamId);
    return Number.isSafeInteger(teamId) && teamId > 0
      ? ok(teamId)
      : fail("invalid_request", "MAKE_TEAM_ID is invalid", {
          provider: "make",
          retryable: false,
        });
  }
  if (cachedTeamId) return ok(cachedTeamId);
  const orgs = await makeManagementFetch({
    path: "/organizations",
    operation: "list_organizations",
    schema: z.object({ organizations: z.array(makeOrganizationSchema) }),
  });
  if (!orgs.ok) return orgs;
  const org = orgs.data.organizations[0];
  if (!org) {
    const error = makeError("not_found", "No Make organization is available", {
      provider: "make",
      retryable: false,
    });
    recordManagementFailure("resolve_team", error, startedAt);
    return { ok: false, error };
  }
  const teams = await makeManagementFetch({
    path: `/teams?organizationId=${org.id}`,
    operation: "list_teams",
    schema: z.object({ teams: z.array(makeTeamSchema) }),
  });
  if (!teams.ok) return teams;
  const team = teams.data.teams[0];
  if (!team) {
    const error = makeError("not_found", "No Make team is available", {
      provider: "make",
      retryable: false,
    });
    recordManagementFailure("resolve_team", error, startedAt);
    return { ok: false, error };
  }
  cachedTeamId = team.id;
  return ok(team.id);
}

export type MakeScenario = z.infer<typeof makeScenarioSchema>;
export type MakeScenarioRun = z.infer<typeof makeScenarioRunSchema>;
export type MakeScenarioActivation = z.infer<typeof makeScenarioActivationSchema>["scenario"];

function validScenarioId(scenarioId: number): Result<number> {
  return Number.isSafeInteger(scenarioId) && scenarioId > 0
    ? ok(scenarioId)
    : fail("invalid_request", "Make scenario id is invalid", {
        provider: "make",
        retryable: false,
      });
}

export async function listScenarios(): Promise<Result<MakeScenario[]>> {
  const teamId = await resolveTeamId();
  if (!teamId.ok) return teamId;
  const result = await makeManagementFetch({
    path: `/scenarios?teamId=${teamId.data}`,
    operation: "list_scenarios",
    schema: z.object({ scenarios: z.array(makeScenarioSchema) }),
  });
  return result.ok ? ok(result.data.scenarios) : result;
}

export async function getScenario(scenarioId: number): Promise<Result<MakeScenario>> {
  const validId = validScenarioId(scenarioId);
  if (!validId.ok) return validId;
  const result = await makeManagementFetch({
    path: `/scenarios/${validId.data}`,
    operation: "get_scenario",
    schema: z.object({ scenario: makeScenarioSchema }),
  });
  return result.ok ? ok(result.data.scenario) : result;
}

export async function runScenario(
  scenarioId: number,
  input?: Record<string, unknown>,
): Promise<Result<MakeScenarioRun>> {
  const validId = validScenarioId(scenarioId);
  if (!validId.ok) return validId;
  let body: string;
  try {
    body = JSON.stringify({ responsive: true, data: input ?? {} });
  } catch {
    return fail("invalid_request", "Make scenario input is not serializable", {
      provider: "make",
      retryable: false,
    });
  }
  return makeManagementFetch({
    path: `/scenarios/${validId.data}/run`,
    operation: "run_scenario",
    schema: makeScenarioRunSchema,
    init: { method: "POST", body },
  });
}

export async function setScenarioActive(
  scenarioId: number,
  active: boolean,
): Promise<Result<MakeScenarioActivation>> {
  const validId = validScenarioId(scenarioId);
  if (!validId.ok) return validId;
  const startedAt = Date.now();
  const result = await makeManagementFetch({
    path: `/scenarios/${validId.data}/${active ? "start" : "stop"}`,
    operation: active ? "start_scenario" : "stop_scenario",
    schema: makeScenarioActivationSchema,
    init: { method: "POST" },
  });
  if (!result.ok) return result;
  if (result.data.scenario.id !== validId.data || result.data.scenario.isActive !== active) {
    const error = makeError("provider_error", "Make scenario state confirmation did not match", {
      provider: "make",
      retryable: false,
    });
    recordManagementFailure(
      active ? "start_scenario" : "stop_scenario",
      error,
      startedAt,
    );
    return { ok: false, error };
  }
  return ok(result.data.scenario);
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
