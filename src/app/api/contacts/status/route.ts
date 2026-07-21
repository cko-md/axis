import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

type ContactConnection = {
  provider: "google";
  email: string | null;
  via: "composio";
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

  // Contacts is Composio-only after the direct-adapter removal.
  const composioResult = await supabase
    .from("composio_connections")
    .select("status, account_label")
    .eq("user_id", user.id)
    .eq("toolkit", "googlecontacts")
    .eq("status", "ACTIVE");

  if (composioResult.error) {
    captureStatusError(composioResult.error, "composio_connections");
    return NextResponse.json({ error: "Status unavailable" }, { status: 500 });
  }

  const connections: ContactConnection[] = [];
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
