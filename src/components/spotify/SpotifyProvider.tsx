"use client";

declare global {
  interface Window {
    Spotify: {
      Player: new (opts: {
        name: string;
        getOAuthToken: (cb: (token: string) => void) => void;
        volume: number;
      }) => SpotifyPlayer;
    };
    onSpotifyWebPlaybackSDKReady: () => void;
  }
}
type SpotifyPlayer = {
  connect: () => Promise<boolean>;
  disconnect: () => void;
  addListener: (event: string, cb: (state: Record<string, unknown>) => void) => boolean;
  removeListener: (event: string, cb?: (state: Record<string, unknown>) => void) => boolean;
};

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { openOAuthPopup } from "@/lib/auth/openOAuthPopup";

export type NowPlaying = {
  track: string | null;
  artist: string;
  album: string;
  art: string | null;
  trackId: string | null;
  uri: string | null;
  progressMs: number;
  durationMs: number;
  device: string | null;
  volume: number | null;
  shuffle: boolean;
  repeat: string;
};

type SpotifyState = {
  /** True once env is configured AND the user has authorized. */
  connected: boolean;
  /** True when SPOTIFY_CLIENT_ID/SECRET are present server-side. */
  configured: boolean;
  // Back-compat fields (sidebar miniplayer relies on these).
  track: string;
  artist: string;
  playing: boolean;
  // Rich now-playing snapshot for the Vault.
  now: NowPlaying;
  /** Locally interpolated progress (ms) for a smooth bar between polls. */
  liveProgressMs: number;
  connect: () => void;
  disconnect: () => Promise<void>;
  refresh: () => Promise<void>;
  togglePlay: () => Promise<void>;
  next: () => Promise<void>;
  prev: () => Promise<void>;
  seek: (ms: number) => Promise<void>;
  setVolume: (pct: number) => Promise<void>;
  toggleShuffle: () => Promise<void>;
  cycleRepeat: () => Promise<void>;
  playUris: (uris: string[]) => Promise<void>;
  playContext: (contextUri: string) => Promise<void>;
  queue: (uri: string) => Promise<{ ok: boolean; message?: string }>;
  sdkDeviceId: string | null;
};

const EMPTY_NOW: NowPlaying = {
  track: null,
  artist: "",
  album: "",
  art: null,
  trackId: null,
  uri: null,
  progressMs: 0,
  durationMs: 0,
  device: null,
  volume: null,
  shuffle: false,
  repeat: "off",
};

const SpotifyContext = createContext<SpotifyState | null>(null);

