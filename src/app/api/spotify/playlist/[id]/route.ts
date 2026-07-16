import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAccessToken, notConnected, pickArt, spotifyGet, toTrackLite } from "../../_lib";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** GET /api/spotify/playlist/[id] — playlist meta + tracks for crate browsing. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const token = await getAccessToken(user.id);
  if (!token) return notConnected();

  const { id } = await params;
  const data = await spotifyGet<any>(
    token,
    `/playlists/${id}?fields=id,name,uri,images,owner(display_name),tracks.total`,
  );
  if (!data) return NextResponse.json({ connected: true, found: false }, { status: 404 });

  const tracksData = await spotifyGet<any>(
    token,
    `/playlists/${id}/tracks?limit=50&fields=items(track(id,uri,name,duration_ms,artists(name),album(name,images)))`,
  );
  const items = (tracksData?.items ?? [])
    .map((i: any) => i.track)
    .filter(Boolean)
    .map((t: any) => toTrackLite(t));

  return NextResponse.json({
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
