import * as sdk from "matrix-js-sdk";
import { useMatrixStore, appUrl, getBrand } from "@claraos/core";
import type { MatrixRoom, MatrixMessage, MatrixSpace } from "@claraos/core";

let client: sdk.MatrixClient | null = null;

export function getMatrixClient(): sdk.MatrixClient | null {
  return client;
}

function roomHasActiveCallWidget(room: sdk.Room): boolean {
  const widgets = room.currentState.getStateEvents("im.vector.modular.widgets");
  return widgets.some((e) => {
    const c = e.getContent();
    return c?.type === "m.call" && typeof c?.url === "string" && c.url.length > 0;
  });
}

// MatrixRTC membership state — Element Call writes one event per participant.
// Event type differs across EC versions; check all known names.
const CALL_MEMBER_EVENT_TYPES = [
  "org.matrix.msc3401.call.member",
  "m.call.member",
];

// A call widget alone is NOT proof of a live call: the widget state event
// survives after everyone hung up (nobody redacts it reliably), which used to
// leave rooms showing "Live" forever. A call only counts as active while at
// least one participant has an unexpired RTC membership.
function roomHasActiveCall(room: sdk.Room): boolean {
  if (!roomHasActiveCallWidget(room)) return false;
  const now = Date.now();

  const membershipUnexpired = (m: any, eventTs: number): boolean => {
    if (!m || typeof m !== "object") return false;
    if (typeof m.expires_ts === "number") return m.expires_ts > now;
    if (typeof m.expires === "number") {
      const base = typeof m.created_ts === "number" ? m.created_ts : eventTs;
      return base + m.expires > now;
    }
    // No expiry info — trust it only if the event itself is recent (<4h),
    // so stale sessions from crashed clients still age out.
    return now - eventTs < 4 * 3600_000;
  };

  for (const type of CALL_MEMBER_EVENT_TYPES) {
    for (const ev of room.currentState.getStateEvents(type)) {
      const c = ev.getContent();
      const ts = ev.getTs();
      const memberships = Array.isArray(c?.memberships)
        ? c.memberships
        : Array.isArray(c?.["m.calls"])
          ? c["m.calls"].flatMap((call: any) => call?.["m.devices"] ?? [])
          : [];
      if (memberships.some((m: any) => membershipUnexpired(m, ts))) return true;
    }
  }
  return false;
}

function roomToStore(room: sdk.Room): MatrixRoom {
  const enc = room.hasEncryptionStateEvent();
  const lastEvent = room.timeline[room.timeline.length - 1];
  const members = room.getJoinedMembers().map((m) => m.userId);
  const isSpace = room.isSpaceRoom();
  const isDirect = room.getDMInviter() != null ||
    Object.keys(room.client.getAccountData(sdk.EventType.Direct)?.getContent() ?? {}).some(
      (uid) => (room.client.getAccountData(sdk.EventType.Direct)!.getContent()[uid] ?? []).includes(room.roomId)
    );

  return {
    roomId: room.roomId,
    name: room.name,
    topic: room.currentState.getStateEvents("m.room.topic", "")?.getContent()?.topic,
    avatarUrl: room.getAvatarUrl(room.client.baseUrl, 48, 48, "crop") ?? undefined,
    isSpace,
    isEncrypted: enc,
    isDirect,
    parentSpaceId: undefined,
    membership: room.getMyMembership() as "join" | "invite" | "leave",
    unreadCount: room.getUnreadNotificationCount("total") ?? 0,
    lastMessage: lastEvent
      ? { sender: lastEvent.getSender()!, body: lastEvent.getContent()?.body ?? "", ts: lastEvent.getTs() }
      : undefined,
    members,
    activeCall: roomHasActiveCall(room),
    pinnedEventIds:
      room.currentState.getStateEvents("m.room.pinned_events", "")?.getContent()?.pinned ?? [],
  };
}

function eventToMessage(event: sdk.MatrixEvent): MatrixMessage {
  const content = event.getContent();
  const newContent = content["m.new_content"];
  const body = newContent?.body ?? content.body ?? "";
  const formattedBody = newContent?.formatted_body ?? content.formatted_body;
  return {
    eventId: event.getId()!,
    roomId: event.getRoomId()!,
    sender: event.getSender()!,
    senderName: event.sender?.name ?? event.getSender()!,
    type: event.getType(),
    body,
    formattedBody,
    ts: event.getTs(),
    threadRootId: event.threadRootId ?? undefined,
    threadReplyCount: event.getUnsigned()?.["m.relations"]?.["m.thread"]?.count,
    isEdited: !!newContent,
    replyTo: content["m.relates_to"]?.["m.in_reply_to"]?.event_id,
    redacted: event.isRedacted(),
    reactions: {},
    fileUrl: content.url,
    fileName: content.msgtype === "m.file" || content.msgtype === "m.image" ? content.body : undefined,
    fileMimeType: content.info?.mimetype,
    fileSize: content.info?.size,
    thumbnailUrl: content.info?.thumbnail_url,
  };
}

