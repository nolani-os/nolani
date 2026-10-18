import { create } from "zustand";
import type { AppAccount } from "../types";

export interface CredentialsState {
  /** accounts[appId] = list of accounts */
  accounts: Record<string, AppAccount[]>;
  loading: Record<string, boolean>;
}

export interface CredentialsActions {
  loadAccounts: (appId: string) => Promise<void>;
  saveCredentials: (appId: string, accountName: string, values: Record<string, string>) => Promise<void>;
  updateCredentials: (appId: string, accountName: string, values: Record<string, string>) => Promise<void>;
  deleteAccount: (appId: string, accountName: string) => Promise<void>;
  activateAccount: (appId: string, accountName: string) => Promise<void>;
  getActiveAccount: (appId: string) => AppAccount | undefined;
  getCredentials: (appId: string, accountName: string) => Promise<Record<string, string>>;
}

export type CredentialsStore = CredentialsState & CredentialsActions;

const API = "/api/claraos/credentials";

export const useCredentialsStore = create<CredentialsStore>((set, get) => ({
  accounts: {},
  loading: {},

  loadAccounts: async (appId: string) => {
    set((s) => ({ loading: { ...s.loading, [appId]: true } }));
    try {
      const res = await fetch(`${API}/${appId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list: AppAccount[] = await res.json();
      set((s) => ({
        accounts: { ...s.accounts, [appId]: list },
        loading: { ...s.loading, [appId]: false },
      }));
    } catch (e) {
      console.error("Failed to load accounts:", e);
      set((s) => ({ loading: { ...s.loading, [appId]: false } }));
    }
  },

  saveCredentials: async (appId: string, accountName: string, values: Record<string, string>) => {
    const res = await fetch(`${API}/${appId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_name: accountName, credentials: values }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }
    await get().loadAccounts(appId);
  },

  updateCredentials: async (appId: string, accountName: string, values: Record<string, string>) => {
    const res = await fetch(`${API}/${appId}/${encodeURIComponent(accountName)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: values }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await get().loadAccounts(appId);
  },

  deleteAccount: async (appId: string, accountName: string) => {
    const res = await fetch(`${API}/${appId}/${encodeURIComponent(accountName)}`, {
      method: "DELETE",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await get().loadAccounts(appId);
  },

  activateAccount: async (appId: string, accountName: string) => {
    const res = await fetch(`${API}/${appId}/${encodeURIComponent(accountName)}/activate`, {
      method: "POST",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await get().loadAccounts(appId);
  },

  getActiveAccount: (appId: string) => {
    const accts = get().accounts[appId];
    return accts?.find((a) => a.isActive);
  },

  getCredentials: async (appId: string, accountName: string) => {
    const res = await fetch(`${API}/${appId}/${encodeURIComponent(accountName)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
}));
