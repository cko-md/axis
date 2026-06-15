import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { deleteMailTokens, type MailProvider } from "@/lib/mail/tokens";

// DELETE /api/mail/disconnect?provider=gmail|outlook&email=user@example.com
export async function DELETE(req: NextRequest) {
  const provider = req.nextUrl.searchParams.get("provider") as MailProvider | null;
  const email = req.nextUrl.searchParams.get("email");

  if (provider !== "gmail" && provider !== "outlook") {
    return NextResponse.json({ error: "provider must be gmail or outlook" }, { status: 400 });
  }
  if (!email) {
    return NextResponse.json({ error: "email param is required" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  await deleteMailTokens(user.id, provider, email);
  return NextResponse.json({ ok: true });
}