function buildSpaces(matrixClient: sdk.MatrixClient): Record<string, MatrixSpace> {
  const spaces: Record<string, MatrixSpace> = {};
  const store = useMatrixStore.getState();

  for (const room of matrixClient.getRooms()) {
    if (!room.isSpaceRoom()) continue;
    const childEvents = room.currentState.getStateEvents("m.space.child");
    const childRoomIds = childEvents
      .map((e) => e.getStateKey()!)
      .filter((id) => {
        const child = matrixClient.getRoom(id);
        return child && child.getMyMembership() === "join";
      });

    spaces[room.roomId] = {
      spaceId: room.roomId,
      name: room.name,
      avatarUrl: room.getAvatarUrl(matrixClient.baseUrl, 48, 48, "crop") ?? undefined,
      childRoomIds,
    };

    for (const childId of childRoomIds) {
      const existing = store.rooms[childId];
      if (existing) {
        useMatrixStore.getState().upsertRoom({ ...existing, parentSpaceId: room.roomId });
      }
    }
  }
  return spaces;
}

let cryptoEnabled = false;
export function isCryptoEnabled(): boolean {
  return cryptoEnabled;
}

const SESSION_KEY = (userId: string) => `claraos-teams-session:${userId}`;

// Admin-minted tokens have no device → no E2EE is possible with them
// (device keys need a real device). MSC3882 (Synapse:
// login_via_existing_session, must be enabled) upgrades the minted token
// client-side to a device-bound session, which we persist per browser in
// localStorage (otherwise every reload would create a new Matrix device).
async function upgradeToDeviceSession(
  homeserverUrl: string,
  userId: string,
  mintedToken: string,
): Promise<{ accessToken: string; deviceId: string } | null> {
  // 1) Reuse the persisted session if still valid
  try {
    const stored = localStorage.getItem(SESSION_KEY(userId));
    if (stored) {
      const sess = JSON.parse(stored);
      const who = await fetch(`${homeserverUrl}/_matrix/client/v3/account/whoami`, {
        headers: { Authorization: `Bearer ${sess.accessToken}` },
      });
      if (who.ok) return sess;
      localStorage.removeItem(SESSION_KEY(userId));
    }
  } catch { /* continue with a fresh login */ }

  // 2) MSC3882: get_token → m.login.token → real device
  try {
    const r = await fetch(`${homeserverUrl}/_matrix/client/v1/login/get_token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${mintedToken}`, "Content-Type": "application/json" },
      body: "{}",
    });
    if (!r.ok) return null;
    const { login_token } = await r.json();
    const r2 = await fetch(`${homeserverUrl}/_matrix/client/v3/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "m.login.token",
        token: login_token,
        initial_device_display_name: `${getBrand().product} Teams`,
      }),
    });
    if (!r2.ok) return null;
    const j = await r2.json();
    if (!j.access_token || !j.device_id) return null;
    const sess = { accessToken: j.access_token, deviceId: j.device_id };
    try { localStorage.setItem(SESSION_KEY(userId), JSON.stringify(sess)); } catch { /* private mode */ }
    return sess;
  } catch {
    return null;
  }
}

export async function initMatrixClient(): Promise<boolean> {
  const store = useMatrixStore.getState();
  if (client && store.connected) return true;

  try {
    // Try element first, fallback to matrix app credentials
    let data: any = null;
    for (const appId of ["element", "matrix"]) {
      const resp = await fetch(`/api/claraos/auth-proxy/${appId}`, { credentials: "include" });
      if (!resp.ok) continue;
      const d = await resp.json();
      // Accept either: new shape (access_token + user_id, after admin-mint) OR legacy creds-fallback
      if ((d.access_token && d.user_id) || (d.credentials?.username && d.credentials?.password)) { data = d; break; }
    }
    if (!data) return false;

    // Matrix homeserver URL — NOT window.location.origin (that's the shell origin,
    // which has no /_matrix/* routes). Must be the Synapse-backed subdomain.
    const homeserverUrl = appUrl("matrix");
    let accessToken = data.token ?? data.access_token;
    let userId = data.user_id;

    // Auth-proxy may return credentials instead of a token (when the server cannot reach the
    // homeserver). In that case, login client-side from the browser, which can reach it.
    if (!accessToken && data.credentials?.username && data.credentials?.password) {
      const tempClient = sdk.createClient({ baseUrl: homeserverUrl });
      const loginResp = await tempClient.login("m.login.password", {
        identifier: { type: "m.id.user", user: data.credentials.username },
        password: data.credentials.password,
        initial_device_display_name: `${getBrand().product} Teams`,
      });
      accessToken = loginResp.access_token;
      userId = loginResp.user_id;
    }

    if (!accessToken || !userId) return false;

    // Preferred: device-bound session (E2EE-capable). If the upgrade fails
    // (MSC3882 disabled, network error), the app keeps running with the
    // device-less token — just without crypto.
    let deviceId: string | undefined =
      data.device_id ?? data.credentials?.device_id;
    let hasRealDevice = !!deviceId;

    if (!hasRealDevice) {
      const sess = await upgradeToDeviceSession(homeserverUrl, userId, accessToken);
      if (sess) {
        accessToken = sess.accessToken;
        deviceId = sess.deviceId;
        hasRealDevice = true;
      }
    }

    if (!deviceId) {
      // Legacy fallback: synthetic ID only as a UI hint for Element Call
      // ("Device ID must be supplied") — auth goes through the WidgetDriver.
      const KEY = "claraos-teams-device-id";
      deviceId = localStorage.getItem(KEY) ?? undefined;
      if (!deviceId) {
        deviceId = "CLAROSCALL" + Math.random().toString(36).slice(2, 12).toUpperCase();
        try { localStorage.setItem(KEY, deviceId); } catch { /* private mode */ }
      }
    }

    client = sdk.createClient({
      baseUrl: homeserverUrl,
      accessToken,
      userId,
      deviceId,
      useAuthorizationHeader: true,
      // Thread replies go into their own thread timelines instead of flat into
      // the main timeline (MSC3440) — the basis for the thread side pane.
      threadSupport: true,
    });

    // E2EE only works with a real device (device keys). IndexedDB store per
    // (user, device) — persists session keys across reloads.
    cryptoEnabled = false;
    if (hasRealDevice) {
      try {
        await client.initRustCrypto();
        cryptoEnabled = true;
      } catch (err) {
        console.warn("[TeamsApp] Rust-Crypto init failed — E2EE off:", err);
      }
    }

    store.setConnected(true, userId, data.display_name ?? userId.split(":")[0].slice(1));

    client.on(sdk.ClientEvent.Sync, (state) => {
      if (state === "PREPARED" || state === "SYNCING") {
        useMatrixStore.getState().setSyncing(true);
        syncRooms();
      }
    });

    // Encrypted events arrive as m.room.encrypted and only become
    // m.room.message asynchronously — they are delivered here afterwards.
    client.on(sdk.MatrixEventEvent.Decrypted, (event) => {
      const roomId = event.getRoomId();
      if (!roomId || event.getType() !== "m.room.message" || event.isRedacted()) return;
      const s = useMatrixStore.getState();
      const msg = eventToMessage(event);
      s.appendMessages(roomId, [msg]);
      s.updateLastMessage(roomId, { sender: msg.senderName, body: msg.body, ts: msg.ts });
    });

    client.on(sdk.RoomEvent.Timeline, (event, room) => {
      if (!room) return;
      const s = useMatrixStore.getState();

      if (event.getType() === "m.room.encrypted") {
        client!.decryptEventIfNeeded(event).catch(() => {});
        return;
      }

      if (event.getType() === "m.room.message") {
        if (event.isRedacted()) return;
        const msg = eventToMessage(event);
        s.appendMessages(room.roomId, [msg]);
        s.updateLastMessage(room.roomId, { sender: msg.senderName, body: msg.body, ts: msg.ts });
        if (room.roomId !== s.activeRoomId) {
          s.incrementUnread(room.roomId);
          sendNtfyNotification(room.name, msg.senderName, msg.body);
        }
      }

      if (event.getType() === "m.reaction") {
        const rel = event.getContent()["m.relates_to"];
        if (rel?.rel_type === "m.annotation" && rel.event_id && rel.key) {
          s.addReaction(room.roomId, rel.event_id, rel.key, event.getSender()!);
        }
      }
    });

    client.on(sdk.RoomEvent.Redaction, (event, room) => {
      if (!room) return;
      const redactedId = event.getAssociatedId();
      if (redactedId) {
        useMatrixStore.getState().updateMessage(room.roomId, redactedId, {
          redacted: true, body: "", formattedBody: undefined,
        });
      }
    });

    client.on(sdk.RoomEvent.Name, (room) => {
      const existing = useMatrixStore.getState().rooms[room.roomId];
      if (existing) useMatrixStore.getState().upsertRoom({ ...existing, name: room.name });
    });

    client.on(sdk.RoomMemberEvent.Typing, (_event, member) => {
      if (!member.roomId) return;
      const room = client!.getRoom(member.roomId);
      if (!room) return;
      const typingMembers = room.currentState
        .getMembers()
        .filter((m) => m.typing && m.userId !== client!.getUserId())
        .map((m) => m.name || m.userId);
      useMatrixStore.getState().setTyping(member.roomId, typingMembers);
    });

    client.on(sdk.RoomEvent.Receipt, (_event, room) => {
      const s = useMatrixStore.getState();
      for (const member of room.getJoinedMembers()) {
        const receipt = room.getReadReceiptForUserId(member.userId);
        if (receipt?.eventId) {
          s.setReceipt(room.roomId, member.userId, receipt.eventId);
        }
      }
    });

    client.on(sdk.RoomStateEvent.Events, (event) => {
      const type = event.getType();
      const roomId = event.getRoomId();
      if (!roomId) return;
      const room = client!.getRoom(roomId);
      if (!room) return;
      if (type === "im.vector.modular.widgets" || CALL_MEMBER_EVENT_TYPES.includes(type)) {
        useMatrixStore.getState().setActiveCall(roomId, roomHasActiveCall(room));
      }
      if (type === "m.room.pinned_events") {
        const existing = useMatrixStore.getState().rooms[roomId];
        if (existing) {
          useMatrixStore.getState().upsertRoom({
            ...existing,
            pinnedEventIds: event.getContent()?.pinned ?? [],
          });
        }
      }
    });

    client.on(sdk.UserEvent.Presence as any, (_event: any, user: any) => {
      if (user?.presence) {
        useMatrixStore.getState().setPresence(user.userId, user.presence);
      }
    });

    await client.startClient({ initialSyncLimit: 20 });
    return true;
  } catch (err: any) {
    console.error("[TeamsApp] Matrix init failed:", err);
    console.error("[TeamsApp] Error details:", err?.message, err?.data, err?.httpStatus);
    return false;
  }
}

function syncRooms() {
  if (!client) return;
  const store = useMatrixStore.getState();

  for (const room of client.getRooms()) {
    if (room.getMyMembership() !== "join") continue;
    store.upsertRoom(roomToStore(room));
  }

  const spaces = buildSpaces(client);
  for (const space of Object.values(spaces)) {
    store.upsertSpace(space);
  }
}

export async function loadRoomTimeline(roomId: string): Promise<void> {
  if (!client) return;
  const store = useMatrixStore.getState();
  if (store.timelineLoading[roomId]) return;

  store.setTimelineLoading(roomId, true);
  try {
    const room = client.getRoom(roomId);
    if (!room) return;

    const events = room.getLiveTimeline().getEvents();
    if (cryptoEnabled) {
      await Promise.all(
        events
          .filter((e) => e.getType() === "m.room.encrypted")
          .map((e) => client!.decryptEventIfNeeded(e).catch(() => {})),
      );
    }
    const messages = events
      .filter((e) => e.getType() === "m.room.message")
      .map(eventToMessage);

    if (messages.length > 0) {
      useMatrixStore.getState().appendMessages(roomId, messages);
    }
  } finally {
    useMatrixStore.getState().setTimelineLoading(roomId, false);
  }
}

export async function sendMessage(roomId: string, body: string): Promise<void> {
  if (!client || !body.trim()) return;
  await client.sendTextMessage(roomId, body.trim());
}

// === Threads (MSC3440) ===

export async function sendThreadReply(roomId: string, rootEventId: string, body: string): Promise<void> {
  if (!client || !body.trim()) return;
  await client.sendEvent(roomId, "m.room.message" as any, {
    msgtype: "m.text",
    body: body.trim(),
    "m.relates_to": {
      rel_type: "m.thread",
      event_id: rootEventId,
      // Fallback for clients without thread support: as a reply to the root
      "m.in_reply_to": { event_id: rootEventId },
      is_falling_back: true,
    },
  } as any);
}

export async function loadThreadTimeline(roomId: string, rootEventId: string): Promise<void> {
  if (!client) return;
  const room = client.getRoom(roomId);
  if (!room) return;
  try {
    const thread = room.getThread(rootEventId);
    if (thread) {
      // Fetch historical replies from the server if not yet local
      await (thread as any).fetchInitialEvents?.().catch(() => {});
      const events = thread.liveTimeline?.getEvents() ?? [];
      const messages = events
        .filter((e) => e.getType() === "m.room.message")
        .map(eventToMessage);
      if (messages.length) useMatrixStore.getState().appendMessages(roomId, messages);
      return;
    }
    // No local thread object (root outside the sync window):
    // query the relations API directly.
    const rel = await (client as any).relations(roomId, rootEventId, "m.thread", "m.room.message", {
      limit: 50,
    });
    const messages = (rel?.events ?? [])
      .map((e: any) => eventToMessage(e))
      .filter((m: MatrixMessage) => !!m.eventId);
    if (messages.length) useMatrixStore.getState().appendMessages(roomId, messages);
  } catch (err) {
    console.warn("[TeamsApp] loadThreadTimeline failed", err);
  }
}

// === Pagination (Infinite Scroll) ===

/** Load older messages. Returns true if new events arrived. */
export async function loadOlderMessages(roomId: string): Promise<boolean> {
  if (!client) return false;
  const room = client.getRoom(roomId);
  if (!room) return false;
  const before = room.getLiveTimeline().getEvents().length;
  try {
    await client.scrollback(room, 30);
  } catch {
    return false;
  }
  const events = room.getLiveTimeline().getEvents();
  if (events.length <= before) return false;
  if (cryptoEnabled) {
    await Promise.all(
      events
        .filter((e) => e.getType() === "m.room.encrypted")
        .map((e) => client!.decryptEventIfNeeded(e).catch(() => {})),
    );
  }
  const messages = events
    .filter((e) => e.getType() === "m.room.message")
    .map(eventToMessage);
  if (messages.length) useMatrixStore.getState().appendMessages(roomId, messages);
  return true;
}

// === Direct Messages ===

/** Start a 1:1 DM (or open the existing one). Sets m.direct account data
 * so the room is classified as a DM everywhere. */
export async function startDM(userId: string): Promise<string | null> {
  if (!client) return null;

  // Reuse an existing DM with exactly this user
  const directContent: Record<string, string[]> = client.getAccountData(sdk.EventType.Direct)?.getContent() ?? {};
  const existing = (directContent[userId] ?? []).find((rid: string) => {
    const r = client!.getRoom(rid);
    return r && r.getMyMembership() === "join";
  });
  if (existing) return existing;

  const result = await client.createRoom({
    preset: sdk.Preset.TrustedPrivateChat,
    is_direct: true,
    invite: [userId],
  });

  const updated = { ...directContent, [userId]: [...(directContent[userId] ?? []), result.room_id] };
  await client.setAccountData(sdk.EventType.Direct, updated).catch(() => {});
  return result.room_id;
}

export async function createSpace(name: string): Promise<string | null> {
  if (!client) return null;
  const result = await client.createRoom({
    name,
    visibility: sdk.Visibility.Private,
    creation_content: { type: "m.space" },
    power_level_content_override: { events_default: 0 },
  });
  return result.room_id;
}

export async function createChannel(spaceId: string, name: string): Promise<string | null> {
  if (!client) return null;
  const result = await client.createRoom({
    name,
    visibility: sdk.Visibility.Private,
    preset: sdk.Preset.PrivateChat,
  });
  await client.sendStateEvent(spaceId, "m.space.child", { via: [client.getDomain()!] }, result.room_id);
  return result.room_id;
}

export interface RoomWidget {
  id: string;
  type: string;
  name: string;
  url: string;
  creatorUserId: string;
}

export function getRoomWidgets(roomId: string): RoomWidget[] {
  if (!client) return [];
  const room = client.getRoom(roomId);
  if (!room) return [];
  const widgetEvents = room.currentState.getStateEvents("im.vector.modular.widgets");
  return widgetEvents
    .filter((e) => e.getContent()?.url)
    .map((e) => ({
      id: e.getStateKey()!,
      type: e.getContent().type ?? "custom",
      name: e.getContent().name ?? "Widget",
      url: e.getContent().url,
      creatorUserId: e.getContent().creatorUserId ?? e.getSender()!,
    }));
}

export const ELEMENT_CALL_ORIGIN = appUrl("element-call");
const MATRIX_HOMESERVER_URL = appUrl("matrix");

// Element Call embedded ("matryoshka") mode: presence of widgetId+parentUrl
// switches EC's internal Matrix client to a widget-API proxy that routes all
// RPCs to the parent. accessToken/userId/deviceId/baseUrl are deliberately
// NOT included — EC ignores them in widget mode and auth comes implicitly via
// the parent's matrix-js-sdk client through ElementCallWidgetDriver.
//
// `roomId` MUST appear as a query param (not just in the route path); without
// it EC logs "Room ID must be supplied" and falls back to its standalone
// lobby.
export function buildElementCallUrl(roomId: string, widgetId: string): string {
  // userId/deviceId/baseUrl are identity HINTS for EC's UI (display names,
  // self-tile, homeserver URL for media URIs). They are NOT used for auth —
  // every Matrix RPC is proxied through ElementCallWidgetDriver. EC will
  // bail out of widget mode ("User ID must be supplied") without userId set.
  // accessToken is intentionally still omitted (EC ignores it in widget mode).
  const params = new URLSearchParams({
    widgetId,
    parentUrl: window.location.href,
    roomId,
    userId: client?.getUserId() ?? "",
    deviceId: client?.getDeviceId() ?? "",
    baseUrl: MATRIX_HOMESERVER_URL,
    lang: navigator.language || "en",
    // Warning: `embed=true` NO LONGER exists in Element Call since 0.26.
    // The parameter was dropped without replacement; EC silently ignores it.
    // Without `intent`, `computeUrlParams` then falls into the `default:` branch
    // and applies the SPA defaults (UrlParams.ts: `skipLobby: false`,
    // `confineToRoom: false`, `header: standard`) — even though EC knows it is
    // a widget. Visible effect in the Teams window: Element lobby with
    // "Join call", Element header bar, "Back to recents" and the Element Call
    // logo. The three switches below are the successors of `embed` and win
    // against any default because `computeUrlParams` merges them last
    // (`...pickBy(configuration, defined)`).
    //
    // Deliberately NOT set: `intent`. It would also change
    // `perParticipantE2EE` and `allowIceFallback` — we change nothing about the
    // call technology here, only the UI.
    skipLobby: "true",        // no second "Join" — our list is the entry point
    confineToRoom: "true",    // no "Back to recents", no jump to the EC start page
    header: "none",           // no Element header bar; also hides the logo
                              // (CallFooterViewModel: showLogo = header === "standard")
  });
  // Critical: the path is `/room`, WITHOUT the room ID. The room ID is (and
  // always was) also in the `roomId` parameter; RoomPage reads it from there.
  // Why this is not cosmetic:
  //
  // Since 0.26 Element Call locates its `config.json` like this (src/config/Config.ts):
  //     pathname ends with "/room" or "/room/"  →  fetch("/config.json")
  //     otherwise                               →  fetch("config.json")  [relative!]
  // With the old path `/room/!abc:example.com` the second branch applied and
  // EC fetched `/room/config.json`. The image's nginx serves that as an SPA
  // fallback with **HTTP 200 and index.html** — not a 404 EC could fall back
  // on. `response.json()` fails at `<!doctype`, the config stays empty, and
  // with it `livekit.livekit_service_url` is missing. Result: Element Call
  // never requests a LiveKit token (the lk-jwt service only sees health
  // checks) — the UI shows a call, but nothing connects.
  // The SPA trap again: "everything 200" does not mean "everything there".
  //
  // `/room` is also the form Element Web itself uses for its call widget.
  // Parameters stay in the fragment so they end up neither in the nginx log
  // nor in the Referer.
  return `${ELEMENT_CALL_ORIGIN}/room#?${params.toString()}`;
}

