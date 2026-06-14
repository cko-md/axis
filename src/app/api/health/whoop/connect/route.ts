import { NextResponse } from "next/server";

const CLIENT_ID    = process.env.WHOOP_CLIENT_ID;
const REDIRECT_URI = process.env.NEXT_PUBLIC_BASE_URL
  ? `${process.env.NEXT_PUBLIC_BASE_URL}/api/health/whoop/callback`
  : "http://localhost:3000/api/health/whoop/callback";

export async function GET() {
  if (!CLIENT_ID) {
    return NextResponse.json(
      { message: "Whoop integration requires WHOOP_CLIENT_ID in environment." },
      { status: 501 },
    );
  }

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "read:recovery read:cycles read:sleep read:workout read:profile read:body_measurement",
  });

  return NextResponse.redirect(
    `https://api.prod.whoop.com/oauth/oauth2/auth?${params.toString()}`,
  );
}
