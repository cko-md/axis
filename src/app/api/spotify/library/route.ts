import { validateExpectedProfileSubject } from "@/lib/auth/expectedProfileSubject.server";
import { directProviderRefreshFailureResponse } from "@/lib/auth/directProviderRefresh.server";
import { privateJson } from "@/lib/auth/privateNoStore";
import { createClient } from "@/lib/supabase/server";
import { getAccessToken, notConnected, pickArt, spotifyGet, toTrackLite } from "../_lib";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Library data for the Vault spines/crates.
 * GET /api/spotify/library?kind=recent|top-tracks|top-artists|albums|playlists&term=short|medium|long
 */
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
    return directProviderRefreshFailureResponse(error, "/api/spotify/library");
  }
  if (!token) return notConnected();

  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") ?? "recent";
  const term = url.searchParams.get("term") ?? "medium"; // short_term ~4wk, medium ~6mo, long ~years
  const range =
    term === "short" ? "short_term" : term === "long" ? "long_term" : "medium_term";

  switch (kind) {
    case "recent": {
      const data = await spotifyGet<any>(token, "/me/player/recently-played?limit=24");
      const items = (data?.items ?? []).map((i: any) => ({
        ...toTrackLite(i.track),
        playedAt: i.played_at,
      }));
      return privateJson({ connected: true, kind, items });
    }
    case "top-tracks": {
      const data = await spotifyGet<any>(token, `/me/top/tracks?limit=24&time_range=${range}`);
      const items = (data?.items ?? []).map((t: any) => toTrackLite(t));
      return privateJson({ connected: true, kind, term, items });
    }
    case "top-artists": {
      const data = await spotifyGet<any>(token, `/me/top/artists?limit=24&time_range=${range}`);
      const items = (data?.items ?? []).map((a: any) => ({
        id: a.id,
        uri: a.uri,
        name: a.name,
        art: pickArt(a.images),
        genres: (a.genres ?? []).slice(0, 3),
        followers: a.followers?.total ?? 0,
      }));
      return privateJson({ connected: true, kind, term, items });
    }
    case "albums": {
      const data = await spotifyGet<any>(token, "/me/albums?limit=24");
      const items = (data?.items ?? []).map((i: any) => ({
        id: i.album?.id,
        uri: i.album?.uri,
        name: i.album?.name,
        artists: (i.album?.artists ?? []).map((a: any) => a?.name).join(", "),
        art: pickArt(i.album?.images),
        total: i.album?.total_tracks ?? 0,
      }));
      return privateJson({ connected: true, kind, items });
    }
    case "playlists": {
      const data = await spotifyGet<any>(token, "/me/playlists?limit=30");
      const items = (data?.items ?? []).map((p: any) => ({
        id: p.id,
        uri: p.uri,
        name: p.name,
        art: pickArt(p.images),
        owner: p.owner?.display_name ?? "",
        total: p.tracks?.total ?? 0,
      }));
      return privateJson({ connected: true, kind, items });
    }
    default:
      return privateJson({ error: "unknown kind" }, { status: 400 });
  }
}
