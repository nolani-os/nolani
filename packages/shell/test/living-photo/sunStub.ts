/** Stand-in for src/useSunState.ts: a fixed moment from the URL instead of the clock and the settings. */
import { sunState, type SunState } from "@claraos/skins";

export const LAT = 52.52;
export const LON = 13.405;

export function fixedMoment(): Date {
  const q = new URLSearchParams(location.search);
  const date = q.get("date") ?? "2026-06-21";
  const time = q.get("t") ?? "12:00";
  return new Date(`${date}T${time}:00`);
}

export function useSunState(): SunState {
  return sunState(fixedMoment(), LAT, LON);
}
