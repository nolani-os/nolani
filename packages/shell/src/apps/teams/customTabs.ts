import { getMatrixClient } from "./matrixClient";

// Custom channel tabs (MS Teams "+" tab): stored per room as Matrix room
// account data — synced across devices, without a backend extension.

const CUSTOM_TABS_EVENT = "io.claraos.teams.custom_tabs";

export interface CustomTab {
  name: string;
  /** Web address (the original and still valid case). */
  url?: string;
  /** ClaraOS app instead of a web address. Exactly one of the two is set. */
  appId?: string;
}

export function getCustomTabs(roomId: string): CustomTab[] {
  const client = getMatrixClient();
  const room = client?.getRoom(roomId);
  if (!room) return [];
  const content = room.getAccountData(CUSTOM_TABS_EVENT)?.getContent();
  const tabs = content?.tabs;
  if (!Array.isArray(tabs)) return [];
  // Two kinds. Older entries only have `url` — that check stays unchanged,
  // otherwise existing tabs would silently disappear.
  return tabs.filter(
    (t: any) =>
      t && typeof t.name === "string" &&
      ((typeof t.url === "string" &&
        (t.url.startsWith("https://") || t.url.startsWith("http://"))) ||
       (typeof t.appId === "string" && t.appId.length > 0)),
  );
}

// Warning: both return the NEW list, and callers use exactly that. Re-reading
// with `getCustomTabs()` after writing returns the OLD list: `setRoomAccountData`
// goes through the server, and the local echo from sync has not arrived yet.
// Visible effect: a freshly created tab did not appear. Whoever writes already
// knows the result — asking the server again is not just redundant but wrong.
export async function addCustomTab(roomId: string, tab: CustomTab): Promise<CustomTab[]> {
  const client = getMatrixClient();
  if (!client) return getCustomTabs(roomId);
  const tabs = [...getCustomTabs(roomId), tab];
  await client.setRoomAccountData(roomId, CUSTOM_TABS_EVENT, { tabs });
  return tabs;
}

export async function removeCustomTab(roomId: string, name: string): Promise<CustomTab[]> {
  const client = getMatrixClient();
  if (!client) return getCustomTabs(roomId);
  const tabs = getCustomTabs(roomId).filter((t) => t.name !== name);
  await client.setRoomAccountData(roomId, CUSTOM_TABS_EVENT, { tabs });
  return tabs;
}
