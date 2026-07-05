import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { deleteConnectedAccount, isSupportedToolkit } from "@/lib/integrations/composio";

// DELETE /api/integrations/composio/disconnect?toolkit=gmail|outlook
export async function DELETE(req: NextRequest) {
  const toolkit = req.nextUrl.searchParams.get("toolkit");
  if (!toolkit) return NextResponse.json({ error: "toolkit param is required" }, { status: 400 });
  if (!isSupportedToolkit(toolkit)) return NextResponse.json({ error: "Unsupported toolkit" }, { status: 400 });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const { data: rows, error: loadError } = await supabase
    .from("composio_connections")
    .select("id, connected_account_id")
    .eq("user_id", user.id)
    .eq("toolkit", toolkit);

  if (loadError) {
    Sentry.captureException(loadError, {
      tags: { area: "integrations", provider: "composio", operation: "disconnect_load", toolkit },
    });
    return NextResponse.json({ error: "Could not load connection state" }, { status: 500 });
  }

  const targets = rows ?? [];
  if (targets.length === 0) return NextResponse.json({ ok: true, disconnected: 0 });

  const results = await Promise.allSettled(
    targets.map((row) => deleteConnectedAccount(row.connected_account_id)),
  );
  const deletedIds = targets
    .filter((_, index) => results[index]?.status === "fulfilled")
    .map((row) => row.id);
  const failures = results.filter((result) => result.status === "rejected");

  if (deletedIds.length > 0) {
    const { error: deleteError } = await supabase
      .from("composio_connections")
      .delete()
      .eq("user_id", user.id)
      .in("id", deletedIds);
    if (deleteError) {
      Sentry.captureException(deleteError, {
        tags: { area: "integrations", provider: "composio", operation: "disconnect_cleanup", toolkit },
      });
      return NextResponse.json({ error: "Disconnected provider, but local cleanup failed" }, { status: 500 });
    }
  }

  if (failures.length > 0) {
    Sentry.captureException(new Error("Composio connected account delete failed"), {
      tags: { area: "integrations", provider: "composio", operation: "disconnect", toolkit },
      contexts: {
        composio: {
          attempted: targets.length,
          disconnected: deletedIds.length,
          failed: failures.length,
        },
      },
    });
    return NextResponse.json(
      {
        error: "Could not disconnect every provider account. Try again.",
        disconnected: deletedIds.length,
        failed: failures.length,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true, disconnected: deletedIds.length });
}
