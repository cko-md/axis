import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getConnectedAccount, isSupportedToolkit, resolveProfileLabel } from "@/lib/integrations/composio";

// Statuses Composio won't transition out of on its own — no point repolling.
const DEAD_END_STATUSES = new Set(["FAILED", "EXPIRED", "REVOKED"]);

// GET /api/integrations/composio/status
// Returns this user's Composio connections, refreshing any non-dead-end rows
// against Composio first (no webhook listener yet — poll-on-read instead).
// The first time a row reaches ACTIVE it also resolves + persists the
// account's email (mail toolkits only) so Mail can display it.
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ connections: [] });

  const { data: rows } = await supabase
    .from("composio_connections")
    .select("id, toolkit, connected_account_id, status, account_label, created_at")
    .eq("user_id", user.id);

  const connections = await Promise.all(
    (rows ?? []).map(async (row) => {
      if (DEAD_END_STATUSES.has(row.status)) return row;
      try {
        const live = await getConnectedAccount(row.connected_account_id);
        const patch: Record<string, unknown> = {};
        if (live.status !== row.status) patch.status = live.status;
        if (live.status === "ACTIVE" && !row.account_label && isSupportedToolkit(row.toolkit)) {
          const email = await resolveProfileLabel(row.toolkit, row.connected_account_id, user.id);
          if (email) patch.account_label = email;
        }
        if (Object.keys(patch).length > 0) {
          patch.updated_at = new Date().toISOString();
          await supabase.from("composio_connections").update(patch).eq("id", row.id);
        }
        return { ...row, ...patch };
      } catch {
        return row;
      }
    }),
  );

  return NextResponse.json({ connections });
}
