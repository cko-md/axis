import { captureRouteError } from "@/lib/observability/captureRouteError";

export function reportAuthConfigurationUnavailable() {
  captureRouteError(new Error("Authentication configuration unavailable"), {
    route: "middleware",
    operation: "configure_auth",
    area: "auth",
    status: 503,
    code: "AUTH_CONFIGURATION_UNAVAILABLE",
  });
}