export { MATRIX_HOMESERVER_URL };

export async function createAdHocRoom(name: string): Promise<string | null> {
  if (!client) return null;
  const result = await client.createRoom({
    name,
    visibility: sdk.Visibility.Private,
    preset: sdk.Preset.PrivateChat,
  });
  return result.room_id;
}

export async function startCall(roomId: string): Promise<void> {
  if (!client) return;
  const userId = client.getUserId()!;
  const callWidgetId = "element-call-" + Date.now();
  const callUrl = buildElementCallUrl(roomId, callWidgetId);

  await client.sendStateEvent(roomId, "im.vector.modular.widgets", {
    type: "m.call",
    url: callUrl,
    name: "Call",
    creatorUserId: userId,
    id: callWidgetId,
  }, callWidgetId);

  useMatrixStore.getState().setActiveCall(roomId, true);
}

export async function endCall(roomId: string): Promise<void> {
  if (!client) return;
  const widgets = getRoomWidgets(roomId);
  for (const w of widgets) {
    if (w.type === "m.call") {
      await client.sendStateEvent(roomId, "im.vector.modular.widgets", {}, w.id);
    }
  }
  useMatrixStore.getState().setActiveCall(roomId, false);
}

// Ad-hoc "Meeting …" rooms exist only to host one call. Once the local user
// leaves and nobody else is joined, leave+forget so they don't pile up in the
// sidebar and Activity feed (they used to accumulate forever).
export async function maybeCleanupAdHocRoom(roomId: string): Promise<void> {
  if (!client) return;
  const room = client.getRoom(roomId);
  if (!room || !room.name.startsWith("Meeting ")) return;
  const others = room.getJoinedMembers().filter((m) => m.userId !== client!.getUserId());
  if (others.length > 0) return;
  await client.leave(roomId).catch(() => {});
  await client.forget(roomId).catch(() => {});
  useMatrixStore.getState().removeRoom(roomId);
}

