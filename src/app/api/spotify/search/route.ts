import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAccessToken, notConnected, pickArt, spotifyGet, toTrackLite } from "../_lib";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** GET /api/spotify/search?q=...&type=track,artist,album,playlist */
export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const token = await getAccessToken();
  if (!token) return notConnected();

  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim();
  if (!q) return NextResponse.json({ connected: true, tracks: [], artists: [], albums: [], playlists: [] });

  const type = url.searchParams.get("type") ?? "track,artist,album,playlist";
  const data = await spotifyGet<any>(
    token,
    `/search?q=${encodeURIComponent(q)}&type=${encodeURIComponent(type)}&limit=8`,
  );

  return NextResponse.json({
    connected: true,
    tracks: (data?.tracks?.items ?? []).map((t: any) => toTrackLite(t)),
    artists: (data?.artists?.items ?? []).map((a: any) => ({
      id: a.id,
      uri: a.uri,
      name: a.name,
      art: pickArt(a.images),
    })),
    albums: (data?.albums?.items ?? []).map((a: any) => ({
      id: a.id,
      uri: a.uri,
      name: a.name,
      artists: (a.artists ?? []).map((x: any) => x?.name).join(", "),
      art: pickArt(a.images),
    })),
    playlists: (data?.playlists?.items ?? [])
      .filter(Boolean)
      .map((p: any) => ({
        id: p.id,
        uri: p.uri,
        name: p.name,
        art: pickArt(p.images),
        owner: p.owner?.display_name ?? "",
      })),
  });
}
