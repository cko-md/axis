import { captureRouteError } from "@/lib/observability/captureRouteError";

type RouteUser = { id: string };
type RouteAuthClient = {
  auth: {
    getUser: () => Promise<{
      data: { user: RouteUser | null };
      error: unknown;
    }>;
  };
};

export type RouteIdentityMeta = {
  route: string;
  area: string;
};

export function isExpectedMissingSession(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
    status?: unknown;
  };
  return value.status === 401
    || (value.name === "AuthSessionMissingError" && value.status === 400)
    || value.code === "refresh_token_not_found"
    || value.code === "invalid_refresh_token"
    || value.message === "Auth session missing!";
}

export async function resolveRouteIdentity<T extends RouteAuthClient>(
  create: () => T | Promise<T>,
  meta: RouteIdentityMeta,
): Promise<
  | { ok: true; client: T; user: RouteUser }
  | { ok: false; status: 401; code: "UNAUTHORIZED" }
  | { ok: false; status: 503; code: "AUTH_UNAVAILABLE" }
> {
  let client: T;
  try {
    client = await create();
  } catch {
    captureRouteError(new Error("Route authentication client unavailable"), {
      ...meta,
      operation: "authenticate",
      provider: "supabase",
      status: 503,
      code: "AUTH_BACKEND_UNAVAILABLE",
    });
    return { ok: false, status: 503, code: "AUTH_UNAVAILABLE" };
  }

  let authResult: {
    data: { user: RouteUser | null };
    error: unknown;
  };
  try {
    authResult = await client.auth.getUser();
  } catch {
    captureRouteError(new Error("Route authentication lookup unavailable"), {
      ...meta,
      operation: "authenticate",
      provider: "supabase",
      status: 503,
      code: "AUTH_BACKEND_UNAVAILABLE",
    });
    return { ok: false, status: 503, code: "AUTH_UNAVAILABLE" };
  }

  const { user } = authResult.data;
  if (authResult.error) {
    if (isExpectedMissingSession(authResult.error)) {
      return { ok: false, status: 401, code: "UNAUTHORIZED" };
    }
    captureRouteError(new Error("Route authentication backend unavailable"), {
      ...meta,
      operation: "authenticate",
      provider: "supabase",
      status: 503,
      code: "AUTH_BACKEND_UNAVAILABLE",
    });
    return { ok: false, status: 503, code: "AUTH_UNAVAILABLE" };
  }
  if (!user) return { ok: false, status: 401, code: "UNAUTHORIZED" };
  return { ok: true, client, user };
}
