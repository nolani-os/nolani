import { create } from "zustand";
import type { User } from "../types";
import { hasPermission as checkPerm } from "../permissions";

interface AuthStore {
  user: User | null;
  loading: boolean;
  permissions: string[];
  setUser: (user: User) => void;
  loadUser: () => Promise<void>;
  hasPermission: (perm: string) => boolean;
  logout: () => void;
}

export const useAuthStore = create<AuthStore>()((set, get) => ({
  user: null,
  loading: true,
  permissions: [],

  setUser: (user) => set({ user, loading: false }),

  loadUser: async () => {
    try {
      const res = await fetch("/api/claraos/me");
      if (res.ok) {
        const data = await res.json();
        set({
          user: data,
          loading: false,
          // Admin gets wildcard permissions
          permissions: data.role === "admin" ? ["fs:*:manage", "app:*:launch", "service:*:send"] : [],
        });
      } else {
        set({ user: null, loading: false });
      }
    } catch {
      set({ user: null, loading: false });
    }
  },

  hasPermission: (perm) => {
    const { user, permissions } = get();
    if (!user) return false;
    if (user.role === "admin") return true;
    return checkPerm(permissions, perm);
  },

  logout: () => {
    const { user } = get();
    // Hand off to Authentik's invalidation flow. The browser navigates away,
    // session cookies are dropped, and a re-auth round-trip kicks the user
    // back to the start page. Fallback URL is the well-known default flow.
    const url = user?.logout_url ?? "/if/flow/default-invalidation-flow/";
    window.location.href = url;
  },
}));

/** Is this shell running in an external cell (hosted instance)? There is no
 *  home network there: no VPN, no VPN guest keys, no ntfy. */
export const useIstZelle = (): boolean => useAuthStore((s) => s.user?.profil === "cell");

export type { AuthStore };
