import { validateExpectedProfileSubject } from "@/lib/auth/expectedProfileSubject.server";
import { privateJson } from "@/lib/auth/privateNoStore";
import { createClient } from "@/lib/supabase/server";
import { getAccessToken, notConnected, pickArt, spotifyGet, toTrackLite } from "../../_lib";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** GET /api/spotify/playlist/[id] — playlist meta + tracks for crate browsing. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return privateJson({ error: "UNAUTHORIZED" }, { status: 401 });
  const identity = validateExpectedProfileSubject(req, user.id);
  if (!identity.ok) return identity.response;

  const token = await getAccessToken(user.id);
  if (!token) return notConnected();

  const { id } = await params;
  const data = await spotifyGet<any>(
    token,
    `/playlists/${id}?fields=id,name,uri,images,owner(display_name),tracks.total`,
  );
  if (!data) return privateJson({ connected: true, found: false }, { status: 404 });

  const tracksData = await spotifyGet<any>(
    token,
    `/playlists/${id}/tracks?limit=50&fields=items(track(id,uri,name,duration_ms,artists(name),album(name,images)))`,
  );
  const items = (tracksData?.items ?? [])
    .map((i: any) => i.track)
    .filter(Boolean)
    .map((t: any) => toTrackLite(t));

  return privateJson({
    connected: true,
    found: true,
    id: data.id,
    uri: data.uri,
    name: data.name,
    art: pickArt(data.images),
    owner: data.owner?.display_name ?? "",
    total: data.tracks?.total ?? items.length,
    items,
  });
}
