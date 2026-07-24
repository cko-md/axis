import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { listComposioContactsAccounts } from "@/lib/contacts/composio";

type ContactConnection = {
  provider: "google";
  email: string | null;
  via: "composio";
  status: string;
};

function captureStatusError(error: unknown) {
  Sentry.captureException(error instanceof Error ? error : new Error("Contacts status query failed"), {
    tags: {
      module: "contacts",
      operation: "status",
      source: "private_authority_membership",
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

  // Local authority membership is sufficient for this cache/UI projection;
  // never expose or resolve a provider account id from a status route.
  let composioAccounts;
  try {
    composioAccounts = await listComposioContactsAccounts(user.id);
  } catch (error) {
    captureStatusError(error);
    return NextResponse.json({ error: "Status unavailable" }, { status: 500 });
  }

  const connections: ContactConnection[] = [];
  for (const account of composioAccounts) {
    connections.push({
      provider: "google",
      email: account.accountLabel,
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
