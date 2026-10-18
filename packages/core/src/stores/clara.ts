import { create } from "zustand";
import type { ChatMessage, ChatSession, ChatFolder } from "../types";

let msgId = 0;

export interface ClaraStore {
  // State
  sessions: ChatSession[];
  folders: ChatFolder[];
  activeSessionId: string | null;
  streaming: boolean;

  // Actions
  createSession: (title?: string, objectRef?: string) => string;
  deleteSession: (id: string) => void;
  setActiveSession: (id: string | null) => void;
  addMessage: (sessionId: string, role: ChatMessage["role"], content: string) => void;
  updateLastMessage: (sessionId: string, content: string) => void;
  setStreaming: (streaming: boolean) => void;

  // Folders
  createFolder: (name: string, parentId?: string) => string;
  moveSession: (sessionId: string, folderId: string | undefined) => void;

  // Helpers
  getSession: (id: string) => ChatSession | undefined;
  getActiveSession: () => ChatSession | undefined;
}

export const useClaraStore = create<ClaraStore>()((set, get) => ({
  sessions: [],
  folders: [],
  activeSessionId: null,
  streaming: false,

  createSession: (title, objectRef) => {
    const id = `chat-${Date.now()}`;
    const session: ChatSession = {
      id,
      title: title || "Neuer Chat",
      messages: [],
      objectRef,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    set((s) => ({
      sessions: [session, ...s.sessions],
      activeSessionId: id,
    }));
    return id;
  },

  deleteSession: (id) => {
    set((s) => ({
      sessions: s.sessions.filter((c) => c.id !== id),
      activeSessionId: s.activeSessionId === id ? null : s.activeSessionId,
    }));
  },

  setActiveSession: (id) => set({ activeSessionId: id }),

  addMessage: (sessionId, role, content) => {
    const msg: ChatMessage = {
      id: `msg-${msgId++}`,
      role,
      content,
      timestamp: Date.now(),
    };
    set((s) => ({
      sessions: s.sessions.map((c) =>
        c.id === sessionId
          ? { ...c, messages: [...c.messages, msg], updatedAt: Date.now() }
          : c,
      ),
    }));
  },

  updateLastMessage: (sessionId, content) => {
    set((s) => ({
      sessions: s.sessions.map((c) => {
        if (c.id !== sessionId || c.messages.length === 0) return c;
        const msgs = [...c.messages];
        msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], content };
        return { ...c, messages: msgs, updatedAt: Date.now() };
      }),
    }));
  },

  setStreaming: (streaming) => set({ streaming }),

  createFolder: (name, parentId) => {
    const id = `folder-${Date.now()}`;
    set((s) => ({ folders: [...s.folders, { id, name, parentId }] }));
    return id;
  },

  moveSession: (sessionId, folderId) => {
    set((s) => ({
      sessions: s.sessions.map((c) =>
        c.id === sessionId ? { ...c, folderId } : c,
      ),
    }));
  },

  getSession: (id) => get().sessions.find((c) => c.id === id),
  getActiveSession: () => {
    const { sessions, activeSessionId } = get();
    return activeSessionId ? sessions.find((c) => c.id === activeSessionId) : undefined;
  },
}));
