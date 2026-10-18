import { useEffect, useState } from "react";

const MOBILE_BREAKPOINT = 768;

/**
 * Important: the decision is based on the SHORT side, not the width —
 *    but only on devices with a coarse pointer (finger).
 *
 *    Why: a phone is 412 px wide in portrait (mobile) and 915 px in landscape
 *    (previously: desktop). Rotating therefore switched the WHOLE interface —
 *    the full-screen mobile view turned into a window with title bar and
 *    taskbar. To the user it looked as if the app left fullscreen mode.
 *    The short side stays the same when rotating (412), so the device stays
 *    mobile in both orientations.
 *
 * On desktop the width still decides: whoever drags a narrow window there
 *    should still get the mobile view; its height must not prevent that.
 */
function istMobil(): boolean {
  const grobZeiger =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches;
  return grobZeiger
    ? Math.min(window.innerWidth, window.innerHeight) < MOBILE_BREAKPOINT
    : window.innerWidth < MOBILE_BREAKPOINT;
}

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(istMobil);

  useEffect(() => {
    // Do not rely on a single media query any more: the decision now depends
    //    on BOTH edge lengths, so re-evaluate on every resize and after every
    //    rotation.
    const aktualisiere = () => setIsMobile(istMobil());
    let nachschlag: number | undefined;
    const beiDrehung = () => {
      aktualisiere();
      window.clearTimeout(nachschlag);
      nachschlag = window.setTimeout(aktualisiere, 250);
    };
    window.addEventListener("resize", aktualisiere);
    window.addEventListener("orientationchange", beiDrehung);
    return () => {
      window.clearTimeout(nachschlag);
      window.removeEventListener("resize", aktualisiere);
      window.removeEventListener("orientationchange", beiDrehung);
    };
  }, []);

  return isMobile;
}
