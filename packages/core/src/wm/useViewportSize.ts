import { useEffect, useState } from "react";

/**
 * Size of the visible area — as a **subscription**, not a snapshot.
 *
 * Why this exists: a full-screen window in `Window.tsx` sized itself with
 *    `window.innerWidth/innerHeight` directly in the render body. Without a
 *    subscription that size stays fixed when the screen changes — when the
 *    phone was rotated, the window kept its old pixel size (e.g. 412x915 on a
 *    screen that is now 915x412) and no longer filled the screen. To the user
 *    it looked as if the game had left full-screen mode; in reality only the
 *    number was frozen.
 *
 * Important: **whoever reads a size in the render body reads it exactly
 *    once.** Correct is either a subscription (this hook) or a computation at
 *    event time.
 *
 * Important: listen to `orientationchange` in addition to `resize`, and measure
 *    again with a delay afterwards: Android browsers sometimes report the new
 *    size only AFTER the rotation event. A single read in the event still
 *    returns the old values there.
 */
export interface ViewportSize {
  width: number;
  height: number;
}

function lies(): ViewportSize {
  return { width: window.innerWidth, height: window.innerHeight };
}

export function useViewportSize(): ViewportSize {
  const [size, setSize] = useState<ViewportSize>(lies);

  useEffect(() => {
    let nachschlag: number | undefined;

    const aktualisiere = () => {
      setSize((alt) => {
        const neu = lies();
        // Only re-render on a real change — otherwise every scroll event that
        // shows or hides the address bar would re-render too.
        return alt.width === neu.width && alt.height === neu.height ? alt : neu;
      });
    };

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

  return size;
}
