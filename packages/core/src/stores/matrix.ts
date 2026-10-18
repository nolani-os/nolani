import { create } from "zustand";

export interface MatrixRoom {
  roomId: string;
  name: string;
  topic?: string;
  avatarUrl?: string;
  isSpace: boolean;
  isEncrypted: boolean;
  isDirect: boolean;
  parentSpaceId?: string;
  membership: "join" | "invite" | "leave";
  unreadCount: number;
  lastMessage?: { sender: string; body: string; ts: number };
  members: string[];
  activeCall: boolean;
  pinnedEventIds: string[];
}

export interface MatrixMessage {
  eventId: string;
  roomId: string;
  sender: string;
  senderName: string;
  type: string;
  body: string;
  formattedBody?: string;
  ts: number;
  threadRootId?: string;
  /** Server-side thread summary (unsigned m.relations) — reply count without having loaded the replies themselves */
  threadReplyCount?: number;
  isEdited: boolean;
  replyTo?: string;
  redacted: boolean;
  reactions: Record<string, string[]>;
  fileUrl?: string;
  fileName?: string;
  fileMimeType?: string;
  fileSize?: number;
  thumbnailUrl?: string;
}

export interface MatrixSpace {
  spaceId: string;
  name: string;
  avatarUrl?: string;
  childRoomIds: string[];
}

export type RailView = "activity" | "chat" | "teams" | "calendar" | "calls" | "files";

export interface MatrixState {
  connected: boolean;
  syncing: boolean;
  userId: string | null;
  displayName: string | null;

  railView: RailView;
  spaces: Record<string, MatrixSpace>;
  rooms: Record<string, MatrixRoom>;
  activeRoomId: string | null;
  activeSpaceId: string | null;

  timeline: Record<string, MatrixMessage[]>;
  timelineLoading: Record<string, boolean>;
  expandedSpaces: Record<string, boolean>;

  typing: Record<string, string[]>;
  presence: Record<string, "online" | "unavailable" | "offline">;
  receipts: Record<string, Record<string, string>>;
  replyTo: MatrixMessage | null;
  editingEvent: MatrixMessage | null;
  pinnedRooms: string[];
  mutedRooms: string[];
  savedMessages: MatrixMessage[];
  /** Room whose call the CallsView should join directly after switching railView */
  callToJoin: string | null;
  /** Root event of the open thread side pane (null = closed) */
  activeThreadRootId: string | null;
}

export interface MatrixActions {
  setConnected: (connected: boolean, userId?: string, displayName?: string) => void;
  setSyncing: (syncing: boolean) => void;
  setRailView: (view: RailView) => void;

  upsertSpace: (space: MatrixSpace) => void;
  upsertRoom: (room: MatrixRoom) => void;
  removeRoom: (roomId: string) => void;
  setActiveRoom: (roomId: string | null) => void;
  setActiveSpace: (spaceId: string | null) => void;
  toggleSpaceExpanded: (spaceId: string) => void;

  appendMessages: (roomId: string, messages: MatrixMessage[]) => void;
  prependMessages: (roomId: string, messages: MatrixMessage[]) => void;
  setTimelineLoading: (roomId: string, loading: boolean) => void;
  updateLastMessage: (roomId: string, msg: MatrixRoom["lastMessage"]) => void;
  incrementUnread: (roomId: string) => void;
  clearUnread: (roomId: string) => void;
  setActiveCall: (roomId: string, active: boolean) => void;

  setTyping: (roomId: string, users: string[]) => void;
  setPresence: (userId: string, state: "online" | "unavailable" | "offline") => void;
  setReceipt: (roomId: string, userId: string, eventId: string) => void;
  setReplyTo: (msg: MatrixMessage | null) => void;
  setEditingEvent: (msg: MatrixMessage | null) => void;
  addReaction: (roomId: string, eventId: string, emoji: string, sender: string) => void;
  updateMessage: (roomId: string, eventId: string, update: Partial<MatrixMessage>) => void;
  togglePinRoom: (roomId: string) => void;
  toggleMuteRoom: (roomId: string) => void;
  addSavedMessage: (msg: MatrixMessage) => void;
  removeSavedMessage: (eventId: string) => void;
  setCallToJoin: (roomId: string | null) => void;
  setActiveThreadRoot: (eventId: string | null) => void;

  reset: () => void;
}

export type MatrixStore = MatrixState & MatrixActions;

const initialState: MatrixState = {
  connected: false,
  syncing: false,
  userId: null,
  displayName: null,
  railView: "teams",
  spaces: {},
  rooms: {},
  activeRoomId: null,
  activeSpaceId: null,
  timeline: {},
  timelineLoading: {},
  expandedSpaces: {},
  typing: {},
  presence: {},
  receipts: {},
  replyTo: null,
  editingEvent: null,
  pinnedRooms: [],
  mutedRooms: [],
  savedMessages: [],
  callToJoin: null,
  activeThreadRootId: null,
};

