import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

type ContactConnection = {
  provider: "google";
  email: string | null;
  via: "oauth" | "composio";
  status: string;
};

function captureStatusError(error: unknown, table: string) {
  Sentry.captureException(error instanceof Error ? error : new Error("Contacts status query failed"), {
    tags: {
      module: "contacts",
      operation: "status",
      table,
    },
  });
}

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({
      connected: false,
      google: false,
      googleEmail: null,
      via: null,
      connections: [],
    });
  }

  const [legacyResult, composioResult] = await Promise.all([
    supabase
      .from("contacts_connections")
      .select("email")
      .eq("user_id", user.id)
      .eq("provider", "google")
      .maybeSingle(),
    supabase
      .from("composio_connections")
      .select("status, account_label")
      .eq("user_id", user.id)
      .eq("toolkit", "googlecontacts")
      .eq("status", "ACTIVE"),
  ]);

  if (legacyResult.error) captureStatusError(legacyResult.error, "contacts_connections");
  if (composioResult.error) captureStatusError(composioResult.error, "composio_connections");

  if (legacyResult.error || composioResult.error) {
    return NextResponse.json({ error: "Status unavailable" }, { status: 500 });
  }

  const connections: ContactConnection[] = [];
  if (legacyResult.data) {
    connections.push({
      provider: "google",
      email: (legacyResult.data.email as string | null) ?? null,
      via: "oauth",
      status: "ACTIVE",
    });
  }

  for (const row of composioResult.data ?? []) {
    connections.push({
      provider: "google",
      email: (row.account_label as string | null) ?? null,
      via: "composio",
      status: "ACTIVE",
    });
  }

  const primary = connections[0] ?? null;
  return NextResponse.json({
    connected: connections.length > 0,
    google: connections.length > 0,
    googleEmail: primary?.email ?? null,
    via: primary?.via ?? null,
    connections,
  });
}
