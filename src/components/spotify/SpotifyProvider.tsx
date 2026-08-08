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
};

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { AccountState } from "@/components/layout/ShellProfileContext";
import {
  openDirectOAuthPopup,
  type OAuthPopupHandle,
} from "@/lib/auth/openOAuthPopup";
import { subjectBoundFetch } from "@/lib/auth/subjectBoundFetch";
import { describeSpotifyConnectFailure } from "@/lib/spotify/connectFailure";

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
  connected: boolean;
  configured: boolean;
  connectError: string | null;
  track: string;
  artist: string;
  playing: boolean;
  now: NowPlaying;
  liveProgressMs: number;
  connect: () => void;
  disconnect: () => Promise<boolean>;
  refresh: () => Promise<void>;
  togglePlay: () => Promise<void>;
  next: () => Promise<void>;
  prev: () => Promise<void>;
  seek: (ms: number) => Promise<void>;
  setVolume: (pct: number) => Promise<void>;
  toggleShuffle: () => Promise<void>;
  cycleRepeat: () => Promise<void>;
  playUris: (uris: string[]) => Promise<boolean>;
  playContext: (contextUri: string) => Promise<boolean>;
  queue: (uri: string) => Promise<{ ok: boolean; message?: string } | null>;
  sdkDeviceId: string | null;
};

type Authority = { subject: string; epoch: number };

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

