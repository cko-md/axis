import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getGmailMessage } from "@/lib/mail/gmail";
import { getOutlookMessage } from "@/lib/mail/outlook";

// GET /api/mail/message/[id]?provider=gmail|outlook&email=user@example.com
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const provider = req.nextUrl.searchParams.get("provider");
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

  const message =
    provider === "gmail"
      ? await getGmailMessage(user.id, email, id)
      : await getOutlookMessage(user.id, email, id);

  if (!message) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(message);
}
