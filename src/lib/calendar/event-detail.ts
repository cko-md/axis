import type { ComposioCalendarAccount } from "@/lib/calendar/composio";

// Pure validation + transport-resolution logic for the calendar event detail
// route, extracted from src/app/api/calendar/event/[id]/route.ts so the
// critical edit-validation and delete cross-provider precedence rules are
// unit-testable (CAL-1 hardening; behavior unchanged).

export type EventColor = "a" | "b" | "c";

export type ScheduleEventPatchInput = {
  title?: unknown;
  description?: unknown;
  start_at?: unknown;
  end_at?: unknown;
  color_class?: unknown;
};

export type ValidatedEventPatch = {
  title: string;
  description: string | null;
  start_at: string;
  end_at: string;
  color_class: EventColor;
};

export type PatchValidationResult =
  | { ok: true; patch: ValidatedEventPatch }
  | { ok: false; error: string; status: 422 };

function parseIso(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Mirrors the PATCH /api/calendar/event/[id] validation exactly: required
// title, valid start/end where end > start, and a color_class in the DB's
// CHECK-constrained set.
export function validateEventPatch(body: ScheduleEventPatchInput): PatchValidationResult {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const description = typeof body.description === "string" && body.description.trim().length
    ? body.description.trim()
    : null;
  const start = parseIso(body.start_at);
  const end = parseIso(body.end_at);
  const color = body.color_class;

  if (!title) return { ok: false, error: "Title is required", status: 422 };
  if (!start || !end) return { ok: false, error: "Start and end times are required", status: 422 };
  if (end <= start) return { ok: false, error: "End time must be after start time", status: 422 };
  if (color !== "a" && color !== "b" && color !== "c") {
    return { ok: false, error: "Invalid event color", status: 422 };
  }

  return {
    ok: true,
    patch: {
      title,
      description,
      start_at: start.toISOString(),
      end_at: end.toISOString(),
      color_class: color,
    },
  };
}

export type ExternalCleanupTransport = "google" | "outlook";

export type CleanupTransportResolution =
  | { transport: "composio"; connectionId: string }
  | { transport: "none" };

const COMPOSIO_PROVIDER_KEY: Record<ExternalCleanupTransport, ComposioCalendarAccount["provider"]> = {
  google: "googlecalendar",
  outlook: "outlook",
};

// Which transport should clean up an external event on delete. Calendar is
// Composio-only after the direct-adapter removal, so this resolves to the
// Composio account for the provider, or "none" when the event has an external
// id but no Composio connection exists — so the caller can surface that cleanup
// was skipped instead of silently doing nothing.
export function resolveCleanupTransport(
  source: ExternalCleanupTransport,
  composioAccounts: readonly Pick<ComposioCalendarAccount, "provider" | "connectionId">[],
): CleanupTransportResolution;
export function resolveCleanupTransport(
  source: ExternalCleanupTransport,
  composioAccounts: readonly Pick<ComposioCalendarAccount, "provider" | "connectionId">[],
): CleanupTransportResolution {
  const composioAccount = composioAccounts.find((a) => a.provider === COMPOSIO_PROVIDER_KEY[source]);
  if (!composioAccount) return { transport: "none" };
  return { transport: "composio", connectionId: composioAccount.connectionId };
}