export function SpotifyProvider({
  children,
  accountState,
  subject,
  authorityEpoch,
}: {
  children: ReactNode;
  accountState: AccountState;
  subject: string | null;
  authorityEpoch: number;
}) {
  const [connected, setConnected] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [now, setNow] = useState<NowPlaying>(EMPTY_NOW);
  const [liveProgressMs, setLiveProgressMs] = useState(0);
  const [sdkDeviceId, setSdkDeviceId] = useState<string | null>(null);
  const lastSync = useRef(Date.now());
  const sdkPlayerRef = useRef<SpotifyPlayer | null>(null);
  const controllersRef = useRef(new Set<AbortController>());
  const resyncTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  const popupRef = useRef<OAuthPopupHandle | null>(null);
  const authorityRef = useRef<Authority | null>(null);
  const stateAuthorityRef = useRef<Authority | null>(null);
  authorityRef.current = accountState === "ready" && subject
    ? { subject, epoch: authorityEpoch }
    : null;

  const isCurrent = useCallback((authority: Authority) => {
    const current = authorityRef.current;
    return current?.subject === authority.subject && current.epoch === authority.epoch;
  }, []);

  const beginRequest = useCallback(() => {
    const authority = authorityRef.current;
    if (!authority) return null;
    const controller = new AbortController();
    controllersRef.current.add(controller);
    return { authority, controller };
  }, []);

  const finishRequest = useCallback((controller: AbortController) => {
    controllersRef.current.delete(controller);
  }, []);

  const clearProviderState = useCallback(() => {
    stateAuthorityRef.current = null;
    setConnected(false);
    setConfigured(false);
    setPlaying(false);
    setNow(EMPTY_NOW);
    setLiveProgressMs(0);
    setSdkDeviceId(null);
    setConnectError(null);
  }, []);

  const retireOperations = useCallback(() => {
    for (const controller of controllersRef.current) controller.abort();
    controllersRef.current.clear();
    for (const timer of resyncTimersRef.current) clearTimeout(timer);
    resyncTimersRef.current.clear();
    popupRef.current?.cancel();
    popupRef.current = null;
    sdkPlayerRef.current?.disconnect();
    sdkPlayerRef.current = null;
  }, []);

  const poll = useCallback(async () => {
    const operation = beginRequest();
    if (!operation) return;
    const { authority, controller } = operation;
    try {
      const response = await subjectBoundFetch(
        authority.subject,
        "/api/spotify/playback",
        { signal: controller.signal },
      );
      if (!isCurrent(authority) || controller.signal.aborted) return;
      const data = await response.json().catch(() => ({})) as {
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
      if (!isCurrent(authority) || controller.signal.aborted) return;
      if (!response.ok) {
        stateAuthorityRef.current = authority;
        setConnected(false);
        setPlaying(false);
        setNow(EMPTY_NOW);
        if (typeof data.configured === "boolean") setConfigured(data.configured);
        if (response.status >= 500) setConnectError("Spotify status could not be loaded.");
        return;
      }
      setConnectError(null);
      stateAuthorityRef.current = authority;
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
      } else {
        setNow(EMPTY_NOW);
        setPlaying(false);
        setLiveProgressMs(0);
      }
    } catch {
      if (!isCurrent(authority) || controller.signal.aborted) return;
      stateAuthorityRef.current = authority;
      setConnectError("Spotify status could not be loaded.");
    } finally {
      finishRequest(controller);
    }
  }, [beginRequest, finishRequest, isCurrent]);

  useEffect(() => {
    retireOperations();
    clearProviderState();
    if (!authorityRef.current) return;
    void poll();
    const interval = setInterval(() => void poll(), 5_000);
    return () => {
      clearInterval(interval);
      retireOperations();
    };
  }, [accountState, authorityEpoch, clearProviderState, poll, retireOperations, subject]);

  useEffect(() => {
    if (!playing || now.durationMs <= 0 || !authorityRef.current) return;
    const authority = authorityRef.current;
    const tick = setInterval(() => {
      if (!isCurrent(authority)) return;
      setLiveProgressMs(Math.min(now.progressMs + Date.now() - lastSync.current, now.durationMs));
    }, 500);
    return () => clearInterval(tick);
  }, [isCurrent, now.durationMs, now.progressMs, playing]);

  useEffect(() => {
    const authority = authorityRef.current;
    if (!connected || !authority) return;
    if (!document.getElementById("spotify-sdk")) {
      const script = document.createElement("script");
      script.id = "spotify-sdk";
      script.src = "https://sdk.scdn.co/spotify-player.js";
      document.body.appendChild(script);
    }
    const readyHandler = () => {
      if (!isCurrent(authority)) return;
      const player = new window.Spotify.Player({
        name: "Axis Web Player",
        getOAuthToken: (callback) => {
          const operation = beginRequest();
          if (!operation || !isCurrent(authority)) return;
          void (async () => {
            try {
              const response = await subjectBoundFetch(
                authority.subject,
                "/api/spotify/token",
                { signal: operation.controller.signal },
              );
              if (!response.ok || !isCurrent(authority) || operation.controller.signal.aborted) return;
              const body = await response.json().catch(() => null) as { access_token?: unknown } | null;
              if (!isCurrent(authority) || operation.controller.signal.aborted) return;
              if (typeof body?.access_token === "string") callback(body.access_token);
            } catch {
              if (isCurrent(authority) && !operation.controller.signal.aborted) {
                stateAuthorityRef.current = authority;
                setConnectError("Spotify session could not be refreshed.");
              }
            } finally {
              finishRequest(operation.controller);
            }
          })();
        },
        volume: 0.7,
      });
      sdkPlayerRef.current = player;
      player.addListener("ready", (state) => {
        if (!isCurrent(authority) || sdkPlayerRef.current !== player) return;
        const deviceId = state.device_id;
        if (typeof deviceId === "string") setSdkDeviceId(deviceId);
      });
      player.addListener("not_ready", () => {
        if (isCurrent(authority) && sdkPlayerRef.current === player) setSdkDeviceId(null);
      });
      for (const event of ["initialization_error", "authentication_error", "account_error"]) {
        player.addListener(event, () => {
          if (isCurrent(authority) && sdkPlayerRef.current === player) setSdkDeviceId(null);
        });
      }
      void player.connect();
    };
    window.onSpotifyWebPlaybackSDKReady = readyHandler;
    if (window.Spotify?.Player) readyHandler();
    return () => {
      if (window.onSpotifyWebPlaybackSDKReady === readyHandler) {
        window.onSpotifyWebPlaybackSDKReady = () => undefined;
      }
      if (sdkPlayerRef.current) sdkPlayerRef.current.disconnect();
      sdkPlayerRef.current = null;
      setSdkDeviceId(null);
    };
  }, [beginRequest, connected, finishRequest, isCurrent]);

  const connect = useCallback(() => {
    const authority = authorityRef.current;
    if (!authority) {
      setConnectError("Sign in again before connecting Spotify.");
      return;
    }
    setConnectError(null);
    stateAuthorityRef.current = authority;
    popupRef.current?.cancel();
    popupRef.current = openDirectOAuthPopup({
      provider: "spotify",
      subject: authority.subject,
      epoch: authority.epoch,
      isCurrent: (expectedSubject, expectedEpoch) => isCurrent({
        subject: expectedSubject,
        epoch: expectedEpoch,
      }),
      onDone: (_provider, status, reason) => {
        popupRef.current = null;
        if (!isCurrent(authority)) return;
        if (status === "ok") {
          void poll();
          return;
        }
        setConnectError(describeSpotifyConnectFailure(reason));
      },
    });
  }, [isCurrent, poll]);

  const post = useCallback(async (body: Record<string, unknown>) => {
    const operation = beginRequest();
    if (!operation) return null;
    const { authority, controller } = operation;
    const payload = body.action === "play" && sdkDeviceId
      ? { ...body, device_id: sdkDeviceId }
      : body;
    try {
      const response = await subjectBoundFetch(
        authority.subject,
        "/api/spotify/playback",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        },
      );
      if (!isCurrent(authority) || controller.signal.aborted) return null;
      const timer = setTimeout(() => {
        resyncTimersRef.current.delete(timer);
        if (isCurrent(authority)) void poll();
      }, 350);
      resyncTimersRef.current.add(timer);
      return { response, authority };
    } catch {
      if (isCurrent(authority) && !controller.signal.aborted) {
        stateAuthorityRef.current = authority;
        setConnectError("Spotify action could not be completed.");
      }
      return null;
    } finally {
      finishRequest(controller);
    }
  }, [beginRequest, finishRequest, isCurrent, poll, sdkDeviceId]);

  const disconnect = useCallback(async () => {
    const operation = beginRequest();
    if (!operation) return false;
    const { authority, controller } = operation;
    try {
      const response = await subjectBoundFetch(
        authority.subject,
        "/api/spotify/disconnect",
        { method: "POST", signal: controller.signal },
      );
      if (!isCurrent(authority) || controller.signal.aborted) return false;
      if (!response.ok) {
        setConnectError("Spotify could not be disconnected.");
        return false;
      }
      clearProviderState();
      return true;
    } catch {
      if (isCurrent(authority) && !controller.signal.aborted) {
        stateAuthorityRef.current = authority;
        setConnectError("Spotify could not be disconnected.");
      }
      return false;
    } finally {
      finishRequest(controller);
    }
  }, [beginRequest, clearProviderState, finishRequest, isCurrent]);

  const togglePlay = useCallback(async () => {
    const authority = authorityRef.current;
    if (!authority) return;
    setPlaying((current) => !current);
    await post({ action: playing ? "pause" : "play" });
  }, [playing, post]);
  const next = useCallback(async () => { await post({ action: "next" }); }, [post]);
  const prev = useCallback(async () => { await post({ action: "prev" }); }, [post]);
  const seek = useCallback(async (ms: number) => {
    if (!authorityRef.current) return;
    setLiveProgressMs(ms);
    lastSync.current = Date.now();
    setNow((current) => ({ ...current, progressMs: ms }));
    await post({ action: "seek", value: Math.round(ms) });
  }, [post]);
  const setVolume = useCallback(async (pct: number) => {
    if (!authorityRef.current) return;
    setNow((current) => ({ ...current, volume: pct }));
    await post({ action: "volume", value: pct });
  }, [post]);
  const toggleShuffle = useCallback(async () => {
    if (!authorityRef.current) return;
    const value = !now.shuffle;
    setNow((current) => ({ ...current, shuffle: value }));
    await post({ action: "shuffle", value });
  }, [now.shuffle, post]);
  const cycleRepeat = useCallback(async () => {
    if (!authorityRef.current) return;
    const order = ["off", "context", "track"];
    const value = order[(order.indexOf(now.repeat) + 1) % order.length];
    setNow((current) => ({ ...current, repeat: value }));
    await post({ action: "repeat", value });
  }, [now.repeat, post]);
  const playUris = useCallback(async (uris: string[]) => Boolean(
    await post({ action: "play", uris }),
  ), [post]);
  const playContext = useCallback(async (contextUri: string) => Boolean(
    await post({ action: "play", contextUri }),
  ), [post]);
  const queue = useCallback(async (uri: string) => {
    const result = await post({ action: "queue", uri });
    if (result?.response.ok) return { ok: true };
    if (!result) return null;
    try {
      const body = await result.response.json() as { message?: string };
      if (!isCurrent(result.authority)) return null;
      return { ok: false, message: body.message };
    } catch {
      return { ok: false };
    }
  }, [isCurrent, post]);

  const currentAuthority = authorityRef.current;
  const stateAuthority = stateAuthorityRef.current;
  const mayRenderProviderState = Boolean(
    currentAuthority &&
    stateAuthority &&
    currentAuthority.subject === stateAuthority.subject &&
    currentAuthority.epoch === stateAuthority.epoch,
  );
  const visibleNow = mayRenderProviderState ? now : EMPTY_NOW;
  const visibleConnected = mayRenderProviderState ? connected : false;

  return (
    <SpotifyContext.Provider value={{
      connected: visibleConnected,
      configured: mayRenderProviderState ? configured : false,
      connectError: mayRenderProviderState ? connectError : null,
      track: visibleNow.track ?? "Not playing",
      artist: visibleNow.artist || (visibleConnected ? "Spotify" : "Connect Spotify"),
      playing: mayRenderProviderState ? playing : false,
      now: visibleNow,
      liveProgressMs: mayRenderProviderState ? liveProgressMs : 0,
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
      sdkDeviceId: mayRenderProviderState ? sdkDeviceId : null,
    }}>
      {children}
    </SpotifyContext.Provider>
  );
}

export function useSpotify() {
  const context = useContext(SpotifyContext);
  if (!context) throw new Error("useSpotify must be used within SpotifyProvider");
  return context;
}
