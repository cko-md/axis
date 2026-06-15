import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ gmail: false, outlook: false });

  const { data } = await supabase
    .from("mail_connections")
    .select("provider, mail_email")
    .eq("user_id", user.id);

  const rows = data ?? [];
  const gmail = rows.find((r) => r.provider === "gmail");
  const outlook = rows.find((r) => r.provider === "outlook");

  return NextResponse.json({
    gmail: !!gmail,
    gmailEmail: gmail?.mail_email ?? null,
    outlook: !!outlook,
    outlookEmail: outlook?.mail_email ?? null,
  });
}
