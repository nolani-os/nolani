/**
 * Live conversation (Clara Voice v2): full-duplex via LiveKit.
 *
 * Unlike the classic voice mode (record → STT → LLM → TTS → replay), this
 * runs a real WebRTC session against the LiveKit agent on the voice server:
 * Clara listens continuously (VAD + German turn detection), and you can
 * interrupt her (barge-in). The token comes authenticated from claraos-api
 * (`/voice/token`, per-user room); the SDK is lazy-loaded as a self-hosted
 * UMD bundle (no CDN, no npm dependency).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { i18n } from "@claraos/core";

const BASE = "/api/claraos/chat/v2";
const SDK_SRC = "/vendor/livekit-client.umd.min.js";

export type LiveVoiceState = "idle" | "connecting" | "listening" | "speaking" | "error";

declare global {
  interface Window {
    LivekitClient?: any;
  }
}

let sdkPromise: Promise<any> | null = null;

function loadSdk(): Promise<any> {
  if (window.LivekitClient) return Promise.resolve(window.LivekitClient);
  if (!sdkPromise) {
    sdkPromise = new Promise<any>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = SDK_SRC;
      s.async = true;
      s.onload = () =>
        window.LivekitClient
          ? resolve(window.LivekitClient)
          : reject(new Error(i18n.t("chatWork:voice.sdkIncomplete")));
      s.onerror = () => {
        sdkPromise = null;
        reject(new Error(i18n.t("chatWork:voice.sdkLoadFailed")));
      };
      document.head.appendChild(s);
    });
  }
  return sdkPromise;
}

export interface LiveVoiceHandlers {
  /** A final spoken sentence — yours ("user") or Clara's ("assistant"). */
  onTranscript?: (role: "user" | "assistant", text: string) => void;
  /** An event from Clara's run, e.g. a confirmation card (`ui.block`). */
  onUiEvent?: (ev: Record<string, unknown>) => void;
}

/** Data channel of the voice agent for cards (agent.py UI_TOPIC). */
const UI_TOPIC = "clara.ui";

export function useLiveVoice(handlers: LiveVoiceHandlers = {}) {
  // Latest handlers without re-creating start() (the room outlives renders).
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const [state, setState] = useState<LiveVoiceState>("idle");
  const [error, setError] = useState<string | null>(null);
  const roomRef = useRef<any>(null);
  const audioElsRef = useRef<HTMLAudioElement[]>([]);

  const cleanup = useCallback(() => {
    audioElsRef.current.forEach((el) => {
      el.pause();
      el.remove();
    });
    audioElsRef.current = [];
  }, []);

  const stop = useCallback(async () => {
    const room = roomRef.current;
    roomRef.current = null;
    cleanup();
    try {
      await room?.disconnect();
    } catch {
      /* already disconnected */
    }
    setState("idle");
    setError(null);
  }, [cleanup]);

  const start = useCallback(async () => {
    if (roomRef.current) return;
    setError(null);
    setState("connecting");
    try {
      const lk = await loadSdk();
      const resp = await fetch(`${BASE}/voice/token`, { credentials: "include" });
      if (!resp.ok) throw new Error(i18n.t("chatWork:voice.backendUnreachable", { status: resp.status }));
      const { token, url } = await resp.json();

      const room = new lk.Room();
      roomRef.current = room;

      room.on(lk.RoomEvent.TrackSubscribed, (track: any) => {
        if (track.kind === "audio") {
          const el: HTMLAudioElement = track.attach();
          el.style.display = "none";
          document.body.appendChild(el);
          audioElsRef.current.push(el);
        }
      });
      room.on(lk.RoomEvent.ActiveSpeakersChanged, (speakers: any[]) => {
        const claraTalks = speakers.some((p) => String(p?.identity ?? "").startsWith("agent"));
        setState((s) =>
          s === "listening" || s === "speaking" ? (claraTalks ? "speaking" : "listening") : s,
        );
      });
      // Transcripts of both sides (LiveKit agents publish them as text streams).
      room.registerTextStreamHandler?.("lk.transcription", async (reader: any, info: any) => {
        try {
          const text: string = await reader.readAll();
          const attrs = reader.info?.attributes ?? {};
          if (attrs["lk.transcription_final"] === "false") return; // interim
          const role = String(info?.identity ?? "").startsWith("agent") ? "assistant" : "user";
          handlersRef.current.onTranscript?.(role, text);
        } catch {
          /* stream aborted — the next sentence comes anyway */
        }
      });
      room.on(lk.RoomEvent.DataReceived, (payload: Uint8Array, _p: any, _k: any, topic?: string) => {
        if (topic !== UI_TOPIC) return;
        try {
          handlersRef.current.onUiEvent?.(JSON.parse(new TextDecoder().decode(payload)));
        } catch {
          /* not JSON — ignore */
        }
      });
      room.on(lk.RoomEvent.Disconnected, () => {
        if (roomRef.current) {
          roomRef.current = null;
          cleanup();
          setState("idle");
        }
      });

      await room.connect(url, token);
      await room.localParticipant.setMicrophoneEnabled(true);
      setState("listening");
    } catch (e: any) {
      const room = roomRef.current;
      roomRef.current = null;
      cleanup();
      try {
        await room?.disconnect();
      } catch {
        /* ignore */
      }
      setError(e?.message ?? String(e));
      setState("error");
    }
  }, [cleanup]);

  const toggle = useCallback(() => {
    if (roomRef.current) void stop();
    else void start();
  }, [start, stop]);

  // Close the session cleanly on unmount (otherwise Clara keeps listening)
  useEffect(() => () => void stop(), [stop]);

  const active = state === "connecting" || state === "listening" || state === "speaking";
  return { state, error, active, start, stop, toggle };
}
