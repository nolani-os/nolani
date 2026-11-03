/** Reach of the magnification in px from the pointer; icons beyond stay at 1. */
export const MAGNIFY_REACH = 110;
/** Scale of the icon directly under the pointer. */
export const MAGNIFY_MAX = 1.45;

/**
 * Scale of a dock icon whose centre is `distance` px from the pointer:
 * a cosine bell, 1 at the reach, MAGNIFY_MAX under the pointer. Pure so the
 * curve can be checked without a browser.
 */
export function magnification(distance: number): number {
  const d = Math.min(Math.abs(distance), MAGNIFY_REACH) / MAGNIFY_REACH;
  return 1 + (MAGNIFY_MAX - 1) * (0.5 + 0.5 * Math.cos(Math.PI * d));
}
