/**
 * VoiceBubble — floating popup that hosts the unified ClaraChatPanel in
 * voice-mode (mic auto-starts, response speaks back through WebUI/Speaches).
 *
 * Replaced legacy Web-Speech-API + custom Clara fetch (older code).
 * The taskbar mic-button still toggles `useVoiceStore.active` to show / hide
 * this bubble; the bubble itself wires the recording into ClaraChatPanel.
 */
import { useCallback, type CSSProperties } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useVoiceStore } from "@claraos/core";
import { ClaraChatPanel } from "../Chat";
import styles from "./VoiceBubble.module.css";

export function VoiceBubble() {
  const active = useVoiceStore((s) => s.active);
  // live level → cyan rim glow (VoiceBubble.module.css --mic-level)
  const micLevel = useVoiceStore((s) => s.micLevel);
  const stopListening = useVoiceStore((s) => s.stopListening);

  const handleClose = useCallback(() => {
    stopListening();
  }, [stopListening]);

  return (
    <AnimatePresence>
      {active && (
        <motion.div
          className={styles.bubble}
          style={{ "--mic-level": micLevel } as CSSProperties}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
          transition={{ duration: 0.2 }}
          data-no-drag
        >
          <ClaraChatPanel variant="quick" autoRecord onClose={handleClose} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
