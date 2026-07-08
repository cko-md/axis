import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAccessToken, isConfigured, notConnected, pickArt, spotifyFetch, spotifyGet } from "../_lib";

/* eslint-disable @typescript-eslint/no-explicit-any */

// GET — rich now-playing snapshot (track, progress, device, volume, shuffle/repeat)
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const token = await getAccessToken();
  if (!token) return notConnected();

  const configured = isConfigured();
  const data = await spotifyGet<any>(token, "/me/player");
  if (!data || !data.item) {
    return NextResponse.json({ connected: true, configured, playing: false, track: null });
  }

  const item = data.item;
  return NextResponse.json({
    connected: true,
    configured,
    playing: data.is_playing ?? false,
    track: item.name ?? "Unknown",
    artist: (item.artists ?? []).map((a: any) => a?.name).filter(Boolean).join(", "),
    album: item.album?.name ?? "",
    art: pickArt(item.album?.images),
    trackId: item.id ?? null,
    uri: item.uri ?? null,
    progressMs: data.progress_ms ?? 0,
    durationMs: item.duration_ms ?? 0,
    device: data.device?.name ?? null,
    volume: data.device?.volume_percent ?? null,
    shuffle: data.shuffle_state ?? false,
    repeat: data.repeat_state ?? "off",
  });
}

// POST — player controls. Body: { action, value? }
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const token = await getAccessToken();
  if (!token) return NextResponse.json({ error: "Not connected" }, { status: 401 });

  const { action, value, uri, uris, contextUri, device_id } = (await req.json()) as {
    action: string;
    value?: number;
    uri?: string;
    uris?: string[];
    contextUri?: string;
    device_id?: string;
  };

  let res: Response;
  switch (action) {
    case "play": {
      const deviceQs = device_id ? `?device_id=${encodeURIComponent(device_id)}` : "";
      let body: string | undefined;
      if (contextUri) {
        body = JSON.stringify({ context_uri: contextUri });
      } else if (uris?.length || uri) {
        body = JSON.stringify({ uris: uris ?? (uri ? [uri] : undefined) });
      }
      res = await spotifyFetch(token, `/me/player/play${deviceQs}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body,
      });
      break;
    }
    case "pause":
      res = await spotifyFetch(token, "/me/player/pause", { method: "PUT" });
      break;
    case "next":
      res = await spotifyFetch(token, "/me/player/next", { method: "POST" });
      break;
    case "prev":
    case "previous":
      res = await spotifyFetch(token, "/me/player/previous", { method: "POST" });
      break;
    case "seek":
      res = await spotifyFetch(token, `/me/player/seek?position_ms=${Math.max(0, value ?? 0)}`, {
        method: "PUT",
      });
      break;
    case "volume":
      res = await spotifyFetch(
        token,
        `/me/player/volume?volume_percent=${Math.min(100, Math.max(0, Math.round(value ?? 0)))}`,
        { method: "PUT" },
      );
      break;
    case "shuffle":
      res = await spotifyFetch(token, `/me/player/shuffle?state=${value ? "true" : "false"}`, {
        method: "PUT",
      });
      break;
    case "repeat": {
      const states = ["off", "context", "track"];
      const state = states.includes(String(value)) ? String(value) : "off";
      res = await spotifyFetch(token, `/me/player/repeat?state=${state}`, { method: "PUT" });
      break;
    }
    case "queue":
      if (!uri) return NextResponse.json({ error: "uri required" }, { status: 400 });
      res = await spotifyFetch(token, `/me/player/queue?uri=${encodeURIComponent(uri)}`, {
        method: "POST",
      });
      break;
    default:
      return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  // 404 = no active device; surface a friendly hint for the UI.
  if (res.status === 404) {
    return NextResponse.json(
      { ok: false, error: "no_active_device", message: "Open Spotify on a device first." },
      { status: 404 },
    );
  }
  if (!res.ok && res.status !== 204) {
    return NextResponse.json({ ok: false, status: res.status }, { status: res.status });
  }
  return NextResponse.json({ ok: true });
}
