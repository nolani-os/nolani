import { get, set, del, createStore } from "idb-keyval";
import type { StateStorage } from "zustand/middleware";

// Dedicated IndexedDB store for ClaraOS
const claraosDB = createStore("claraos-state", "zustand");

export const idbStorage: StateStorage = {
  getItem: async (name) => {
    const value = await get<string>(name, claraosDB);
    return value ?? null;
  },
  setItem: async (name, value) => {
    await set(name, value, claraosDB);
  },
  removeItem: async (name) => {
    await del(name, claraosDB);
  },
};
