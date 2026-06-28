import { z } from "zod";

const requiredPublicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().trim().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().trim().min(1),
});

type PublicEnv = z.infer<typeof requiredPublicEnvSchema>;

let cachedPublicEnv: PublicEnv | null = null;

export function getPublicEnv(): PublicEnv {
  if (cachedPublicEnv) return cachedPublicEnv;

  const parsedPublicEnv = requiredPublicEnvSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });

  if (!parsedPublicEnv.success) {
    const fields = parsedPublicEnv.error.issues
      .map((issue) => issue.path.join("."))
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `Missing or invalid required AXIS environment variable(s): ${fields}. See docs/env.md.`,
    );
  }

  cachedPublicEnv = parsedPublicEnv.data;
  return cachedPublicEnv;
}

export const OPTIONAL_ENV_NAMES = [
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_BASE_URL",
  "NEXT_PUBLIC_SENTRY_DSN",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SENTRY_AUTH_TOKEN",
  "COMPOSIO_API_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "MICROSOFT_CLIENT_ID",
  "MICROSOFT_CLIENT_SECRET",
  "POLYGON_API_KEY",
  "MASSIVE_API_KEY",
  "PLAID_CLIENT_ID",
  "PLAID_SECRET",
  "PLAID_ENV",
  "SPOTIFY_CLIENT_ID",
  "SPOTIFY_CLIENT_SECRET",
  "STRAVA_CLIENT_ID",
  "STRAVA_CLIENT_SECRET",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "TAVILY_API_KEY",
  "MAKE_API_KEY",
  "MAKE_TEAM_ID",
  "MAKE_ZONE",
  "MAKE_SWEEP_SECRET",
  "MAKE_WEBHOOK_SECRET",
  "MAKE_WEBHOOK_DAILY_BRIEF_URL",
  "MAKE_WEBHOOK_WEEKLY_RECAP_URL",
  "MAKE_WEBHOOK_BILL_REMINDER_URL",
  "MAKE_WEBHOOK_BUDGET_ALERT_URL",
  "MAKE_WEBHOOK_ANOMALY_ALERT_URL",
  "MAKE_WEBHOOK_SUBSCRIPTION_AUDIT_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "PASSKEY_ENCRYPTION_KEY",
  "CRON_SECRET",
  "FEED_DIGEST_SECRET",
  "GARMIN_CLIENT_ID",
  "OURA_CLIENT_ID",
  "FITBIT_CLIENT_ID",
  "WHOOP_CLIENT_ID",
  "APP_PUBLIC_API_KEY",
  "PUBLIC_API_KEY",
  "BROKERAGE_API_KEY",
  "APP_PUBLIC_ACCOUNT_ID",
  "PUBLIC_ACCOUNT_ID",
  "BROKERAGE_ACCOUNT_ID",
] as const;

export type OptionalEnvName = (typeof OPTIONAL_ENV_NAMES)[number];

export function optionalEnv(name: OptionalEnvName): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function hasOptionalEnv(...names: OptionalEnvName[]): boolean {
  return names.every((name) => Boolean(optionalEnv(name)));
}

export function missingOptionalEnv(feature: string, names: OptionalEnvName[]) {
  return {
    configured: false,
    error: "NOT_CONFIGURED",
    message: `${feature} is not configured. Set ${names.join(" + ")} to enable it.`,
  };
}