export function getNextcloudFilesUrl(roomId: string): string {
  const encodedRoom = encodeURIComponent(roomId.replace(/[^a-zA-Z0-9]/g, "_"));
  return appUrl("nextcloud", `/apps/files/?dir=/Teams/${encodedRoom}`);
}

export function getNextcloudDeckUrl(): string {
  return appUrl("nextcloud", "/apps/deck/");
}

export function getNextcloudCalendarUrl(): string {
  return appUrl("nextcloud", "/apps/calendar/");
}

// === Batch 1: Reactions, Reply, Edit, Delete ===

export async function sendReaction(roomId: string, eventId: string, emoji: string): Promise<void> {
  if (!client) return;
  await client.sendEvent(roomId, "m.reaction" as any, {
    "m.relates_to": { rel_type: "m.annotation", event_id: eventId, key: emoji },
  } as any);
}

let typingTimeout: ReturnType<typeof setTimeout> | null = null;
export function sendTypingIndicator(roomId: string): void {
  if (!client) return;
  if (typingTimeout) clearTimeout(typingTimeout);
  client.sendTyping(roomId, true, 5000).catch(() => {});
  typingTimeout = setTimeout(() => {
    client?.sendTyping(roomId, false, 0).catch(() => {});
  }, 4000);
}

export async function sendReply(roomId: string, body: string, replyToEvent: MatrixMessage): Promise<void> {
  if (!client || !body.trim()) return;
  const htmlBody = `<mx-reply><blockquote><a href="https://matrix.to/#/${roomId}/${replyToEvent.eventId}">In reply to</a> <a href="https://matrix.to/#/${replyToEvent.sender}">${escapeHtml(replyToEvent.senderName)}</a><br/>${escapeHtml(replyToEvent.body)}</blockquote></mx-reply>${escapeHtml(body.trim())}`;
  await client.sendEvent(roomId, "m.room.message" as any, {
    msgtype: "m.text",
    body: `> <${replyToEvent.sender}> ${replyToEvent.body}\n\n${body.trim()}`,
    format: "org.matrix.custom.html",
    formatted_body: htmlBody,
    "m.relates_to": { "m.in_reply_to": { event_id: replyToEvent.eventId } },
  } as any);
  useMatrixStore.getState().setReplyTo(null);
}

