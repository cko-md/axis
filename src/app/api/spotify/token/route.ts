import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getAccessToken } from '../_lib';

// Required by the Spotify Web Playback SDK, which needs the raw access token
// client-side to initialize the in-browser player (Spotify's SDK design — the
// token cannot be kept server-only here). Gate it behind a Supabase session so
// only the signed-in Axis user holding the cookie can retrieve it.
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const token = await getAccessToken(user.id);
  if (!token) return NextResponse.json({ error: 'No token' }, { status: 404 });
  return NextResponse.json({ access_token: token });
}
