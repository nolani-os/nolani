/**
 * "Living photo": a seamless video loop plays as a plain <video> element —
 * decoded and composited by the browser on its own hardware path — and the
 * time of day is laid over it with the lightest means each engine has:
 *
 *   - ground: two plain overlays (a dark cool one for night, a warm one for
 *     dusk) whose opacity follows the solar altitude — no CSS filter, no
 *     blend mode, both of which force software compositing in WebKitGTK;
 *   - sky: a WebGL layer with alpha, masked to the sky of the footage. By day
 *     it is fully transparent (the real sky stays). Through dusk it tints the
 *     sky, at night it darkens it to a deep blue in which the footage's own
 *     clouds still move faintly, and lays a photographic star field and a
 *     photographed moon (phase from the real date, shaded as a sphere) on top.
 *
 * Budget: one decoder except for the 0.35 s hand-over, the sky layer redraws at 4 fps at most, nothing
 * while the tab is hidden; with reduced motion the poster is shown instead of
 * the video and the sky is redrawn only when the sun moves (once a minute).
 */
import { useEffect, useRef, useState } from "react";
import { livingPhotoTextures } from "@claraos/skins";
import { useSunState } from "../../useSunState";
import styles from "./LivingPhotoScene.module.css";

export interface LivingPhotoConfig {
  /** Video base path without extension; `.mp4` (H.264) and `.webm` (AV1) must both exist. */
  video: string;
  /** Still of the first video frame — shown until the video plays and under reduced motion. */
  poster: string;
  /** R = sky alpha, G = cloud alpha, same framing as the video. */
  mask: string;
  /** Horizon as a fraction of the image height (0 = top). */
  horizon: number;
  /** Kept for the catalog; both kinds share the same sky treatment. */
  kind: "meadow" | "shore";
}

const SKY_FPS = 4;
/** Seconds of overlap at the loop point. */
const XFADE = 0.35;

