import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAccessToken, notConnected, spotifyFetch, spotifyGet, toTrackLite } from "../_lib";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * AI "build a focus playlist".
 * POST /api/spotify/focus { prompt: string, create?: boolean }
 *
 * Flow:
 *  1. Ask /api/ai {mode:"capture"} to distill the prompt into a label + action (reused, not edited).
 *  2. Derive seed terms, search Spotify for matching tracks/artists.
 *  3. Use Spotify recommendations seeded by those artists to assemble a track set.
 *  4. If create=true, build a private playlist and add the tracks; else just return the set to queue.
 */
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const token = await getAccessToken(user.id);
  if (!token) return notConnected();

  const { prompt, create } = (await req.json()) as { prompt: string; create?: boolean };
  if (!prompt?.trim()) return NextResponse.json({ error: "prompt required" }, { status: 400 });

  // 1. Distill intent via the existing AI route (graceful: heuristic if no key).
  let label = "Focus";
  try {
    const origin = new URL(req.url).origin;
    const aiRes = await fetch(`${origin}/api/ai`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "capture", text: prompt }),
    });
    if (aiRes.ok) {
      const ai = await aiRes.json();
      if (ai?.label) label = String(ai.label);
    }
  } catch {
    /* fall through with default label */
  }

  // 2. Search Spotify using the user's prompt + the AI label as queries.
  const queries = [prompt, label].filter(Boolean);
  const seedArtists = new Set<string>();
  const seedTracks: string[] = [];
  for (const q of queries) {
    const sr = await spotifyGet<any>(
      token,
      `/search?q=${encodeURIComponent(q)}&type=track&limit=5`,
    );
    for (const t of sr?.tracks?.items ?? []) {
      if (t?.id) seedTracks.push(t.id);
      const aid = t?.artists?.[0]?.id;
      if (aid) seedArtists.add(aid);
      if (seedArtists.size >= 3) break;
    }
    if (seedArtists.size >= 3) break;
  }

  // 3. Recommendations seeded by the discovered artists/tracks.
  const params = new URLSearchParams({ limit: "25" });
  if (seedArtists.size) params.set("seed_artists", [...seedArtists].slice(0, 3).join(","));
  if (seedTracks.length) params.set("seed_tracks", seedTracks.slice(0, 2).join(","));
  // Tilt toward focus: high instrumentalness, moderate energy.
  params.set("target_instrumentalness", "0.6");
  params.set("target_energy", "0.45");
  params.set("min_popularity", "20");

  let tracks: ReturnType<typeof toTrackLite>[] = [];
  if (seedArtists.size || seedTracks.length) {
    const rec = await spotifyGet<any>(token, `/recommendations?${params}`);
    tracks = (rec?.tracks ?? []).map((t: any) => toTrackLite(t));
  }
  // Fallback: if recommendations returned nothing, use the searched tracks themselves.
  if (tracks.length === 0 && seedTracks.length) {
    const fallback = await spotifyGet<any>(
      token,
      `/tracks?ids=${seedTracks.slice(0, 20).join(",")}`,
    );
    tracks = (fallback?.tracks ?? []).map((t: any) => toTrackLite(t));
  }

  if (tracks.length === 0) {
    return NextResponse.json(
      { connected: true, created: false, label, tracks: [], message: "No matches — try a different mood." },
      { status: 200 },
    );
  }

  const uris = tracks.map((t) => t.uri).filter(Boolean);

  if (!create) {
    return NextResponse.json({ connected: true, created: false, label, tracks });
  }

  // 4. Create a private playlist and add the tracks.
  const me = await spotifyGet<any>(token, "/me");
  if (!me?.id) {
    return NextResponse.json({ connected: true, created: false, label, tracks });
  }
  const playlistName = `Axis · ${label}`;
  const createRes = await spotifyFetch(token, `/users/${me.id}/playlists`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: playlistName,
      description: `Built by Axis from “${prompt.slice(0, 120)}”`,
      public: false,
    }),
  });
  if (!createRes.ok) {
    return NextResponse.json({ connected: true, created: false, label, tracks });
  }
  const playlist = await createRes.json();
  await spotifyFetch(token, `/playlists/${playlist.id}/tracks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uris }),
  });

  return NextResponse.json({
    connected: true,
    created: true,
    label,
    playlistId: playlist.id,
    playlistUri: playlist.uri,
    playlistUrl: playlist.external_urls?.spotify ?? null,
    name: playlistName,
    tracks,
  });
}