export async function editMessage(roomId: string, eventId: string, newBody: string): Promise<void> {
  if (!client || !newBody.trim()) return;
  await client.sendEvent(roomId, "m.room.message" as any, {
    "m.new_content": { msgtype: "m.text", body: newBody.trim() },
    "m.relates_to": { rel_type: "m.replace", event_id: eventId },
    msgtype: "m.text",
    body: `* ${newBody.trim()}`,
  } as any);
  useMatrixStore.getState().setEditingEvent(null);
  useMatrixStore.getState().updateMessage(roomId, eventId, { body: newBody.trim(), isEdited: true });
}

export async function deleteMessage(roomId: string, eventId: string): Promise<void> {
  if (!client) return;
  await client.redactEvent(roomId, eventId);
}

// === Batch 2: Formatted messages, Members ===

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function markdownToHtml(text: string): string | null {
  // Escape first — user input must never reach formatted_body as raw HTML.
  let html = escapeHtml(text);
  let changed = false;
  html = html.replace(/\*\*(.+?)\*\*/g, (_m, g1) => { changed = true; return `<strong>${g1}</strong>`; });
  html = html.replace(/\*(.+?)\*/g, (_m, g1) => { changed = true; return `<em>${g1}</em>`; });
  html = html.replace(/`(.+?)`/g, (_m, g1) => { changed = true; return `<code>${g1}</code>`; });
  html = html.replace(/\[(.+?)\]\((.+?)\)/g, (_m, g1, g2) => { changed = true; return `<a href="${g2}">${g1}</a>`; });
  return changed ? html : null;
}

