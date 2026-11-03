/**
 * Sun and moon position without any dependency.
 *
 * Solar altitude/azimuth follow the NOAA solar calculator (Meeus-style
 * approximations: mean anomaly, equation of center, obliquity, equation of
 * time, hour angle). Accuracy is within about 0.5° for the years 1900–2100,
 * which is plenty for a sky that changes colour with the time of day.
 *
 * The moon phase is derived from the mean synodic month; it is used for the
 * shape of the crescent, not for astronomy.
 */

export interface SunPosition {
  /** Degrees above the horizon (negative below). */
  altitude: number;
  /** Degrees clockwise from north (0 = north, 90 = east, 180 = south). */
  azimuth: number;
}

export type DayPhase = "night" | "dawn" | "day" | "dusk";

export interface SunState extends SunPosition {
  phase: DayPhase;
  /** 0 = new moon, 0.5 = full moon, 1 = new moon again. */
  moonPhase: number;
  /** Civil twilight boundaries of the same day, local time, or null for polar day/night. */
  sunrise: Date | null;
  sunset: Date | null;
}

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** Julian day of a Date (UTC). */
export function julianDay(date: Date): number {
  return date.getTime() / 86_400_000 + 2_440_587.5;
}

function julianCentury(jd: number): number {
  return (jd - 2_451_545) / 36_525;
}

/** Solar declination (degrees) and equation of time (minutes) for a Julian century. */
function solarBasics(t: number): { declination: number; eqTime: number } {
  const L0 = (280.46646 + t * (36_000.76983 + t * 0.0003032)) % 360;
  const M = 357.52911 + t * (35_999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const Mr = M * RAD;
  const C =
    Math.sin(Mr) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * Mr) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * Mr) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * t;
  const apparentLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const obliq0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliq = obliq0 + 0.00256 * Math.cos(omega * RAD);
  const declination = Math.asin(Math.sin(obliq * RAD) * Math.sin(apparentLong * RAD)) * DEG;
  const y = Math.tan((obliq / 2) * RAD) ** 2;
  const L0r = L0 * RAD;
  const eqTime =
    4 *
    DEG *
    (y * Math.sin(2 * L0r) -
      2 * e * Math.sin(Mr) +
      4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r) -
      0.5 * y * y * Math.sin(4 * L0r) -
      1.25 * e * e * Math.sin(2 * Mr));
  return { declination, eqTime };
}

/** Sun position for a moment at a geographic location. */
export function sunPosition(date: Date, latitude: number, longitude: number): SunPosition {
  const jd = julianDay(date);
  const t = julianCentury(jd);
  const { declination, eqTime } = solarBasics(t);
  const minutesUtc =
    date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const trueSolarMinutes = (minutesUtc + eqTime + 4 * longitude + 1440) % 1440;
  let hourAngle = trueSolarMinutes / 4 - 180;
  if (hourAngle < -180) hourAngle += 360;
  const lat = latitude * RAD;
  const dec = declination * RAD;
  const ha = hourAngle * RAD;
  const cosZenith = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha);
  const zenith = Math.acos(Math.min(1, Math.max(-1, cosZenith)));
  const altitude = 90 - zenith * DEG;
  let azimuth: number;
  const denom = Math.cos(lat) * Math.sin(zenith);
  if (Math.abs(denom) < 1e-9) {
    azimuth = 180;
  } else {
    const cosAz = (Math.sin(lat) * Math.cos(zenith) - Math.sin(dec)) / denom;
    azimuth = Math.acos(Math.min(1, Math.max(-1, cosAz))) * DEG;
    azimuth = hourAngle > 0 ? (azimuth + 180) % 360 : (540 - azimuth) % 360;
  }
  return { altitude, azimuth };
}

/**
 * Sunrise/sunset of the civil day that contains `date` (local time of the
 * JavaScript runtime). `altitudeDeg` is the sun altitude that counts as
 * "rise": -0.833° for the visible disc, -6° for civil twilight.
 * Returns null when the sun never crosses that altitude (polar day/night).
 */
export function sunTimes(
  date: Date,
  latitude: number,
  longitude: number,
  altitudeDeg = -0.833,
): { rise: Date | null; set: Date | null } {
  const noonLocal = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0, 0);
  const t = julianCentury(julianDay(noonLocal));
  const { declination, eqTime } = solarBasics(t);
  const lat = latitude * RAD;
  const dec = declination * RAD;
  const cosHa =
    (Math.cos((90 - altitudeDeg) * RAD) - Math.sin(lat) * Math.sin(dec)) /
    (Math.cos(lat) * Math.cos(dec));
  if (cosHa < -1 || cosHa > 1) return { rise: null, set: null };
  const ha = Math.acos(cosHa) * DEG;
  // Minutes after 00:00 UTC
  const solarNoonUtc = 720 - 4 * longitude - eqTime;
  const midnightUtc = Date.UTC(noonLocal.getUTCFullYear(), noonLocal.getUTCMonth(), noonLocal.getUTCDate());
  const toDate = (minutes: number) => new Date(midnightUtc + minutes * 60_000);
  return { rise: toDate(solarNoonUtc - 4 * ha), set: toDate(solarNoonUtc + 4 * ha) };
}

/** Mean moon phase 0..1 (0 = new, 0.5 = full), from the synodic month. */
export function moonPhase(date: Date): number {
  const SYNODIC = 29.530588853;
  // Reference new moon: 2000-01-06 18:14 UTC
  const ref = Date.UTC(2000, 0, 6, 18, 14);
  const days = (date.getTime() - ref) / 86_400_000;
  const phase = (days / SYNODIC) % 1;
  return phase < 0 ? phase + 1 : phase;
}

/** Day phase from the solar altitude: civil twilight is the band -6°…0°. */
export function dayPhase(altitude: number, azimuth: number): DayPhase {
  if (altitude >= 0) return "day";
  if (altitude < -6) return "night";
  // Twilight: before noon (sun in the east) it is dawn, afterwards dusk.
  return azimuth < 180 ? "dawn" : "dusk";
}

/** Everything a scene needs for one moment. */
export function sunState(date: Date, latitude: number, longitude: number): SunState {
  const pos = sunPosition(date, latitude, longitude);
  const times = sunTimes(date, latitude, longitude);
  return {
    ...pos,
    phase: dayPhase(pos.altitude, pos.azimuth),
    moonPhase: moonPhase(date),
    sunrise: times.rise,
    sunset: times.set,
  };
}