const VS = `attribute vec2 a; void main(){ gl_Position = vec4(a, 0., 1.); }`;
// Premultiplied RGBA. Alpha is the sky mask times how much the hour calls for.
const FS = `precision highp float;
uniform sampler2D uMask, uSky, uMoon; uniform vec2 uRes, uUvScale; uniform float uTime, uAlt, uSunX, uHorizon, uMoonPhase, uHasMask, uPlateAspect;
void main(){
  vec2 p = gl_FragCoord.xy/uRes; p.y = 1.-p.y;
  vec2 uv = (p-0.5)*uUvScale + 0.5;
  vec3 m = texture2D(uMask, uv).rgb * uHasMask; float sky = m.r, cloud = m.g;
  // How much the hour overrides the footage: 0 by day, 1 deep in the night.
  float dusk = smoothstep(10., -3., uAlt);
  float night = smoothstep(-4., -14., uAlt);
  float t = clamp((uHorizon - uv.y)/max(uHorizon,0.001), 0., 1.);
  vec2 ar = vec2(uRes.x/uRes.y, 1.);
  // Dusk: warm band at the horizon, violet above.
  vec3 duskCol = mix(vec3(0.96,0.60,0.36), vec3(0.42,0.38,0.62), pow(t, 0.6));
  // Night: a photographed sky plate whose bottom edge is the horizon; pixels keep
  // their size (no stretch), so only the lower part of the plate is seen.
  // Mild vertical squeeze (1.4) shows more of the plate than the pixel-true band would.
  vec2 skyUv = vec2(uv.x, 1. - (uHorizon - uv.y) * uPlateAspect * uRes.y / uRes.x * 1.4);
  vec3 plate = texture2D(uSky, clamp(skyUv, 0., 1.)).rgb;
  vec3 col = mix(duskCol, plate, night);
  float alpha = mix(0.55, 0.97, night) * dusk;
  // Glow of the low sun near the horizon
  vec2 sunPos = vec2(uSunX, uHorizon - (uAlt/60.)*uHorizon*0.95);
  float dsun = distance(uv*ar, sunPos*ar);
  float lowSun = smoothstep(-7., -2., uAlt) * (1. - smoothstep(4., 12., uAlt));
  col += vec3(1.,0.62,0.30) * (exp(-dsun*7.)*0.35 + exp(-dsun*2.5)*0.10) * lowSun;
  // Moon. Apparent size is half a degree: in this ~70° field of view that is a
  // small disc (not the poster moon of illustrations). A camera exposed for the
  // stars overexposes the lit part toward white, with a soft halo; the unlit
  // part takes on the sky plus a hint of earthshine. The lit limb faces the sun
  // below the horizon, so the crescent tilts with the hour and the season.
  float moonVis = smoothstep(2., -4., uAlt);
  vec2 moonPos = vec2(clamp(1.-uSunX, 0.14, 0.86), uHorizon - clamp((-uAlt+10.)/60., 0.12, 0.8)*uHorizon*0.9);
  float mr = 0.013;
  vec2 rel = (uv*ar - moonPos*ar)/mr;
  float r2 = dot(rel, rel);
  float r = sqrt(r2);
  float ph = uMoonPhase*6.2831853;
  float fullness = 0.5 - 0.5*cos(ph);
  vec2 toSun = normalize((sunPos - moonPos) * ar);
  vec3 l = normalize(vec3(toSun.x * abs(sin(ph)), -toSun.y * abs(sin(ph)), -cos(ph)));
  float halo = (exp(-max(0., r - 1.) * 4.0) * 0.30 + exp(-max(0., r - 1.) * 0.9) * 0.06) * (0.35 + 0.65*fullness) * moonVis * night;
  col += vec3(0.86, 0.90, 1.0) * halo * (1.-cloud);
  alpha = max(alpha, halo * 0.6);
  if (r2 < 1.0 && moonVis > 0.01) {
    float z = sqrt(1.-r2);
    vec3 n = vec3(rel.x, -rel.y, z);
    float lit = smoothstep(-0.02, 0.10, dot(n, l));
    vec3 tex = texture2D(uMoon, rel*0.39 + 0.5).rgb;
    vec3 surf = mix(pow(tex, vec3(0.7)) * 1.2, vec3(1.0, 0.99, 0.96), 0.35);
    float disc = (1. - smoothstep(0.90, 1.0, r2)) * moonVis;
    vec3 moonCol = surf * lit + (col * 0.95 + vec3(0.025) * night) * (1.-lit);
    col = mix(col, moonCol, disc);
    alpha = max(alpha, disc * lit);
  }
  alpha *= sky;
  gl_FragColor = vec4(col * alpha, alpha);
}`;

const UNIFORMS = [
  "uMask", "uSky", "uMoon", "uRes", "uUvScale", "uTime", "uAlt", "uSunX", "uHorizon",
  "uMoonPhase", "uHasMask", "uPlateAspect",
] as const;
type UniformName = (typeof UNIFORMS)[number];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Opacity of the two ground overlays for a solar altitude. */
export function groundLight(altitude: number): { night: number; warm: number } {
  const day = smoothstep(-6, 4, altitude);
  const warm = clamp(1 - Math.abs(altitude) / 10, 0, 1) * smoothstep(-8, -5, altitude);
  return { night: (1 - day) * 0.72, warm: warm * 0.22 };
}

/** H.264 for Safari/iOS and the desktop/mobile apps, AV1 WebM for Chromium/Firefox builds without proprietary codecs. */
function videoExtension(): string {
  const probe = document.createElement("video");
  if (probe.canPlayType('video/mp4; codecs="avc1.4D401F"')) return ".mp4";
  if (probe.canPlayType('video/webm; codecs="av01.0.05M.08"')) return ".webm";
  return ".mp4";
}

function debugEnabled(): boolean {
  if (typeof location === "undefined") return false;
  try {
    if (/[?&]lpdebug=1/.test(location.search)) localStorage.setItem("claraos-scene-debug", "1");
    if (/[?&]lpdebug=0/.test(location.search)) localStorage.removeItem("claraos-scene-debug");
    return localStorage.getItem("claraos-scene-debug") === "1";
  } catch {
    return /[?&]lpdebug=1/.test(location.search);
  }
}

