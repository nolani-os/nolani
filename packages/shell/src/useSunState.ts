/**
 * Sun and moon for the animated skins, recomputed once a minute.
 *
 * The location comes from the settings module "appearance" (latitude /
 * longitude, defaulting to the installation's location); the model itself
 * lives in @claraos/skins so it has no React dependency and can be unit
 * tested. Scenes read `altitude`, `azimuth`, `phase` and `moonPhase` — the
 * light/dark automation may later use the same hook instead of fixed hours.
 */
import { useEffect, useState } from "react";
import { useSettingsStore } from "@claraos/core";
import { sunState, type SunState } from "@claraos/skins";

const FALLBACK = { latitude: 51.16, longitude: 10.45 }; // centre of Germany, like the weather widget

/** Optional override, e.g. for a time-lapse preview in the settings. */
export function useSunState(at?: Date): SunState {
  const lat = useSettingsStore((s) => s.values["appearance"]?.latitude);
  const lon = useSettingsStore((s) => s.values["appearance"]?.longitude);
  const latitude = typeof lat === "number" ? lat : FALLBACK.latitude;
  const longitude = typeof lon === "number" ? lon : FALLBACK.longitude;

  const [now, setNow] = useState(() => at ?? new Date());
  useEffect(() => {
    if (at) {
      setNow(at);
      return;
    }
    // Tick on the full minute; while the tab is hidden nothing is drawn anyway.
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const d = new Date();
      timer = setTimeout(() => {
        setNow(new Date());
        schedule();
      }, 60_000 - (d.getSeconds() * 1000 + d.getMilliseconds()) + 50);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [at]);

  return sunState(now, latitude, longitude);
}