export const useMatrixStore = create<MatrixStore>()((set, get) => ({
  ...initialState,

  setConnected: (connected, userId, displayName) =>
    set({ connected, userId: userId ?? get().userId, displayName: displayName ?? get().displayName }),

  setSyncing: (syncing) => set({ syncing }),

  setRailView: (railView) => set({ railView }),

  upsertSpace: (space) =>
    set((s) => ({ spaces: { ...s.spaces, [space.spaceId]: space } })),

  upsertRoom: (room) =>
    set((s) => ({ rooms: { ...s.rooms, [room.roomId]: room } })),

  removeRoom: (roomId) =>
    set((s) => {
      const { [roomId]: _, ...rest } = s.rooms;
      return { rooms: rest };
    }),

  setActiveRoom: (roomId) => set({ activeRoomId: roomId }),

  setActiveSpace: (spaceId) => set({ activeSpaceId: spaceId }),

  toggleSpaceExpanded: (spaceId) =>
    set((s) => ({
      expandedSpaces: { ...s.expandedSpaces, [spaceId]: !s.expandedSpaces[spaceId] },
    })),

  appendMessages: (roomId, messages) => {
    if (messages.length === 0) return;
    set((s) => {
      // Dedupe: timeline events sometimes arrive twice (initial load +
      // live event, thread reload). Existing entries do not win — the new
      // version replaces them (e.g. after an edit), ordered by ts.
      const existing = s.timeline[roomId] ?? [];
      const incoming = new Map(messages.map((m) => [m.eventId, m]));
      const merged = existing.map((m) => incoming.get(m.eventId) ?? m);
      const known = new Set(existing.map((m) => m.eventId));
      for (const m of messages) if (!known.has(m.eventId)) merged.push(m);
      merged.sort((a, b) => a.ts - b.ts);
      return { timeline: { ...s.timeline, [roomId]: merged } };
    });
  },

  prependMessages: (roomId, messages) =>
    set((s) => ({
      timeline: {
        ...s.timeline,
        [roomId]: [...messages, ...(s.timeline[roomId] ?? [])],
      },
    })),

  setTimelineLoading: (roomId, loading) =>
    set((s) => ({ timelineLoading: { ...s.timelineLoading, [roomId]: loading } })),

  updateLastMessage: (roomId, msg) =>
    set((s) => {
      const room = s.rooms[roomId];
      if (!room) return {};
      return { rooms: { ...s.rooms, [roomId]: { ...room, lastMessage: msg } } };
    }),

  incrementUnread: (roomId) =>
    set((s) => {
      const room = s.rooms[roomId];
      if (!room) return {};
      return { rooms: { ...s.rooms, [roomId]: { ...room, unreadCount: room.unreadCount + 1 } } };
    }),

  clearUnread: (roomId) =>
    set((s) => {
      const room = s.rooms[roomId];
      if (!room) return {};
      return { rooms: { ...s.rooms, [roomId]: { ...room, unreadCount: 0 } } };
    }),

  setActiveCall: (roomId, active) =>
    set((s) => {
      const room = s.rooms[roomId];
      if (!room) return {};
      return { rooms: { ...s.rooms, [roomId]: { ...room, activeCall: active } } };
    }),

  setTyping: (roomId, users) =>
    set((s) => ({ typing: { ...s.typing, [roomId]: users } })),

  setPresence: (userId, state) =>
    set((s) => ({ presence: { ...s.presence, [userId]: state } })),

  setReceipt: (roomId, userId, eventId) =>
    set((s) => ({
      receipts: { ...s.receipts, [roomId]: { ...(s.receipts[roomId] ?? {}), [userId]: eventId } },
    })),

  setReplyTo: (msg) => set({ replyTo: msg }),
  setEditingEvent: (msg) => set({ editingEvent: msg }),

  addReaction: (roomId, eventId, emoji, sender) =>
    set((s) => {
      const msgs = s.timeline[roomId] ?? [];
      return {
        timeline: {
          ...s.timeline,
          [roomId]: msgs.map((m) => {
            if (m.eventId !== eventId) return m;
            const reactions = { ...m.reactions };
            reactions[emoji] = [...(reactions[emoji] ?? []), sender];
            return { ...m, reactions };
          }),
        },
      };
    }),

  updateMessage: (roomId, eventId, update) =>
    set((s) => {
      const msgs = s.timeline[roomId] ?? [];
      return {
        timeline: {
          ...s.timeline,
          [roomId]: msgs.map((m) => (m.eventId === eventId ? { ...m, ...update } : m)),
        },
      };
    }),

  togglePinRoom: (roomId) =>
    set((s) => ({
      pinnedRooms: s.pinnedRooms.includes(roomId)
        ? s.pinnedRooms.filter((id) => id !== roomId)
        : [...s.pinnedRooms, roomId],
    })),

  toggleMuteRoom: (roomId) =>
    set((s) => ({
      mutedRooms: s.mutedRooms.includes(roomId)
        ? s.mutedRooms.filter((id) => id !== roomId)
        : [...s.mutedRooms, roomId],
    })),

  addSavedMessage: (msg) =>
    set((s) => ({ savedMessages: [...s.savedMessages, msg] })),

  removeSavedMessage: (eventId) =>
    set((s) => ({ savedMessages: s.savedMessages.filter((m) => m.eventId !== eventId) })),

  setCallToJoin: (roomId) => set({ callToJoin: roomId }),
  setActiveThreadRoot: (eventId) => set({ activeThreadRootId: eventId }),

  reset: () => set(initialState),
}));
