import { validateExpectedProfileSubject } from "@/lib/auth/expectedProfileSubject.server";
import { directProviderRefreshFailureResponse } from "@/lib/auth/directProviderRefresh.server";
import { privateJson } from "@/lib/auth/privateNoStore";
import { createClient } from "@/lib/supabase/server";
import { getAccessToken, notConnected, pickArt, spotifyGet, toTrackLite } from "../_lib";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** GET /api/spotify/search?q=...&type=track,artist,album,playlist */
export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return privateJson({ error: "UNAUTHORIZED" }, { status: 401 });
  const identity = validateExpectedProfileSubject(req, user.id);
  if (!identity.ok) return identity.response;

  let token: string | null;
  try {
    token = await getAccessToken(user.id);
  } catch (error) {
    return directProviderRefreshFailureResponse(error, "/api/spotify/search");
  }
  if (!token) return notConnected();

  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim();
  if (!q) return privateJson({ connected: true, tracks: [], artists: [], albums: [], playlists: [] });

  const type = url.searchParams.get("type") ?? "track,artist,album,playlist";
  const data = await spotifyGet<any>(
    token,
    `/search?q=${encodeURIComponent(q)}&type=${encodeURIComponent(type)}&limit=8`,
  );

  return privateJson({
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
