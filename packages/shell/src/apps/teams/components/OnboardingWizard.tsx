import { useState } from "react";
import { createSpace, createChannel } from "../matrixClient";
import styles from "./OnboardingWizard.module.css";
import { useTranslation } from "@claraos/core";

export function OnboardingWizard({ onComplete }: { onComplete: () => void }) {
  const { t } = useTranslation("teams");
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
          <h2>{t("onboarding.welcome")}</h2>
          <p>{t("onboarding.intro")}</p>
          <p className={styles.subtitle}>{t("onboarding.basis")}</p>
          <button className={styles.primaryBtn} onClick={() => setStep(1)}>
            {t("onboarding.start")}
          </button>
        </div>
      )}

      {step === 1 && (
        <div className={styles.step}>
          <div className={styles.emoji}>👥</div>
          <h2>{t("onboarding.firstTeam")}</h2>
          <p>{t("onboarding.teamIntro")}</p>
          <input
            autoFocus
            className={styles.input}
            placeholder={t("onboarding.teamPlaceholder")}
            value={teamName}
            onChange={(e) => setTeamName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && teamName.trim() && setStep(2)}
          />
          <button
            className={styles.primaryBtn}
            onClick={() => setStep(2)}
            disabled={!teamName.trim()}
          >
            {t("onboarding.next")}
          </button>
        </div>
      )}

      {step === 2 && (
        <div className={styles.step}>
          <div className={styles.emoji}>#</div>
          <h2>{t("onboarding.addChannel")}</h2>
          <p>{t("onboarding.channelIntro")}</p>
          <input
            autoFocus
            className={styles.input}
            placeholder={t("onboarding.channelPlaceholder")}
            value={channelName}
            onChange={(e) => setChannelName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          />
          <button
            className={styles.primaryBtn}
            onClick={handleCreate}
            disabled={creating}
          >
            {creating ? t("onboarding.creating") : t("onboarding.create", { team: teamName, channel: channelName })}
          </button>
          <button className={styles.skipBtn} onClick={onComplete}>
            {t("onboarding.later")}
          </button>
        </div>
      )}
    </div>
  );
}
