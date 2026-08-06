import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { captureRouteError } from "@/lib/observability/captureRouteError";
import { LandingPublic } from "@/components/landing/LandingPublic";

export const metadata: Metadata = {
  title: "Axis — Personal Operating System",
  description:
    "Axis is a personal operating system: one private dashboard for your calendar, email, tasks, notes, health, finances, and reading — connected to the services you already use.",
};

type AuthProbeError = {
  code?: unknown;
  name?: unknown;
  status?: unknown;
};

function isExpectedSignedOutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as AuthProbeError;
  return candidate.code === "refresh_token_not_found"
    || candidate.code === "invalid_refresh_token"
    || (candidate.name === "AuthSessionMissingError" && candidate.status === 400);
}

export default async function HomePage() {
  let supabase: Awaited<ReturnType<typeof createClient>>;
  try {
    supabase = await createClient();
  } catch (error) {
    captureRouteError(error, {
      route: "/",
      operation: "resolve_optional_session",
      area: "auth",
      status: 503,
      code: "AUTH_CONFIGURATION_UNAVAILABLE",
    });
    return <LandingPublic />;
  }

  let user = null;
  try {
    const result = await supabase.auth.getUser();
    if (result.error) {
      if (!isExpectedSignedOutError(result.error)) {
        captureRouteError(result.error, {
          route: "/",
          operation: "resolve_optional_session",
          area: "auth",
          status: 503,
          code: "AUTH_BACKEND_UNAVAILABLE",
        });
      }
    } else {
      user = result.data.user;
    }
  } catch (error) {
    if (!isExpectedSignedOutError(error)) {
      captureRouteError(error, {
        route: "/",
        operation: "resolve_optional_session",
        area: "auth",
        status: 503,
        code: "AUTH_BACKEND_UNAVAILABLE",
      });
    }
  }

  if (user) redirect("/command");

  return <LandingPublic />;
}
