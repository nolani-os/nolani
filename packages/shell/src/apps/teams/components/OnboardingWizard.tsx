import { useState } from "react";
import { createSpace, createChannel } from "../matrixClient";
import styles from "./OnboardingWizard.module.css";

export function OnboardingWizard({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState(0);
  const [teamName, setTeamName] = useState("");
  const [channelName, setChannelName] = useState("general");
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    if (!teamName.trim()) return;
    setCreating(true);
    try {
      const spaceId = await createSpace(teamName.trim());
      if (spaceId && channelName.trim()) {
        await createChannel(spaceId, channelName.trim());
      }
      onComplete();
    } catch {
      setCreating(false);
    }
  };

  return (
    <div className={styles.wizard}>
      {step === 0 && (
        <div className={styles.step}>
          <div className={styles.emoji}>👋</div>
          <h2>Willkommen bei Teams</h2>
          <p>Dein eigener Ort für Zusammenarbeit — Chat, Anrufe, Dateien und Planung an einer Stelle.</p>
          <p className={styles.subtitle}>Auf Basis von Matrix (Ende-zu-Ende-verschlüsselt), LiveKit (Videoanrufe) und Nextcloud (Dateien).</p>
          <button className={styles.primaryBtn} onClick={() => setStep(1)}>
            Los geht's
          </button>
        </div>
      )}

      {step === 1 && (
        <div className={styles.step}>
          <div className={styles.emoji}>👥</div>
          <h2>Erstes Team anlegen</h2>
          <p>Ein Team ist eine Gruppe von Menschen, die zusammenarbeiten oder sich austauschen.</p>
          <input
            autoFocus
            className={styles.input}
            placeholder="z. B. Familie, Haushalt, Arbeit…"
            value={teamName}
            onChange={(e) => setTeamName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && teamName.trim() && setStep(2)}
          />
          <button
            className={styles.primaryBtn}
            onClick={() => setStep(2)}
            disabled={!teamName.trim()}
          >
            Weiter
          </button>
        </div>
      )}

      {step === 2 && (
        <div className={styles.step}>
          <div className={styles.emoji}>#</div>
          <h2>Kanal hinzufügen</h2>
          <p>Kanäle ordnen Gespräche nach Thema.</p>
          <input
            autoFocus
            className={styles.input}
            placeholder="z. B. allgemein, sonstiges, projekte…"
            value={channelName}
            onChange={(e) => setChannelName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          />
          <button
            className={styles.primaryBtn}
            onClick={handleCreate}
            disabled={creating}
          >
            {creating ? "Wird angelegt…" : `„${teamName}“ mit #${channelName} anlegen`}
          </button>
          <button className={styles.skipBtn} onClick={onComplete}>
            Später einrichten
          </button>
        </div>
      )}
    </div>
  );
}
