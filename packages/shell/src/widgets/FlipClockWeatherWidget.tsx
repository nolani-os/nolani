// Mobile homescreen widget: glossy flip clock + realistic weather.
// Big 3D flip cards (HH : MM) with a metal axle, a large glossy Meteocons glyph
// driven by the live condition, current temp with hi/lo, and a 5-day forecast
// strip (Meteocons per day).
//
// Weather from GET /api/claraos/widgets/weather (Bright Sky / DWD). Last good
// payload cached in localStorage → instant paint + offline fallback. The clock
// is pure client time.
import { useEffect, useRef, useState } from "react";
import type { WidgetProps } from "./registry";
import { weatherPhoto } from "./weather-photo";
import s from "./FlipClock.module.css";

interface DailyForecast {
  date: string; // YYYY-MM-DD
  min: number;
  max: number;
  icon: string;
  emoji: string;
  text: string;
}
interface WeatherPayload {
  current: { temperature: number | null; icon: string | null; emoji: string; text: string };
  daily: DailyForecast[];
}

const CACHE_KEY = "claraos.widgets.weather.cache";
const POLL_MS = 15 * 60 * 1000;

function readCache(): WeatherPayload | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { data } = JSON.parse(raw);
    return data ?? null;
  } catch { return null; }
}

/** One flip card. Re-keyed flaps replay the CSS flip once per value change.
 *  Each card carries its own metal hinge bar with end caps (classic flip-clock look). */
function FlipCard({ value }: { value: string }) {
  const prevRef = useRef(value);
  const prev = prevRef.current;
  useEffect(() => { prevRef.current = value; }, [value]);
  const flipping = prev !== value;
  return (
    <div className={s.card}>
      <div className={`${s.half} ${s.top}`}><span>{value}</span></div>
      <div className={`${s.half} ${s.bottom}`}><span>{flipping ? prev : value}</span></div>
      {flipping && (
        <>
          <div key={`t-${value}`} className={`${s.half} ${s.top} ${s.flapTop}`}><span>{prev}</span></div>
          <div key={`b-${value}`} className={`${s.half} ${s.bottom} ${s.flapBottom}`}><span>{value}</span></div>
        </>
      )}
      <div className={s.hinge} />
      <div className={s.cardAxle} />
    </div>
  );
}

export default function FlipClockWeatherWidget(_props: WidgetProps) {
  const [hhmm, setHhmm] = useState(() => {
    const d = new Date();
    return [String(d.getHours()).padStart(2, "0"), String(d.getMinutes()).padStart(2, "0")];
  });
  const [weather, setWeather] = useState<WeatherPayload | null>(readCache);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const tick = () => {
      const d = new Date();
      const next = [String(d.getHours()).padStart(2, "0"), String(d.getMinutes()).padStart(2, "0")];
      setHhmm((cur) => (cur[0] === next[0] && cur[1] === next[1] ? cur : next));
    };
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/claraos/widgets/weather?days=6");
        if (!res.ok) throw new Error(String(res.status));
        const data: WeatherPayload = await res.json();
        if (!alive) return;
        setWeather(data);
        setStale(false);
        try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data })); } catch { /* ignore */ }
      } catch {
        if (alive) setStale(true);
      }
    };
    load();
    const iv = setInterval(load, POLL_MS);
    const onVis = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { alive = false; clearInterval(iv); document.removeEventListener("visibilitychange", onVis); };
  }, []);

  const today = new Date();
  const cur = weather?.current;
  const d0 = weather?.daily?.[0];
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const days = (weather?.daily ?? []).filter((d) => d.date > todayStr).slice(0, 5);

  return (
    <div className={`${s.widget} ${s.vertical}`}>
      {/* big flip clock on a glossy blue base — two cards, no colon (reference design) */}
      <div className={s.clockFrame}>
        <div className={s.clock}>
          <FlipCard value={hhmm[0]} />
          <FlipCard value={hhmm[1]} />
        </div>
        {/* realistic weather graphic overlaps the bottom-centre of the cards */}
        <div className={`${s.wxBig} ${stale && weather ? s.staleNow : ""}`}>
          <img className={s.wxGlyph} src={weatherPhoto(cur?.icon)} alt="" aria-hidden />
        </div>
      </div>
      {/* date left, current temp + hi/lo right */}
      <div className={s.metaRow}>
        <div className={s.dateBlock}>
          <div className={s.dateWd}>{today.toLocaleDateString("de-DE", { weekday: "short" }).replace(/\.$/, "")}.</div>
          <div className={s.dateMd}>{today.toLocaleDateString("de-DE", { month: "long" })} {today.getDate()}</div>
        </div>
        <div className={`${s.now} ${stale && weather ? s.staleNow : ""}`}>
          <div className={s.nowTemp}>{cur?.temperature != null ? `${Math.round(cur.temperature)}°` : "—°"}</div>
          {d0 && <div className={s.hiLo}>▲{Math.round(d0.max)}° ▽{Math.round(d0.min)}°</div>}
        </div>
      </div>
      {/* 5-day forecast */}
      <div className={s.forecast}>
        {days.length ? days.map((d) => (
          <div key={d.date} className={s.day}>
            <div className={s.dayName}>
              {new Date(`${d.date}T12:00:00`).toLocaleDateString("de-DE", { weekday: "short" }).replace(".", "")}
            </div>
            <div className={s.dayIcon}><img src={weatherPhoto(d.icon)} alt="" aria-hidden /></div>
            <div className={s.dayTemp}>{Math.round(d.max)}° <span>{Math.round(d.min)}°</span></div>
          </div>
        )) : (
          <div className={s.noData}>{stale ? "Wetter offline" : "Wetter lädt…"}</div>
        )}
      </div>
    </div>
  );
}
