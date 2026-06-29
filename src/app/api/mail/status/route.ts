import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { listMailAccounts } from "@/lib/mail/tokens";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ accounts: [] });

  const accounts = await listMailAccounts(user.id);
  return NextResponse.json({ accounts });
}
