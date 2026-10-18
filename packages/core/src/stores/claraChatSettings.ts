/**
 * ClaraChat settings store — V1 stub for future Settings page.
 *
 * Default backend = Clara (via WebUI/LiteLLM). Power-users will be able to
 * later swap in their own LiteLLM endpoint or direct provider API in a
 * Settings UI; this hook surface is already model-agnostic so the UI is the
 * only piece left to add.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface ClaraChatSettingsStore {
  /** Model id sent to /v1/chat/completions (WebUI's `model` field). */
  model: string;
  /** Optional voice override for TTS — empty string = use server default. */
  ttsVoice: string;
  setModel: (model: string) => void;
  setTtsVoice: (voice: string) => void;
}

// LiteLLM alias for Clara's everyday routing, as defined in the LiteLLM
// gateway's model list.
// Changing this changes what model new chats default to; existing chats keep
// whatever was stored at create-time.
const DEFAULT_MODEL = "clara/everyday";
const DEFAULT_VOICE = "kerstin";

export const useClaraChatSettings = create<ClaraChatSettingsStore>()(
  persist(
    (set) => ({
      model: DEFAULT_MODEL,
      ttsVoice: DEFAULT_VOICE,
      setModel: (model: string) => set({ model: model || DEFAULT_MODEL }),
      setTtsVoice: (ttsVoice: string) => set({ ttsVoice: ttsVoice || DEFAULT_VOICE }),
    }),
    {
      // Bumped to .v2 so users with the old broken `clara-everyday-v1` model
      // cached in localStorage get a fresh default. Previous storage at
      // `claraChatSettings` becomes orphaned (~50 bytes — let it be GC'd by
      // browsers eventually).
      name: "claraChatSettings.v2",
    },
  ),
);
