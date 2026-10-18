import { create } from "zustand";

/** Full voice-pipeline state as surfaced to voice UIs (orb, bubble).
 *  Defined here (not in the shell) so core has no shell import. */
export type VoiceUiState =
  | "idle"
  | "arming"        // getUserMedia pending — mic not live yet
  | "recording"
  | "transcribing"
  | "thinking"      // Clara is streaming a reply (voice mode)
  | "speaking";     // TTS playback

export interface VoiceStore {
  active: boolean;
  recording: boolean;
  transcript: string;
  muted: boolean;         // Clara's voice output muted
  speaking: boolean;      // Clara is currently speaking
  state: VoiceUiState;    // fine-grained state (recording/speaking stay in sync)
  micLevel: number;       // 0..1 smoothed input level while recording
  error: string | null;   // mic/pipeline error to surface on the voice UI

  startListening: () => void;
  stopListening: () => void;
  setRecording: (r: boolean) => void;
  setTranscript: (t: string) => void;
  clearTranscript: () => void;
  toggleMute: () => void;
  setSpeaking: (s: boolean) => void;
  setVoiceUi: (p: Partial<{ state: VoiceUiState; error: string | null }>) => void;
  setMicLevel: (l: number) => void;
}

export const useVoiceStore = create<VoiceStore>()((set) => ({
  active: false,
  recording: false,
  transcript: "",
  muted: false,
  speaking: false,
  state: "idle",
  micLevel: 0,
  error: null,

  startListening: () => set({ active: true, recording: true, transcript: "" }),
  stopListening: () => set({ recording: false }),
  setRecording: (recording) => set({ recording }),
  setTranscript: (transcript) => set({ transcript }),
  clearTranscript: () => set({ transcript: "", active: false }),
  toggleMute: () => set((s) => ({ muted: !s.muted })),
  setSpeaking: (speaking) => set({ speaking }),
  setVoiceUi: (p) =>
    set((s) => {
      const state = p.state ?? s.state;
      return {
        state,
        error: p.error !== undefined ? p.error : s.error,
        // keep the legacy booleans coherent with the fine-grained state
        recording: state === "recording",
        speaking: state === "speaking",
        micLevel: state === "recording" ? s.micLevel : 0,
      };
    }),
  setMicLevel: (micLevel) => set({ micLevel }),
}));
