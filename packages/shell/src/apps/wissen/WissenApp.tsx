/** "Wissen" (Knowledge) as the shell launches it: the core plus the Strategy
 * section, with all functions of the installation (default context).
 *
 * Kept under this name so the registry, `StrategieEntry` and old imports stay
 * unchanged. The standalone app uses `WissenKern` directly.
 */
import WissenKern from "./WissenKern";
import { strategieSektion } from "./strategie";
import type { Bereich } from "./erweiterung";

export type { Bereich } from "./erweiterung";

export default function WissenApp({ windowId, start = "wissen" }: {
  windowId: string;
  start?: Bereich;
}) {
  return <WissenKern windowId={windowId} start={start} strategie={strategieSektion} />;
}
