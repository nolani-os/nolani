/** "Strategy" entry point — the same app, just with a different start section.
 *
 * Why a separate file and not a parameter in the registry entry: the registry
 * holds *components*, not bound calls. Two lean entry points are more honest
 * than lookup acrobatics via the window ID — and they keep the old ID `ideas`
 * alive, which deep links, ntfy notifications and Clara answers depend on.
 */
import WissenApp from "./WissenApp";

export default function StrategieEntry({ windowId }: { windowId: string }) {
  return <WissenApp windowId={windowId} start="strategie" />;
}