export async function sendFormattedMessage(roomId: string, body: string): Promise<void> {
  if (!client || !body.trim()) return;
  const html = markdownToHtml(body.trim());
  if (html) {
    await client.sendEvent(roomId, "m.room.message" as any, {
      msgtype: "m.text",
      body: body.trim(),
      format: "org.matrix.custom.html",
      formatted_body: html,
    } as any);
  } else {
    await client.sendTextMessage(roomId, body.trim());
  }
}

export interface MatrixMember {
  userId: string;
  displayName: string;
  avatarUrl?: string;
  powerLevel: number;
  presence?: string;
}

export function getRoomMembersList(roomId: string): MatrixMember[] {
  if (!client) return [];
  const room = client.getRoom(roomId);
  if (!room) return [];
  return room.getJoinedMembers().map((m) => ({
    userId: m.userId,
    displayName: m.name || m.userId,
    avatarUrl: m.getAvatarUrl(client!.baseUrl, 32, 32, "crop", false, false) ?? undefined,
    powerLevel: room.currentState.getStateEvents("m.room.power_levels", "")?.getContent()?.users?.[m.userId] ?? 0,
    presence: useMatrixStore.getState().presence[m.userId],
  }));
}

// === Batch 3: Presence ===

export async function setOwnPresence(state: "online" | "unavailable" | "offline"): Promise<void> {
  if (!client) return;
  await client.setPresence({ presence: state } as any).catch(() => {});
}

