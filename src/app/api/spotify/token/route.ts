import { validateExpectedProfileSubject } from '@/lib/auth/expectedProfileSubject.server';
import { privateJson } from '@/lib/auth/privateNoStore';
import { createClient } from '@/lib/supabase/server';
import { getAccessToken } from '../_lib';

// Required by the Spotify Web Playback SDK, which needs the raw access token
// client-side to initialize the in-browser player (Spotify's SDK design — the
// token cannot be kept server-only here). Gate it behind a Supabase session so
// only the signed-in Axis user holding the cookie can retrieve it.
export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return privateJson({ error: 'UNAUTHORIZED' }, { status: 401 });
  const identity = validateExpectedProfileSubject(req, user.id);
  if (!identity.ok) return identity.response;

  const token = await getAccessToken(user.id);
  if (!token) return privateJson({ error: 'No token' }, { status: 404 });
  return privateJson({ access_token: token });
}
