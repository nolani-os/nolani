// Desktop widget: photo frame v3 — Immich slideshow.
// The source is the logged-in user's Immich albums (or random picks from all
// photos); all access goes through the claraos-api proxies
// (/widgets/immich/*, per-user API key server-side). Display options
// (fit, Ken Burns, transition, caption, clock) live in widget.config.
// Without a connected Immich account the frame shows the API's 409 hint.
import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspaceStore } from "@claraos/core";
import type { WidgetProps } from "./registry";
import {
  CheckList,
  CheckRow,
  GroupLabel,
  SelectRow,
  SettingsOverlay,
  useWidgetSettingsOpen,
} from "./settingsControls";
import s from "./PhotoFrame.module.css";

interface Photo {
  id: string;
  date: string;
  album: string;
}

interface Album {
  id: string;
  name: string;
  count: number;
}

interface FrameConfig {
  albumIds: string[];
  random: boolean;
  intervalSec: number;
  fit: "cover" | "contain";
  kenBurns: boolean;
  fadeMs: number;
  showCaption: boolean;
  showClock: boolean;
}

function readConfig(config?: Record<string, unknown>): FrameConfig {
  return {
    albumIds: Array.isArray(config?.albumIds) ? (config.albumIds as string[]) : [],
    random: config?.random === true,
    intervalSec:
      typeof config?.intervalSec === "number" && config.intervalSec >= 5
        ? config.intervalSec
        : 45,
    fit: config?.fit === "contain" ? "contain" : "cover",
    kenBurns: config?.kenBurns !== false,
    fadeMs:
      typeof config?.fadeMs === "number" && config.fadeMs >= 100
        ? config.fadeMs
        : 900,
    showCaption: config?.showCaption !== false,
    showClock: config?.showClock === true,
  };
}

const thumbUrl = (id: string) =>
  `/api/claraos/widgets/immich/thumb?id=${encodeURIComponent(id)}&size=preview`;

