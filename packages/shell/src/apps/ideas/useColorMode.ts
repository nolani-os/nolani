/** Light or dark? Derived from the ACTUALLY rendered surface.
 *
 * Why not key it off the skin name: a list like `["windows11-light"]` is
 * correct on the day it is written and never again. Every new light skin is
 * missing from it, and the bug shows up as unreadable text, not as a crash.
 * The luminance of the surface, by contrast, is always right.
 *
 * This is needed because a single status color **mathematically cannot** be
 * readable on both light and dark backgrounds: for 4.5:1 on white the color
 * must be dark, for 4.5:1 on black it must be light. The ranges do not
 * overlap. Measured in light mode: yellow 1.92:1, green 2.28:1, practically
 * unreadable.
 */
import { useEffect, useState, type RefObject } from "react";

/** Relative luminance per WCAG. */
function helligkeit(r: number, g: number, b: number): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function flaeche(el: HTMLElement | null): [number, number, number] | null {
  let n: HTMLElement | null = el;
  // Walk up until a surface is actually opaque: cards are often
  // semi-transparent, and `transparent` says nothing about luminance.
  while (n) {
    const bg = getComputedStyle(n).backgroundColor;
    const m = /rgba?\(([^)]+)\)/.exec(bg);
    if (m) {
      const teile = m[1].split(",").map((s) => parseFloat(s));
      const alpha = teile.length > 3 ? teile[3] : 1;
      if (alpha >= 0.5) return [teile[0], teile[1], teile[2]];
    }
    n = n.parentElement;
  }
  return null;
}

export function useColorMode(ref: RefObject<HTMLElement | null>): "light" | "dark" {
  const [modus, setModus] = useState<"light" | "dark">("dark");

  useEffect(() => {
    const messen = () => {
      const rgb = flaeche(ref.current);
      // Without a measurement, stay on the dark default: that is the state
      // the app runs in most of the time.
      const hell = rgb ? helligkeit(rgb[0], rgb[1], rgb[2]) > 0.4 : false;
      setModus(hell ? "light" : "dark");
    };
    messen();

    // A skin change writes `data-skin-id` to the root element.
    const beob = new MutationObserver(messen);
    beob.observe(document.documentElement, {
      attributes: true, attributeFilter: ["data-skin-id", "style", "class"],
    });
    return () => beob.disconnect();
  }, [ref]);

  return modus;
}
