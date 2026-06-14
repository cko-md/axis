import { NextResponse } from "next/server";

const CLIENT_ID    = process.env.FITBIT_CLIENT_ID;
const REDIRECT_URI = process.env.NEXT_PUBLIC_BASE_URL
  ? `${process.env.NEXT_PUBLIC_BASE_URL}/api/health/fitbit/callback`
  : "http://localhost:3000/api/health/fitbit/callback";

export async function GET() {
  if (!CLIENT_ID) {
    return NextResponse.json(
      { message: "Fitbit integration requires FITBIT_CLIENT_ID in environment." },
      { status: 501 },
    );
  }

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "heartrate sleep activity profile",
  });

  return NextResponse.redirect(
    `https://www.fitbit.com/oauth2/authorize?${params.toString()}`,
  );
}
