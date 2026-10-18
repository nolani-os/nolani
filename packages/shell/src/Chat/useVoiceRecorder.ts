/**
 * VoiceRecorderSession — mic capture engine for the Clara voice UX.
 *
 * One instance = one utterance. Deliberately a plain class (not a hook) so the
 * lifecycle is explicit: useClaraChat holds it in a ref, disposes on unmount.
 *
 * What it does beyond the old inline MediaRecorder code:
 *   * level metering (AnalyserNode RMS, EMA-smoothed) → onLevel 0..1
 *   * client-side VAD: auto-stop after trailing silence once speech was heard;
 *     never auto-stops BEFORE speech; hard caps for no-speech and utterance
 *   * pseudo-live transcript: periodically transcribes the full accumulated
 *     blob via the batch STT endpoint → onInterim (WebM chunks are only
 *     decodable as a prefix-complete concatenation, so always from chunk 0)
 *   * distinguishable mic errors (permission / no device) → onError
 */
import { transcribe as transcribeApi } from "./api";

export interface VoiceRecorderCallbacks {
  onState: (s: "arming" | "recording" | "stopped") => void;
  /** Smoothed input level 0..1, ~15 Hz while recording. */
  onLevel: (level: number) => void;
  /** Pseudo-live transcript of everything spoken so far. */
  onInterim: (text: string) => void;
  /** Final transcript. hadSpeech=false ⇒ text is empty and must not be sent. */
  onFinal: (text: string, meta: { hadSpeech: boolean }) => void;
  onError: (message: string) => void;
}

export interface VoiceRecorderOptions {
  language?: string;          // default "de"
  interimIntervalMs?: number; // min spacing between interim STT calls
  silenceStopMs?: number;     // trailing silence (after speech) that ends the utterance
  maxUtteranceMs?: number;    // hard cap per utterance
  noSpeechTimeoutMs?: number; // stop (without send) when nothing was ever said
  /** Disable interim transcription (pure batch mode). */
  noInterims?: boolean;
}

const DEFAULTS: Required<Omit<VoiceRecorderOptions, "language" | "noInterims">> = {
  interimIntervalMs: 1600,
  silenceStopMs: 1800,
  maxUtteranceMs: 30_000,
  noSpeechTimeoutMs: 10_000,
};

function micErrorMessage(err: unknown): string {
  const name = (err as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "Mikrofon nicht erlaubt — bitte im Browser freigeben.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "Kein Mikrofon gefunden.";
  }
  if (name === "NotReadableError") {
    return "Mikrofon ist durch eine andere App belegt.";
  }
  return `Mikrofon-Fehler: ${err}`;
}

export class VoiceRecorderSession {
  private cb: VoiceRecorderCallbacks;
  private opts: Required<Omit<VoiceRecorderOptions, "language" | "noInterims">> & {
    language: string;
    noInterims: boolean;
  };

  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private mimeType = "audio/webm";
  private filename = "speech.webm";

  private audioCtx: AudioContext | null = null;
  private levelTimer: number | null = null;

  // VAD state
  private ema = 0;
  private noiseFloor = Infinity;
  private calibrateUntil = 0;
  private speechDetected = false;
  private ticksAboveThreshold = 0;
  private silenceSince: number | null = null;
  private startedAt = 0;

  // interim STT state
  private lastInterimAt = 0;
  private interimInFlight = false;
  private interimFailures = 0;
  private interimAbort: AbortController | null = null;
  /** bumped on stop(); late interim results from an older generation are dropped */
  private generation = 0;

  private stopped = false;
  private disposed = false;
  private stopReasonSend = true; // false = no-speech timeout (don't transcribe/send)

  constructor(cb: VoiceRecorderCallbacks, opts: VoiceRecorderOptions = {}) {
    this.cb = cb;
    this.opts = { ...DEFAULTS, language: opts.language ?? "de", noInterims: !!opts.noInterims, ...opts };
  }

  async start(): Promise<void> {
    if (this.disposed) return;
    this.cb.onState("arming");
    if (!navigator.mediaDevices?.getUserMedia) {
      // mediaDevices exists only in secure contexts (HTTPS / localhost)
      this.cb.onError("Mikrofon hier nicht verfügbar — ClaraOS über HTTPS öffnen.");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      this.cb.onError(micErrorMessage(err));
      return;
    }
    if (this.disposed) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;

    // mimeType fallback chain — iOS Safari records mp4, not webm.
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported) {
      if (MediaRecorder.isTypeSupported("audio/webm")) {
        this.mimeType = "audio/webm";
        this.filename = "speech.webm";
      } else if (MediaRecorder.isTypeSupported("audio/mp4")) {
        this.mimeType = "audio/mp4";
        this.filename = "speech.mp4";
      } else {
        this.mimeType = "";
      }
    }
    try {
      this.recorder = this.mimeType
        ? new MediaRecorder(stream, { mimeType: this.mimeType })
        : new MediaRecorder(stream);
    } catch (err) {
      this.cleanupMedia();
      this.cb.onError(`Aufnahme nicht möglich: ${err}`);
      return;
    }

