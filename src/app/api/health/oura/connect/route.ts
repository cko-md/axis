import { NextResponse } from "next/server";

const CLIENT_ID     = process.env.OURA_CLIENT_ID;
const REDIRECT_URI  = process.env.NEXT_PUBLIC_BASE_URL
  ? `${process.env.NEXT_PUBLIC_BASE_URL}/api/health/oura/callback`
  : "http://localhost:3000/api/health/oura/callback";

export async function GET() {
  if (!CLIENT_ID) {
    return NextResponse.json(
      { message: "Oura integration requires OURA_CLIENT_ID in environment." },
      { status: 501 },
    );
  }

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "daily heartrate workout tag session",
  });

  return NextResponse.redirect(
    `https://cloud.ouraring.com/oauth/authorize?${params.toString()}`,
  );
}
