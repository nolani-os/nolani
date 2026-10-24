import { useEffect, useState } from "react";
import type { WidgetProps } from "./registry";
import { weatherPhoto } from "./weather-photo";
import styles from "./Widgets.module.css";
import { regionLocale, useTranslation } from "@claraos/core";

interface WeatherData {
  temperature: number | null;
  description: string | null;
  icon: string | null; // Bright-Sky condition icon → weatherPhoto()
  hi: number | null;
  lo: number | null;
}

const EMPTY: WeatherData = { temperature: null, description: null, icon: null, hi: null, lo: null };

export default function ClockWeatherWidget(_: WidgetProps) {
  const { t } = useTranslation("desktop");
  const [now, setNow] = useState(new Date());
  const [weather, setWeather] = useState<WeatherData>(EMPTY);

  // Tick the clock every 15s — fast enough for the minute, lazy enough on CPU
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(t);
  }, []);

  // Optimistic weather fetch — falls back gracefully when the endpoint is missing
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch("/api/claraos/widgets/weather?days=1");
        if (!r.ok) return;
        const data = await r.json();
        if (cancelled) return;
        const cur = data.current ?? {};
        const today = Array.isArray(data.daily) ? data.daily[0] : null;
        setWeather({
          temperature: typeof cur.temperature === "number" ? cur.temperature : null,
          description: cur.text ?? null,
          icon: cur.icon ?? null,
          hi: typeof today?.max === "number" ? today.max : null,
          lo: typeof today?.min === "number" ? today.min : null,
        });
      } catch {
        /* keep placeholder */
      }
    };
    load();
    const t = setInterval(load, 15 * 60_000); // every 15 min
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const time = now.toLocaleTimeString(regionLocale(), { hour: "2-digit", minute: "2-digit" });
  const date = now.toLocaleDateString(regionLocale(), {
    weekday: "long",
    day: "2-digit",
    month: "long",
  });

  return (
    <div className={styles.cw} title="Wetterdaten: Deutscher Wetterdienst (DWD)">
      <div className={styles.cwTime}>{time}</div>
      <div className={styles.cwDate}>{date}</div>
      <div className={styles.cwWeather}>
        <img className={styles.cwGlyph} src={weatherPhoto(weather.icon)} alt="" aria-hidden />
        <span className={styles.cwTemp}>
          {weather.temperature !== null ? `${Math.round(weather.temperature)}°` : "—°"}
        </span>
        <span className={styles.cwDesc}>
          {weather.description ?? t("widgets.weather.loading")}
          {weather.hi !== null && weather.lo !== null && (
            <span className={styles.cwHiLo}>
              {" "}▲{Math.round(weather.hi)}° ▽{Math.round(weather.lo)}°
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