// === Batch 4: File upload, Read receipts, URL preview ===

export async function uploadAndSendFile(roomId: string, file: File): Promise<void> {
  if (!client) return;
  const upload = await client.uploadContent(file, { name: file.name, type: file.type } as any);
  const isImage = file.type.startsWith("image/");
  await client.sendEvent(roomId, "m.room.message" as any, {
    msgtype: isImage ? "m.image" : "m.file",
    body: file.name,
    url: upload.content_uri,
    info: { mimetype: file.type, size: file.size },
  } as any);
}

export async function markAsRead(roomId: string, eventId: string): Promise<void> {
  if (!client) return;
  const room = client.getRoom(roomId);
  if (!room) return;
  const event = room.findEventById(eventId);
  if (event) {
    await client.sendReadReceipt(event).catch(() => {});
  }
}

export async function getUrlPreview(url: string): Promise<{ title?: string; description?: string; imageUrl?: string } | null> {
  if (!client) return null;
  try {
    const preview = await (client as any).getUrlPreview(url, Date.now());
    return {
      title: preview["og:title"],
      description: preview["og:description"],
      imageUrl: preview["og:image"],
    };
  } catch {
    return null;
  }
}

// === Batch 5: Invite, Delete room, Topic, Pin/Mute ===

export async function inviteMember(roomId: string, userId: string): Promise<void> {
  if (!client) return;
  await client.invite(roomId, userId);
}

