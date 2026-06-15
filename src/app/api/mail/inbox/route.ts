import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { listGmailInbox } from "@/lib/mail/gmail";
import { listOutlookInbox } from "@/lib/mail/outlook";

// GET /api/mail/inbox?pageToken=...&skip=0
// Returns merged inbox from all connected providers, sorted by date desc.
export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });

  const pageToken = req.nextUrl.searchParams.get("pageToken") ?? undefined;
  const skip = parseInt(req.nextUrl.searchParams.get("skip") ?? "0", 10);

  const { data: connections } = await supabase
    .from("mail_connections")
    .select("provider")
    .eq("user_id", user.id);

  const providers = (connections ?? []).map((c) => c.provider as string);

  const [gmailResult, outlookResult] = await Promise.all([
    providers.includes("gmail") ? listGmailInbox(user.id, pageToken) : Promise.resolve({ messages: [] }),
    providers.includes("outlook") ? listOutlookInbox(user.id, skip) : Promise.resolve({ messages: [], hasMore: false }),
  ]);

  const all = [...gmailResult.messages, ...outlookResult.messages].sort((a, b) => {
    const da = new Date(a.date).getTime();
    const db = new Date(b.date).getTime();
    return db - da;
  });

  return NextResponse.json({
    messages: all,
    nextPageToken: "nextPageToken" in gmailResult ? gmailResult.nextPageToken : undefined,
    outlookHasMore: "hasMore" in outlookResult ? outlookResult.hasMore : false,
  });
}
