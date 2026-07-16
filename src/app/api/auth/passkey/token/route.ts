import { NextResponse } from "next/server";

/**
 * Retired compatibility endpoint.
 *
 * Passkey sessions are now issued server-side after WebAuthn verification.
 * Refresh tokens are never accepted from the browser or stored per passkey.
 */
export async function POST() {
  return NextResponse.json(
    { error: "PASSKEY_SESSION_SYNC_RETIRED" },
    { status: 410 },
  );
}