    this.chunks = [];
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
      this.maybeInterim();
    };
    this.recorder.onstop = () => void this.finish();

    this.startAnalyser(stream);

    this.startedAt = Date.now();
    this.calibrateUntil = this.startedAt + 500;
    this.recorder.start(1000); // timeslice → chunks for interim STT
    this.cb.onState("recording");
  }

  /** End the utterance (user tap or VAD). Final transcription follows. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.generation += 1; // invalidate in-flight interims
    this.interimAbort?.abort();
    this.stopLevelLoop();
    const rec = this.recorder;
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop(); // → onstop → finish()
      } catch {
        void this.finish();
      }
    } else {
      void this.finish();
    }
  }

  /** Idempotent teardown without a final transcript (overlay closed etc.). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopped = true;
    this.generation += 1;
    this.interimAbort?.abort();
    this.stopLevelLoop();
    const rec = this.recorder;
    if (rec && rec.state !== "inactive") {
      rec.onstop = null; // no final callback on dispose
      try {
        rec.stop();
      } catch {
        /* already stopping */
      }
    }
    this.cleanupMedia();
  }

  // ── internals ──

  private startAnalyser(stream: MediaStream): void {
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioCtx = new Ctx();
      const source = this.audioCtx.createMediaStreamSource(stream);
      const analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      const buf = new Uint8Array(new ArrayBuffer(analyser.fftSize));

      this.levelTimer = window.setInterval(() => this.levelTick(analyser, buf), 66);
    } catch {
      // No analyser → no VAD/level; recording still works, user taps to stop.
    }
  }

  private levelTick(analyser: AnalyserNode, buf: Uint8Array<ArrayBuffer>): void {
    if (this.stopped) return;
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length);
    this.ema = this.ema * 0.7 + rms * 0.3;
    this.cb.onLevel(Math.min(1, this.ema * 6));

    const now = Date.now();
    if (now < this.calibrateUntil) {
      this.noiseFloor = Math.min(this.noiseFloor, this.ema || 0.001);
      return;
    }
    if (!isFinite(this.noiseFloor)) this.noiseFloor = 0.005;
    const threshold = Math.max(this.noiseFloor * 3, 0.02);

    if (this.ema > threshold) {
      this.ticksAboveThreshold += 1;
      if (this.ticksAboveThreshold >= 2) this.speechDetected = true;
      this.silenceSince = null;
    } else {
      this.ticksAboveThreshold = 0;
      if (this.speechDetected && this.silenceSince === null) this.silenceSince = now;
    }

    // auto-stop rules
    if (this.speechDetected && this.silenceSince !== null && now - this.silenceSince >= this.opts.silenceStopMs) {
      this.stop();
      return;
    }
    if (!this.speechDetected && now - this.startedAt >= this.opts.noSpeechTimeoutMs) {
      this.stopReasonSend = false;
      this.stop();
      return;
    }
    if (now - this.startedAt >= this.opts.maxUtteranceMs) {
      this.stop();
    }
  }

  private maybeInterim(): void {
    if (this.opts.noInterims || this.stopped || this.interimInFlight) return;
    if (!this.speechDetected) return;
    if (this.interimFailures >= 2) return; // degraded to pure batch for this session
    const now = Date.now();
    if (now - this.lastInterimAt < this.opts.interimIntervalMs) return;
    this.lastInterimAt = now;
    this.interimInFlight = true;
    const gen = this.generation;
    this.interimAbort = new AbortController();
    const blob = new Blob(this.chunks, { type: this.mimeType || "audio/webm" });
    transcribeApi(blob, this.opts.language, { signal: this.interimAbort.signal, filename: this.filename })
      .then((r) => {
        if (gen !== this.generation || this.stopped) return; // stale
        this.interimFailures = 0;
        if (r.text) this.cb.onInterim(r.text.trim());
      })
      .catch((err) => {
        if ((err as { name?: string } | null)?.name === "AbortError") return;
        this.interimFailures += 1;
      })
      .finally(() => {
        this.interimInFlight = false;
      });
  }

  private async finish(): Promise<void> {
    if (this.disposed) return;
    this.cb.onState("stopped");
    const hadSpeech = this.speechDetected && this.stopReasonSend;
    const blob = new Blob(this.chunks, { type: this.mimeType || "audio/webm" });
    this.cleanupMedia();
    if (!hadSpeech || blob.size === 0) {
      // never transcribe silence — Whisper hallucinates on empty audio
      this.cb.onFinal("", { hadSpeech: false });
      return;
    }
    try {
      const result = await transcribeApi(blob, this.opts.language, { filename: this.filename });
      if (this.disposed) return;
      this.cb.onFinal((result.text ?? "").trim(), { hadSpeech: true });
    } catch (err) {
      if (this.disposed) return;
      this.cb.onError(`Transkription fehlgeschlagen: ${err}`);
      this.cb.onFinal("", { hadSpeech: false });
    }
  }

  private stopLevelLoop(): void {
    if (this.levelTimer !== null) {
      window.clearInterval(this.levelTimer);
      this.levelTimer = null;
    }
  }

  private cleanupMedia(): void {
    this.stopLevelLoop();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.audioCtx && this.audioCtx.state !== "closed") {
      void this.audioCtx.close().catch(() => undefined);
    }
    this.audioCtx = null;
    this.recorder = null;
  }
}
