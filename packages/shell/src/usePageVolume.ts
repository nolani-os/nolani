import { useEffect } from "react";
import { useDeviceStore } from "@claraos/core";

/**
 * Apply the page volume to all media elements. Lifted out of
 * QuickSettingsPanel, where the MutationObserver only ran while that component
 * was mounted; now it runs shell-wide, on desktop AND mobile.
 *
 * This is the browser level ("browser audio"): independent of the system
 * volume, which only the companion app can set. The value lives in the device
 * store (localStorage key "claraos-volume").
 */
export function usePageVolume(): void {
  const pageVolume = useDeviceStore((s) => s.pageVolume);

  useEffect(() => {
    const apply = () => {
      const els = document.querySelectorAll<HTMLMediaElement>("audio, video");
      els.forEach((el) => { el.volume = pageVolume / 100; });
    };
    apply();
    // Also catch media inserted later
    const obs = new MutationObserver(apply);
    obs.observe(document.body, { subtree: true, childList: true });
    return () => obs.disconnect();
  }, [pageVolume]);
}
