import { useEffect, useState } from "react";
import { useMatrixStore } from "@claraos/core";

// Team Nextcloud resources (files/calendar/Deck/wiki) — shared fetch+lookup
// for the desktop ChannelView and MobileLayout (was previously duplicated in both).

export interface TeamResource {
  slug: string;
  name: string;
  matrix_space_id: string | null;
  matrix_main_room_id: string | null;
  files_url: string | null;
  calendar_url: string | null;
  deck_url: string | null;
  collective_url: string | null;
}

const RESOURCE_CACHE: { data: Record<string, TeamResource> | null; loadedAt: number } = {
  data: null,
  loadedAt: 0,
};

export async function fetchTeamResources(): Promise<Record<string, TeamResource>> {
  const now = Date.now();
  if (RESOURCE_CACHE.data && now - RESOURCE_CACHE.loadedAt < 30000) return RESOURCE_CACHE.data;
  try {
    const r = await fetch("/api/claraos/v1/admin/teams/me/resources", { credentials: "include" });
    if (!r.ok) return {};
    const list: TeamResource[] = await r.json();
    const map: Record<string, TeamResource> = {};
    for (const t of list) if (t.matrix_space_id) map[t.matrix_space_id] = t;
    RESOURCE_CACHE.data = map;
    RESOURCE_CACHE.loadedAt = now;
    return map;
  } catch {
    return {};
  }
}

/** Team resource for a room. Fallback ladder: (a) parentSpaceId directly,
 * (b) the room is the main_room/space itself, (c) the room is a child of a known
 * space — (c) catches the race in which buildSpaces ran before the room upsert
 * and parentSpaceId therefore stayed empty. */
export function resolveTeamResource(
  roomId: string,
  resources: Record<string, TeamResource>,
  parentSpaceId: string | undefined,
  spaceMap: Record<string, { childRoomIds: string[] }>,
): TeamResource | null {
  if (parentSpaceId && resources[parentSpaceId]) return resources[parentSpaceId];
  for (const t of Object.values(resources)) {
    if (t.matrix_main_room_id === roomId || t.matrix_space_id === roomId) return t;
    if (t.matrix_space_id && spaceMap[t.matrix_space_id]?.childRoomIds.includes(roomId)) return t;
  }
  return null;
}

/** React hook: team resource for the room (loads and caches automatically). */
export function useTeamResource(roomId: string): TeamResource | null {
  const room = useMatrixStore((s) => s.rooms[roomId]);
  const spaceMap = useMatrixStore((s) => s.spaces);
  const [resources, setResources] = useState<Record<string, TeamResource>>({});
  useEffect(() => {
    fetchTeamResources().then(setResources);
  }, []);
  return resolveTeamResource(roomId, resources, room?.parentSpaceId, spaceMap);
}

/** The team's folder path from `files_url` (`…/apps/files/?dir=/Team`).
 * The Teams app shows files natively — it needs the path, not the Nextcloud
 * link. Stays `null` if the team has no group folder; then the tab does not
 * exist at all. */
export function teamOrdnerPfad(files_url: string | null): string | null {
  if (!files_url) return null;
  try {
    const dir = new URL(files_url, window.location.origin).searchParams.get("dir");
    return dir && dir.startsWith("/") ? dir : null;
  } catch {
    return null;
  }
}
