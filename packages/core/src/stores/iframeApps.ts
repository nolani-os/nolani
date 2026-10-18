/**
 * Iframe-app bridge store — tracks the live state of iframe-based ClaraOS
 * apps that opted into the postMessage protocol (unified clara-chat).
 *
 * Each entry is keyed by `windowId` and updated by the bridge layer in
 * `packages/shell/src/Chat/iframeBridge.ts` whenever the iframe sends a
 * handshake / context update.
 *
 * Consumed by:
 *  - `useChatAppContext` (ClaraChatPanel) — for inline-chat meta enrichment
 *  - `wrappActionHandler` — for generic Action-Bus → iframe forwarding
 *  - `Window.tsx` — to allow the Clara-toggle on iframe apps that registered
 */
import { create } from "zustand";

export interface IframeAppContext {
  /** App-level id (e.g. "nextcloud-files", "code-server"). */
  appId: string;
  /** Free-form capabilities array reported by the iframe. */
  capabilities: string[];
  /** Free-form context dict (e.g. {selected_file, current_view, …}). */
  context: Record<string, unknown>;
  /** True once the iframe acked our hello with a ready message. */
  ready: boolean;
  /** Last context-update timestamp (ms since epoch). */
  updatedAt: number;
}

interface IframeAppStore {
  /** windowId → context */
  apps: Record<string, IframeAppContext>;
  setReady: (windowId: string, appId: string, capabilities: string[]) => void;
  setContext: (windowId: string, context: Record<string, unknown>) => void;
  remove: (windowId: string) => void;
  get: (windowId: string) => IframeAppContext | undefined;
}

export const useIframeAppStore = create<IframeAppStore>()((set, get) => ({
  apps: {},

  setReady: (windowId, appId, capabilities) => {
    set((s) => ({
      apps: {
        ...s.apps,
        [windowId]: {
          appId,
          capabilities,
          context: s.apps[windowId]?.context ?? {},
          ready: true,
          updatedAt: Date.now(),
        },
      },
    }));
  },

  setContext: (windowId, context) => {
    set((s) => {
      const prev = s.apps[windowId];
      if (!prev) {
        // Out-of-order context update — accept but mark not-ready
        return {
          apps: {
            ...s.apps,
            [windowId]: {
              appId: "unknown",
              capabilities: [],
              context,
              ready: false,
              updatedAt: Date.now(),
            },
          },
        };
      }
      return {
        apps: {
          ...s.apps,
          [windowId]: {
            ...prev,
            context: { ...prev.context, ...context },
            updatedAt: Date.now(),
          },
        },
      };
    });
  },

  remove: (windowId) => {
    set((s) => {
      if (!s.apps[windowId]) return s;
      const next = { ...s.apps };
      delete next[windowId];
      return { apps: next };
    });
  },

  get: (windowId) => get().apps[windowId],
}));