export async function searchUsers(query: string): Promise<{ userId: string; displayName: string }[]> {
  if (!client || !query.trim()) return [];
  try {
    const resp = await client.searchUserDirectory({ term: query.trim(), limit: 10 });
    return (resp.results ?? []).map((r: any) => ({ userId: r.user_id, displayName: r.display_name || r.user_id }));
  } catch {
    return [];
  }
}

export async function deleteRoom(roomId: string): Promise<void> {
  if (!client) return;
  await client.leave(roomId);
  await client.forget(roomId).catch(() => {});
  useMatrixStore.getState().removeRoom(roomId);
}

export async function setRoomTopic(roomId: string, topic: string): Promise<void> {
  if (!client) return;
  await client.setRoomTopic(roomId, topic);
}

export async function pinMessage(roomId: string, eventId: string): Promise<void> {
  if (!client) return;
  const room = client.getRoom(roomId);
  if (!room) return;
  const current = room.currentState.getStateEvents("m.room.pinned_events", "")?.getContent()?.pinned ?? [];
  const updated = current.includes(eventId) ? current.filter((id: string) => id !== eventId) : [...current, eventId];
  await client.sendStateEvent(roomId, "m.room.pinned_events" as any, { pinned: updated }, "");
}

// === Batch 6: Forward ===

export async function forwardMessage(fromRoomId: string, eventId: string, toRoomId: string): Promise<void> {
  if (!client) return;
  const room = client.getRoom(fromRoomId);
  const event = room?.findEventById(eventId);
  if (!event) return;
  const content = event.getContent();
  await client.sendEvent(toRoomId, "m.room.message" as any, {
    msgtype: "m.text",
    body: `[Forwarded] ${content.body ?? ""}`,
    format: "org.matrix.custom.html",
    formatted_body: `<em>Forwarded from #${room?.name ?? fromRoomId}</em><br/>${content.formatted_body ?? content.body ?? ""}`,
  } as any);
}

// === Batch 7: Power levels ===

export async function setUserPowerLevel(roomId: string, userId: string, level: number): Promise<void> {
  if (!client) return;
  const room = client.getRoom(roomId);
  if (!room) return;
  const plEvent = room.currentState.getStateEvents("m.room.power_levels", "");
  if (!plEvent) return;
  const content = { ...plEvent.getContent() };
  content.users = { ...(content.users ?? {}), [userId]: level };
  await client.sendStateEvent(roomId, "m.room.power_levels" as any, content, "");
}

let ntfyEnabled = true;
let lastNtfyTs = 0;

async function sendNtfyNotification(roomName: string, sender: string, body: string) {
  if (!ntfyEnabled) return;
  const now = Date.now();
  if (now - lastNtfyTs < 5000) return; // rate limit: 1 per 5s
  lastNtfyTs = now;

  try {
    await fetch(appUrl("ntfy", "/teams-messages"), {
      method: "POST",
      headers: {
        "Title": `${sender} in #${roomName}`,
        "Priority": "default",
        "Tags": "speech_balloon",
      },
      body: body.slice(0, 200),
    });
  } catch {
    // NTFY unreachable — disable for this session
    ntfyEnabled = false;
  }
}

export function destroyMatrixClient() {
  if (client) {
    client.stopClient();
    client = null;
  }
  useMatrixStore.getState().reset();
}
