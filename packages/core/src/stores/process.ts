import { create } from "zustand";
import type { AppProcess } from "../types";

let nextPid = 0;

export interface ProcessState {
  processes: Record<string, AppProcess>;
}

export interface ProcessActions {
  launch: (appId: string, windowId: string) => string;
  kill: (pid: string) => void;
  killByWindow: (windowId: string) => void;
  getByApp: (appId: string) => AppProcess[];
  getByWindow: (windowId: string) => AppProcess | undefined;
}

export type ProcessStore = ProcessState & ProcessActions;

export const useProcessStore = create<ProcessStore>()((set, get) => ({
  processes: {},

  launch: (appId, windowId) => {
    const pid = `pid-${nextPid++}`;
    const process: AppProcess = {
      pid,
      appId,
      windowId,
      startedAt: Date.now(),
    };
    set((state) => ({
      processes: { ...state.processes, [pid]: process },
    }));
    return pid;
  },

  kill: (pid) => {
    set((state) => {
      const { [pid]: _, ...remaining } = state.processes;
      return { processes: remaining };
    });
  },

  killByWindow: (windowId) => {
    set((state) => {
      const remaining: Record<string, AppProcess> = {};
      for (const [pid, proc] of Object.entries(state.processes)) {
        if (proc.windowId !== windowId) {
          remaining[pid] = proc;
        }
      }
      return { processes: remaining };
    });
  },

  getByApp: (appId) => {
    return Object.values(get().processes).filter((p) => p.appId === appId);
  },

  getByWindow: (windowId) => {
    return Object.values(get().processes).find((p) => p.windowId === windowId);
  },
}));