export default function PhotoFrameWidget({ widgetId, config }: WidgetProps) {
  const updateWidgetConfig = useWorkspaceStore((st) => st.updateWidgetConfig);
  const cfg = readConfig(config);
  // Source chosen? Old v2 configs (only `folder`) count as unconfigured.
  const configured = cfg.albumIds.length > 0 || cfg.random;

  const [photos, setPhotos] = useState<Photo[] | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [idx, setIdx] = useState(0);
  const [layers, setLayers] = useState<{ photo: Photo; src: string; key: number }[]>([]);
  const layerKey = useRef(0);
  const [clock, setClock] = useState(() => new Date());

  const [settingsOpen, setSettingsOpen] = useWidgetSettingsOpen(widgetId);
  const [albums, setAlbums] = useState<Album[] | null>(null);
  const [draft, setDraft] = useState<FrameConfig>(cfg);

  // ── Load photo list ────────────────────────────────────────────────────
  const load = useCallback(async () => {
    if (!configured) return;
    try {
      const q = cfg.random ? "" : `?albums=${encodeURIComponent(cfg.albumIds.join(","))}`;
      const r = await fetch(`/api/claraos/widgets/immich/photos${q}`);
      if (r.status === 409) {
        const d = await r.json().catch(() => ({}));
        setPhotos([]);
        setHint(d.detail ?? "Immich nicht verbunden");
        return;
      }
      if (!r.ok) throw new Error(String(r.status));
      const data = await r.json();
      setPhotos(Array.isArray(data.photos) ? data.photos : []);
      setHint(null);
      setIdx(0);
    } catch {
      setPhotos((prev) => prev ?? []);
      setHint("Immich nicht erreichbar");
    }
    // cfg parts individually, so a settings save with the same source does not reload
  }, [configured, cfg.random, cfg.albumIds.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load();
  }, [load]);

  // Random source: refresh the list regularly, otherwise the same 150 keep rotating
  useEffect(() => {
    if (!configured || !cfg.random) return;
    const t = setInterval(load, 30 * 60_000);
    return () => clearInterval(t);
  }, [configured, cfg.random, load]);

  // ── Fade in the current photo as a layer (preload → crossfade) ─────────
  useEffect(() => {
    const photo = photos?.[idx];
    if (!photo) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      layerKey.current += 1;
      setLayers((prev) => [...prev.slice(-1), { photo, src: img.src, key: layerKey.current }]);
    };
    img.src = thumbUrl(photo.id);
    return () => {
      cancelled = true;
    };
  }, [photos, idx]);

  // slideshow timer
  useEffect(() => {
    if (!photos || photos.length < 2) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % photos.length), cfg.intervalSec * 1000);
    return () => clearInterval(t);
  }, [photos, cfg.intervalSec]);

  // clock overlay
  useEffect(() => {
    if (!cfg.showClock) return;
    const t = setInterval(() => setClock(new Date()), 15_000);
    return () => clearInterval(t);
  }, [cfg.showClock]);

  // ── Settings ────────────────────────────────────────────────────────────
  const openSettings = settingsOpen || !configured;

  useEffect(() => {
    if (!openSettings || albums !== null) return;
    fetch("/api/claraos/widgets/immich/albums")
      .then(async (r) => {
        if (r.status === 409) {
          const d = await r.json().catch(() => ({}));
          setHint(d.detail ?? "Immich nicht verbunden");
          return { albums: [] };
        }
        return r.ok ? r.json() : { albums: [] };
      })
      .then((d) => setAlbums(Array.isArray(d.albums) ? d.albums : []))
      .catch(() => setAlbums([]));
  }, [openSettings, albums]);

  useEffect(() => {
    if (openSettings) setDraft(readConfig(config));
    // initialise once from the saved config when opening
  }, [openSettings]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveSettings = useCallback(() => {
    updateWidgetConfig(widgetId, { ...draft });
    setSettingsOpen(false);
    setPhotos(null); // reload with the new source
  }, [widgetId, draft, updateWidgetConfig, setSettingsOpen]);

  const next = useCallback(() => {
    if (photos && photos.length > 1) setIdx((i) => (i + 1) % photos.length);
  }, [photos]);

  const current = layers[layers.length - 1]?.photo;
  const empty = photos !== null && photos.length === 0;

  return (
    <div className={s.frame} onClick={next}>
      {layers.map((l, i) => (
        <img
          key={l.key}
          className={`${s.photo} ${cfg.kenBurns ? s.kenburns : ""} ${i === layers.length - 1 ? s.photoTop : ""}`}
          style={{
            objectFit: cfg.fit,
            animationDuration: i === layers.length - 1 ? `${cfg.fadeMs}ms, 60s` : undefined,
          }}
          src={l.src}
          alt=""
          draggable={false}
        />
      ))}

      {configured && photos === null && !hint && <div className={s.hint}>Fotos laden…</div>}
      {hint && empty && <div className={s.hint}>{hint}</div>}
      {!hint && empty && configured && <div className={s.hint}>Keine Fotos in der Auswahl</div>}

      {cfg.showCaption && current && !openSettings && (
        <div className={s.caption}>
          {[current.album, current.date].filter(Boolean).join(" · ")}
        </div>
      )}
      {cfg.showClock && !openSettings && (
        <div className={s.clock}>
          {clock.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}
        </div>
      )}

      {openSettings && (
        <SettingsOverlay
          title="Fotorahmen"
          onCancel={() => setSettingsOpen(false)}
          onSave={saveSettings}
        >
          <GroupLabel>Quelle (Immich)</GroupLabel>
          <CheckRow
            label="Zufällig aus allen Fotos"
            checked={draft.random}
            onChange={(v) => setDraft((d) => ({ ...d, random: v }))}
          />
          <CheckList>
            {albums === null && <span className={s.hintInline}>Alben laden…</span>}
            {albums?.length === 0 && <span className={s.hintInline}>Keine Alben gefunden</span>}
            {albums?.map((a) => (
              <CheckRow
                key={a.id}
                label={`${a.name} (${a.count})`}
                disabled={draft.random}
                checked={draft.albumIds.includes(a.id)}
                onChange={(v) =>
                  setDraft((d) => ({
                    ...d,
                    albumIds: v
                      ? [...d.albumIds, a.id]
                      : d.albumIds.filter((x) => x !== a.id),
                  }))
                }
              />
            ))}
          </CheckList>

          <GroupLabel>Anzeige</GroupLabel>
          <SelectRow
            label="Wechsel alle"
            value={String(draft.intervalSec)}
            onChange={(v) => setDraft((d) => ({ ...d, intervalSec: parseInt(v, 10) }))}
            options={[
              { value: "15", label: "15 Sekunden" },
              { value: "45", label: "45 Sekunden" },
              { value: "120", label: "2 Minuten" },
              { value: "600", label: "10 Minuten" },
            ]}
          />
          <SelectRow
            label="Einpassen"
            value={draft.fit}
            onChange={(v) => setDraft((d) => ({ ...d, fit: v as "cover" | "contain" }))}
            options={[
              { value: "cover", label: "Füllen (Zuschnitt)" },
              { value: "contain", label: "Ganzes Bild" },
            ]}
          />
          <SelectRow
            label="Übergang"
            value={String(draft.fadeMs)}
            onChange={(v) => setDraft((d) => ({ ...d, fadeMs: parseInt(v, 10) }))}
            options={[
              { value: "300", label: "Schnell" },
              { value: "900", label: "Normal" },
              { value: "2000", label: "Langsam" },
            ]}
          />
          <CheckRow
            label="Ken-Burns-Effekt (langsamer Zoom)"
            checked={draft.kenBurns}
            onChange={(v) => setDraft((d) => ({ ...d, kenBurns: v }))}
          />
          <CheckRow
            label="Beschriftung (Album · Datum)"
            checked={draft.showCaption}
            onChange={(v) => setDraft((d) => ({ ...d, showCaption: v }))}
          />
          <CheckRow
            label="Uhrzeit einblenden"
            checked={draft.showClock}
            onChange={(v) => setDraft((d) => ({ ...d, showClock: v }))}
          />
        </SettingsOverlay>
      )}
    </div>
  );
}
