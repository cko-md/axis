import { NextResponse } from "next/server";

const CLIENT_ID    = process.env.GARMIN_CLIENT_ID;
const REDIRECT_URI = process.env.NEXT_PUBLIC_BASE_URL
  ? `${process.env.NEXT_PUBLIC_BASE_URL}/api/health/garmin/callback`
  : "http://localhost:3000/api/health/garmin/callback";

export async function GET() {
  if (!CLIENT_ID) {
    return NextResponse.json(
      { message: "Garmin integration requires GARMIN_CLIENT_ID in environment." },
      { status: 501 },
    );
  }

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "ACTIVITY_EXPORT HEART_RATE SLEEP",
  });

  return NextResponse.redirect(
    `https://connect.garmin.com/oauthConfirm?${params.toString()}`,
  );
}