export function SpotifyProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [now, setNow] = useState<NowPlaying>(EMPTY_NOW);
  const [liveProgressMs, setLiveProgressMs] = useState(0);
  const lastSync = useRef<number>(Date.now());
  const [sdkDeviceId, setSdkDeviceId] = useState<string | null>(null);
  const sdkPlayerRef = useRef<SpotifyPlayer | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/spotify/playback", { cache: "no-store" });
      const data = await res.json().catch(() => ({})) as {
        connected?: boolean;
        configured?: boolean;
        playing?: boolean;
        track?: string | null;
        artist?: string;
        album?: string;
        art?: string | null;
        trackId?: string | null;
        uri?: string | null;
        progressMs?: number;
        durationMs?: number;
        device?: string | null;
        volume?: number | null;
        shuffle?: boolean;
        repeat?: string;
      };
      if (!res.ok) {
        setConnected(false);
        if (typeof data.configured === "boolean") setConfigured(data.configured);
        return;
      }
      setConnected(Boolean(data.connected));
      if (typeof data.configured === "boolean") setConfigured(data.configured);
      if (data.connected && data.track) {
        const snapshot: NowPlaying = {
          track: data.track,
          artist: data.artist ?? "",
          album: data.album ?? "",
          art: data.art ?? null,
          trackId: data.trackId ?? null,
          uri: data.uri ?? null,
          progressMs: data.progressMs ?? 0,
          durationMs: data.durationMs ?? 0,
          device: data.device ?? null,
          volume: data.volume ?? null,
          shuffle: data.shuffle ?? false,
          repeat: data.repeat ?? "off",
        };
        setNow(snapshot);
        setPlaying(Boolean(data.playing));
        setLiveProgressMs(snapshot.progressMs);
        lastSync.current = Date.now();
      } else if (data.connected) {
        setNow(EMPTY_NOW);
        setPlaying(false);
        setLiveProgressMs(0);
      }
    } catch {
      /* offline — leave state as-is */
    }
  }, []);

  useEffect(() => {
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, [poll]);

  // Smoothly interpolate the progress bar between polls.
  useEffect(() => {
    if (!playing || now.durationMs <= 0) return;
    const tick = setInterval(() => {
      setLiveProgressMs(() => {
        const elapsed = Date.now() - lastSync.current;
        return Math.min(now.progressMs + elapsed, now.durationMs);
      });
    }, 500);
    return () => clearInterval(tick);
  }, [playing, now.progressMs, now.durationMs]);

  // Load the Spotify Web Playback SDK when the user is connected.
  useEffect(() => {
    if (!connected) return;
    if (!document.getElementById('spotify-sdk')) {
      const s = document.createElement('script');
      s.id = 'spotify-sdk';
      s.src = 'https://sdk.scdn.co/spotify-player.js';
      document.body.appendChild(s);
    }
    window.onSpotifyWebPlaybackSDKReady = () => {
      const player: SpotifyPlayer = new window.Spotify.Player({
        name: 'Axis Web Player',
        getOAuthToken: (cb) => {
          fetch('/api/spotify/token')
            .then((r) => r.json())
            .then((d: { access_token?: string }) => { if (d.access_token) cb(d.access_token); })
            .catch(() => {/* no token */});
        },
        volume: 0.7,
      });
      sdkPlayerRef.current = player;
      player.addListener('ready', (state) => {
        const deviceId = state.device_id as string | undefined;
        if (deviceId) setSdkDeviceId(deviceId);
      });
      player.addListener('not_ready', () => setSdkDeviceId(null));
      player.addListener('initialization_error', (state) => {
        const msg = state.message as string | undefined;
        if (msg?.toLowerCase().includes('premium')) {
          console.warn('[Axis Spotify] Premium required for in-browser playback.');
        }
        setSdkDeviceId(null);
      });
      // authentication_error fires when the SDK token lacks the `streaming`
      // scope (e.g. a connection made before that scope was added) — the user
      // must reconnect Spotify to re-grant. account_error = non-Premium.
      player.addListener('authentication_error', (state) => {
        console.warn('[Axis Spotify] SDK auth failed — reconnect Spotify to grant streaming scope.', state.message);
        setSdkDeviceId(null);
      });
      player.addListener('account_error', (state) => {
        console.warn('[Axis Spotify] Spotify Premium required for in-browser playback.', state.message);
        setSdkDeviceId(null);
      });
      void player.connect();
    };
    return () => {
      sdkPlayerRef.current?.disconnect();
      sdkPlayerRef.current = null;
      setSdkDeviceId(null);
    };
  }, [connected]);

  // Direct OAuth — poll() (above) only ever reads the direct-OAuth cookie via
  // GET /api/spotify/playback, never Composio state. This is the app-wide
  // provider (sidebar miniplayer, and every module's useSpotify() call reads
  // from here), so wiring the primary connect action to Composio broke
  // Spotify's "connected" state everywhere at once: a successful Composio
  // grant would never be reflected by poll(), leaving connect() feeling like
  // it silently did nothing. See the matching fix in ControlRoomModule.tsx /
  // VaultModule.tsx for the full root-cause writeup.
  const connect = useCallback(() => {
    openOAuthPopup("/api/spotify/auth", (_provider, status) => {
      if (status === "ok") void poll();
    });
  }, [poll]);

  const post = useCallback(
    async (body: Record<string, unknown>) => {
      const payload = (body.action === 'play' && sdkDeviceId)
        ? { ...body, device_id: sdkDeviceId }
        : body;
      const res = await fetch("/api/spotify/playback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      // Re-sync shortly after a control action so UI catches the new state.
      setTimeout(poll, 350);
      return res;
    },
    [poll, sdkDeviceId],
  );

  const disconnect = useCallback(async () => {
    await fetch("/api/spotify/disconnect", { method: "POST" });
    setConnected(false);
    setPlaying(false);
    setNow(EMPTY_NOW);
    setLiveProgressMs(0);
  }, []);

  const togglePlay = useCallback(async () => {
    setPlaying((p) => !p); // optimistic
    await post({ action: playing ? "pause" : "play" });
  }, [playing, post]);

  const next = useCallback(async () => {
    await post({ action: "next" });
  }, [post]);

  const prev = useCallback(async () => {
    await post({ action: "prev" });
  }, [post]);

  const seek = useCallback(
    async (ms: number) => {
      setLiveProgressMs(ms); // optimistic
      lastSync.current = Date.now();
      setNow((n) => ({ ...n, progressMs: ms }));
      await post({ action: "seek", value: Math.round(ms) });
    },
    [post],
  );

  const setVolume = useCallback(
    async (pct: number) => {
      setNow((n) => ({ ...n, volume: pct })); // optimistic
      await post({ action: "volume", value: pct });
    },
    [post],
  );

  const toggleShuffle = useCallback(async () => {
    const nextState = !now.shuffle;
    setNow((n) => ({ ...n, shuffle: nextState }));
    await post({ action: "shuffle", value: nextState });
  }, [now.shuffle, post]);

  const cycleRepeat = useCallback(async () => {
    const order = ["off", "context", "track"];
    const idx = order.indexOf(now.repeat);
    const nextState = order[(idx + 1) % order.length];
    setNow((n) => ({ ...n, repeat: nextState }));
    await post({ action: "repeat", value: nextState });
  }, [now.repeat, post]);

  const playUris = useCallback(
    async (uris: string[]) => {
      await post({ action: "play", uris });
    },
    [post],
  );

  const playContext = useCallback(
    async (contextUri: string) => {
      await post({ action: "play", contextUri });
    },
    [post],
  );

  const queue = useCallback(
    async (uri: string): Promise<{ ok: boolean; message?: string }> => {
      const res = await post({ action: "queue", uri });
      if (res.ok) return { ok: true };
      try {
        const j = await res.json();
        return { ok: false, message: j?.message };
      } catch {
        return { ok: false };
      }
    },
    [post],
  );

  return (
    <SpotifyContext.Provider
      value={{
        connected,
        configured,
        track: now.track ?? "Not playing",
        artist: now.artist || (connected ? "Spotify" : "Connect Spotify"),
        playing,
        now,
        liveProgressMs,
        connect,
        disconnect,
        refresh: poll,
        togglePlay,
        next,
        prev,
        seek,
        setVolume,
        toggleShuffle,
        cycleRepeat,
        playUris,
        playContext,
        queue,
        sdkDeviceId,
      }}
    >
      {children}
    </SpotifyContext.Provider>
  );
}

export function useSpotify() {
  const ctx = useContext(SpotifyContext);
  if (!ctx) throw new Error("useSpotify must be used within SpotifyProvider");
  return ctx;
}