/** Last few player/GL events with a time stamp, for the on-screen readout. */
const eventLog: string[] = [];
let glLost = 0;
function logEvent(what: string): void {
  const d = new Date();
  eventLog.push(`${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")} ${what}`);
  if (eventLog.length > 6) eventLog.shift();
}

function reducedMotion(): boolean {
  return (
    document.documentElement.dataset.reduceMotion === "1" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function LivingPhotoScene(cfg: LivingPhotoConfig) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoARef = useRef<HTMLVideoElement>(null);
  const videoBRef = useRef<HTMLVideoElement>(null);
  const nightRef = useRef<HTMLDivElement>(null);
  const warmRef = useRef<HTMLDivElement>(null);
  const hudRef = useRef<HTMLDivElement>(null);
  const sun = useSunState();
  const sunRef = useRef(sun);
  sunRef.current = sun;
  const reduce = typeof document !== "undefined" && reducedMotion();
  // Diagnostics for devices nobody can look at remotely: ?lpdebug=1 switches the
  // readout on and remembers it (?lpdebug=0 switches it off), so it survives the
  // in-app navigation that drops the query string.
  const [debug, setDebug] = useState(debugEnabled);
  // Ctrl+Alt+D toggles the readout — the desktop and mobile apps have no address bar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && (e.key === "d" || e.key === "D")) {
        const on = !debugEnabled();
        try {
          if (on) localStorage.setItem("claraos-scene-debug", "1");
          else localStorage.removeItem("claraos-scene-debug");
        } catch { /* storage blocked: toggle for this page only */ }
        setDebug(on);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── Ground overlays: opacity follows the sun, changes once a minute ───────
  useEffect(() => {
    const light = groundLight(sun.altitude);
    if (nightRef.current) nightRef.current.style.opacity = String(light.night);
    if (warmRef.current) warmRef.current.style.opacity = String(light.warm);
  }, [sun.altitude]);

  // ── The loop ───────────────────────────────────────────────────────────────
  // Preferred: Media Source Extensions. The clip (fragmented MP4) is fetched
  // once and appended to one SourceBuffer again and again in sequence mode —
  // one player, an endless timeline, no seek, no second request. Measured in
  // the frontend log: WebKitGTK's HTTP media source re-requested a 4 MB file
  // 10–18 times per loop and choked; a bare `loop` showed a cut.
  // Fallback (no MSE or no H.264 in MSE): two players streaming the file with a
  // short cross-fade at the hand-over.
  useEffect(() => {
    const a = videoARef.current;
    const b = videoBRef.current;
    if (!a || !b || reduce) return;
    const src = cfg.video + videoExtension();
    const mseType = 'video/mp4; codecs="avc1.4D401F"';
    const useMse = src.endsWith(".mp4") && typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(mseType);
    const diag = { stalls: 0, errors: 0, swaps: 0, src, mode: useMse ? "mse" : "stream" };
    let disposed = false;
    let front = a;
    let back = b;
    for (const v of [a, b]) {
      v.muted = true;
      v.loop = false;
      v.playsInline = true;
    }
    a.style.opacity = "1";
    b.style.opacity = "0";
    const name = (v: HTMLVideoElement) => (v === a ? "A" : "B");
    const onStall = (e: Event) => { diag.stalls++; logEvent(`${name(e.target as HTMLVideoElement)} ${e.type}`); };
    const onError = (e: Event) => {
      const v = e.target as HTMLVideoElement;
      diag.errors++;
      logEvent(`${name(v)} error ${v.error?.code ?? "?"}`);
      v.style.opacity = "0";
    };
    const onPlaying = (e: Event) => logEvent(`${name(e.target as HTMLVideoElement)} playing`);
    for (const v of [a, b]) {
      v.addEventListener("waiting", onStall);
      v.addEventListener("stalled", onStall);
      v.addEventListener("error", onError);
      v.addEventListener("playing", onPlaying);
    }

    const timers: number[] = [];
    let raf = 0;
    let mediaSource: MediaSource | null = null;
    let msUrl = "";
    const aborter = new AbortController();

    if (useMse) {
      // ── MSE path ──
      mediaSource = new MediaSource();
      msUrl = URL.createObjectURL(mediaSource);
      let clip: ArrayBuffer | null = null;
      let sb: SourceBuffer | null = null;
      let appends = 0;
      const AHEAD = 20; // seconds of buffer to keep ahead of the playhead
      const feed = () => {
        if (disposed || !sb || !clip || sb.updating || !mediaSource || mediaSource.readyState !== "open") return;
        const buf = a.buffered;
        const end = buf.length ? buf.end(buf.length - 1) : 0;
        if (end - a.currentTime < AHEAD) {
          try {
            sb.appendBuffer(clip);
            appends++;
          } catch (e) {
            logEvent(`append failed: ${(e as Error).name}`);
          }
          return;
        }
        // Trim what lies well behind the playhead so memory stays flat.
        if (buf.length && a.currentTime - buf.start(0) > 40) {
          try { sb.remove(0, a.currentTime - 25); } catch { /* ignore */ }
        }
      };
      mediaSource.addEventListener("sourceopen", () => {
        if (disposed || !mediaSource) return;
        try {
          sb = mediaSource.addSourceBuffer(mseType);
          sb.mode = "sequence";
        } catch (e) {
          logEvent(`addSourceBuffer failed: ${(e as Error).name}`);
          diag.errors++;
          return;
        }
        sb.addEventListener("updateend", () => {
          if (disposed) return;
          if (appends === 1 && a.paused) {
            void a.play().catch(() => { /* autoplay blocked: the poster stays */ });
          }
          feed();
        });
        fetch(src, { signal: aborter.signal })
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .then((data) => {
            if (disposed) return;
            clip = data;
            logEvent(`clip ${Math.round(data.byteLength / 1024)} KB, MSE`);
            feed();
          })
          .catch((e: unknown) => {
            if (disposed) return;
            diag.errors++;
            logEvent(`fetch failed: ${(e as Error).message}`);
          });
      });
      a.src = msUrl;
      timers.push(window.setInterval(feed, 500));
    } else {
      // ── Streaming fallback: two players ──
      for (const v of [a, b]) {
        v.preload = "auto";
        v.src = src;
      }
      const start = () => {
        void front.play().catch(() => { /* autoplay blocked */ });
        logEvent("A ready");
      };
      a.addEventListener("loadeddata", start, { once: true });
      const swap = () => {
        const done = front;
        front = back;
        back = done;
        front.style.opacity = "1";
        front.style.zIndex = "2";
        back.style.opacity = "0";
        back.style.zIndex = "1";
        back.pause();
        diag.swaps++;
        logEvent(`swap → ${name(front)}`);
        if (front.paused) void front.play().catch(() => {});
      };
      const tick = () => {
        raf = requestAnimationFrame(tick);
        if (disposed || document.hidden) return;
        const dur = front.duration || 0;
        const rest = dur - front.currentTime;
        if (front.ended || (dur && rest <= 0.02)) { swap(); return; }
        if (front.readyState < 2 || front.paused) return;
        if (dur && rest <= XFADE) {
          if (back.paused && back.readyState >= 2) {
            if (back.currentTime > 0.05) back.currentTime = 0;
            back.style.zIndex = "2";
            front.style.zIndex = "1";
            void back.play().catch(() => {});
          }
          if (!back.paused) back.style.opacity = String(clamp(1 - rest / XFADE, 0, 1));
        }
      };
      raf = requestAnimationFrame(tick);
    }

    // Watchdog: a player that has not advanced for 3 s while it should play is
    // reloaded once or twice; after that its layer goes away and the poster stays.
    let lastT = -1;
    let stuckSince = 0;
    let reloads = 0;
    timers.push(window.setInterval(() => {
      if (disposed || document.hidden || front.paused || front.readyState < 2) { stuckSince = 0; return; }
      if (front.currentTime !== lastT) { lastT = front.currentTime; stuckSince = 0; return; }
      stuckSince += 1;
      if (stuckSince >= 3) {
        stuckSince = 0;
        if (reloads < 2) {
          reloads++;
          logEvent(`${name(front)} stuck → ${useMse ? "play" : "reload"} ${reloads}`);
          if (!useMse) {
            const t0 = front.currentTime;
            front.load();
            front.currentTime = t0;
          }
          void front.play().catch(() => {});
        } else {
          logEvent(`${name(front)} stuck → poster`);
          front.style.opacity = "0";
          front.pause();
        }
      }
    }, 1000));

    const onVisibility = () => {
      if (document.hidden) front.pause();
      else void front.play().catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisibility);

    // Diagnostics: the readout is sent every 10 s as a GET to /scene-diag/<line> —
    // a 404 that lands in the frontend's access log, readable on the server for
    // devices nobody can inspect. With Ctrl+Alt+D the same line shows on screen.
    const readout = () => {
      const v = front;
      const q = v.getVideoPlaybackQuality?.();
      const buf = v.buffered;
      const ahead = buf.length ? (buf.end(buf.length - 1) - v.currentTime).toFixed(1) : "-";
      return (
        `${diag.mode} ${diag.src} · ready ${v.readyState}/${back.readyState} net ${v.networkState} · t ${v.currentTime.toFixed(1)} ahead ${ahead}` +
        ` · paused ${v.paused} · swaps ${diag.swaps} stalls ${diag.stalls} errors ${diag.errors}` +
        (q ? ` · frames ${q.totalVideoFrames} dropped ${q.droppedVideoFrames}` : "") +
        (v.error ? ` · error ${v.error.code}` : "") +
        ` · gl lost ${glLost} · ${eventLog.join(" | ")}`
      );
    };
    const beacon = () => fetch("/scene-diag/" + encodeURIComponent(readout()).slice(0, 1500), { cache: "no-store" }).catch(() => {});
    timers.push(window.setInterval(beacon, 10_000));
    timers.push(window.setTimeout(beacon, 3000));
    if (hudRef.current) {
      timers.push(window.setInterval(() => {
        if (hudRef.current) hudRef.current.textContent = readout() + `\n${navigator.userAgent.slice(0, 120)}`;
      }, 500));
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      for (const id of timers) clearInterval(id);
      aborter.abort();
      document.removeEventListener("visibilitychange", onVisibility);
      for (const v of [a, b]) {
        v.removeEventListener("waiting", onStall);
        v.removeEventListener("stalled", onStall);
        v.removeEventListener("error", onError);
        v.removeEventListener("playing", onPlaying);
        v.pause();
        v.removeAttribute("src");
        v.load();
      }
      if (msUrl) URL.revokeObjectURL(msUrl);
    };
  }, [cfg.video, reduce, debug]);

  // ── Sky layer (WebGL, alpha) ──────────────────────────────────────────────
  // A lost context (GPU pressure, common with video on WebKitGTK) is survived:
  // the effect tears down and runs again when the context is restored.
  const [glGeneration, setGlGeneration] = useState(0);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onLost = (e: Event) => { e.preventDefault(); glLost++; logEvent("gl context lost"); };
    const onRestored = () => { logEvent("gl context restored"); setGlGeneration((g) => g + 1); };
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);
    return () => {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
    };
  }, []);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { antialias: false, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: false });
    if (!gl || gl.isContextLost()) return; // no WebGL: the footage's own sky stays
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      return sh;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const attr = gl.getAttribLocation(prog, "a");
    gl.enableVertexAttribArray(attr);
    gl.vertexAttribPointer(attr, 2, gl.FLOAT, false, 0, 0);
    const uni = Object.fromEntries(UNIFORMS.map((n) => [n, gl.getUniformLocation(prog, n)])) as Record<
      UniformName,
      WebGLUniformLocation | null
    >;
    const mkTex = (unit: number, mirror: boolean) => {
      const t = gl.createTexture()!;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      // Mirrored tiling hides the seams of the star field (power-of-two texture).
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, mirror ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, mirror ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0]));
      return t;
    };
    const texMask = mkTex(0, false);
    const texSky = mkTex(1, false);
    const texMoon = mkTex(2, false);
    gl.uniform1i(uni.uMask, 0);
    gl.uniform1i(uni.uSky, 1);
    gl.uniform1i(uni.uMoon, 2);
    gl.clearColor(0, 0, 0, 0);

    let imgSize: [number, number] = [16, 9];
    let hasMask = 0;
    let disposed = false;
    const loadInto = (tex: WebGLTexture, unit: number, src: string, then?: (img: HTMLImageElement) => void) => {
      const img = new Image();
      img.onload = () => {
        if (disposed) return;
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
        then?.(img);
        draw(0);
      };
      img.src = src;
    };
    loadInto(texMask, 0, cfg.mask, (img) => {
      imgSize = [img.naturalWidth, img.naturalHeight];
      hasMask = 1;
    });
    let plateAspect = 1.5;
    loadInto(texSky, 1, livingPhotoTextures.sky, (img) => { plateAspect = img.naturalWidth / img.naturalHeight; });
    loadInto(texMoon, 2, livingPhotoTextures.moon);

    let size = { w: 0, h: 0 };
    const resize = () => {
      const host = canvas.parentElement ?? canvas;
      const r = host.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width));
      const h = Math.max(1, Math.round(r.height));
      if (w !== size.w || h !== size.h) {
        canvas.width = w;
        canvas.height = h;
        size = { w, h };
        gl.viewport(0, 0, w, h);
      }
    };

    const draw = (timeSec: number) => {
      if (disposed) return;
      resize();
      const s = sunRef.current;
      // Same cover fit as the <video> (object-fit: cover) so the mask lines up.
      const sa = size.w / size.h;
      const ia = imgSize[0] / imgSize[1];
      const scale = sa > ia ? [1, ia / sa] : [sa / ia, 1];
      // Azimuth 90° (east) lands left, 270° (west) right.
      const sunX = clamp(0.5 + ((s.azimuth - 180) / 180) * 0.9, 0.05, 0.95);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(uni.uRes, size.w, size.h);
      gl.uniform2f(uni.uUvScale, scale[0], scale[1]);
      gl.uniform1f(uni.uTime, timeSec);
      gl.uniform1f(uni.uAlt, s.altitude);
      gl.uniform1f(uni.uSunX, sunX);
      gl.uniform1f(uni.uHorizon, cfg.horizon);
      gl.uniform1f(uni.uMoonPhase, s.moonPhase);
      gl.uniform1f(uni.uHasMask, hasMask);
      gl.uniform1f(uni.uPlateAspect, plateAspect);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };

    let raf = 0;
    let last = 0;
    const frame = (ts: number) => {
      raf = requestAnimationFrame(frame);
      if (document.hidden || ts - last < 1000 / SKY_FPS) return;
      last = ts;
      draw(ts / 1000);
    };
    if (!reduce) raf = requestAnimationFrame(frame);
    const onResize = () => draw(0);
    window.addEventListener("resize", onResize);
    const sunTick = setInterval(() => draw(0), 60_000);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      clearInterval(sunTick);
      window.removeEventListener("resize", onResize);
      gl.deleteTexture(texMask);
      gl.deleteTexture(texSky);
      gl.deleteTexture(texMoon);
      gl.deleteProgram(prog);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.mask, cfg.horizon, reduce, glGeneration]);

  // Redraw the sky when the sun moves (covers the reduced-motion path too).
  useEffect(() => {
    window.dispatchEvent(new Event("resize"));
  }, [sun.altitude, sun.moonPhase]);

  return (
    <div className={styles.scene} aria-hidden="true">
      <div className={styles.ground} style={{ backgroundImage: `url("${cfg.poster}")` }}>
        {!reduce && (
          <>
            <video ref={videoARef} className={styles.video} poster={cfg.poster} muted playsInline />
            <video ref={videoBRef} className={styles.video} muted playsInline />
          </>
        )}
      </div>
      <div ref={nightRef} className={styles.night} />
      <div ref={warmRef} className={styles.warm} />
      <canvas ref={canvasRef} className={styles.canvas} />
      {debug && <div ref={hudRef} className={styles.hud} />}
    </div>
  );
}
