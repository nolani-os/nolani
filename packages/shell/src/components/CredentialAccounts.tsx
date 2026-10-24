/**
 * A user's credentials for one app — list of accounts plus form.
 *
 * Why this component exists: the same UI used to be rendered only in the app
 * center. The app center explicitly hides third-party services (`hubService`),
 * and the services hub only knew Vaultwarden entries for browser logins. As a
 * result, a third-party service with **its own API access per user** (Notion)
 * had **no place** where a user could enter their token — the integration only
 * worked for someone whose value had been put into the database by hand.
 *
 * Deliberately extracted instead of copied: the app center and the services hub
 * are meant to be merged later. Two copies of the same form would drift apart
 * until then — and make the merge more expensive, not cheaper.
 *
 * The values go through `useCredentialsStore` to `/api/claraos/credentials/*`
 * and are stored there **encrypted per user**. This component never sees
 * anyone else's.
 */
import { useEffect, useState } from "react";
import { useCredentialsStore, useTranslation, type AppAccount, type CredentialSlot } from "@claraos/core";
import styles from "./CredentialAccounts.module.css";

const LEER: AppAccount[] = [];

export function CredentialAccounts({
  appId,
  slots,
  hinweisOhneFelder,
}: {
  appId: string;
  slots: CredentialSlot[];
  /** Text shown when the app declares no credential fields at all (e.g. "signs in via SSO"). */
  hinweisOhneFelder?: string;
}) {
  const kontenRoh = useCredentialsStore((s) => s.accounts[appId]);
  const konten = kontenRoh || LEER;
  const ladeKonten = useCredentialsStore((s) => s.loadAccounts);
  const speichern = useCredentialsStore((s) => s.saveCredentials);
  const aktualisieren = useCredentialsStore((s) => s.updateCredentials);
  const loeschen = useCredentialsStore((s) => s.deleteAccount);
  const aktivieren = useCredentialsStore((s) => s.activateAccount);

  const [formOffen, setFormOffen] = useState(false);
  const [bearbeitet, setBearbeitet] = useState<string | null>(null);
  const [kontoname, setKontoname] = useState("");
  const [werte, setWerte] = useState<Record<string, string>>({});
  const [speichertGerade, setSpeichertGerade] = useState(false);
  const [fehler, setFehler] = useState("");
  const [sichtbar, setSichtbar] = useState<Record<string, boolean>>({});
  const { t } = useTranslation("components");

  useEffect(() => { ladeKonten(appId); }, [appId, ladeKonten]);

  if (slots.length === 0) {
    return <p className={styles.hinweis}>{hinweisOhneFelder || t("accounts.noFields")}</p>;
  }

  const zuruecksetzen = () => {
    setFormOffen(false); setBearbeitet(null); setWerte({}); setSichtbar({}); setFehler("");
  };

  const sichern = async () => {
    setSpeichertGerade(true); setFehler("");
    try {
      if (bearbeitet) await aktualisieren(appId, bearbeitet, werte);
      else await speichern(appId, kontoname.trim() || t("accounts.defaultAccountName"), werte);
      zuruecksetzen();
    } catch (e) {
      setFehler((e as Error).message);
    }
    setSpeichertGerade(false);
  };

  const bearbeiten = async (name: string) => {
    setBearbeitet(name); setFormOffen(true); setSichtbar({});
    try {
      setWerte(await useCredentialsStore.getState().getCredentials(appId, name));
    } catch {
      setWerte({});
    }
  };

  return (
    <div className={styles.wurzel}>
      <div className={styles.kopf}>
        <h4 className={styles.titel}>{t("accounts.heading", { count: konten.length })}</h4>
        {!formOffen && (
          <button
            className={styles.primaer}
            onClick={() => { setBearbeitet(null); setKontoname(""); setWerte({}); setFormOffen(true); setSichtbar({}); }}
          >
            {t("accounts.add")}
          </button>
        )}
      </div>

      {konten.map((k) => (
        <div key={k.accountName} className={`${styles.zeile} ${k.isActive ? styles.aktiv : ""}`}>
          <span className={styles.punkt} aria-hidden="true">{k.isActive ? "●" : "○"}</span>
          <span className={styles.name}>{k.accountName}</span>
          {k.isActive && <span className={styles.marke}>{t("accounts.inUse")}</span>}
          <div className={styles.aktionen}>
            {!k.isActive && (
              <button className={styles.klein} onClick={() => aktivieren(appId, k.accountName)}>
                {t("accounts.use")}
              </button>
            )}
            <button className={styles.klein} onClick={() => bearbeiten(k.accountName)}>{t("accounts.edit")}</button>
            <button
              className={styles.kleinGefahr}
              aria-label={t("accounts.deleteLabel", { name: k.accountName })}
              onClick={() => { if (confirm(t("accounts.deleteConfirm", { name: k.accountName }))) loeschen(appId, k.accountName); }}
            >
              {t("accounts.delete")}
            </button>
          </div>
        </div>
      ))}

      {konten.length === 0 && !formOffen && (
        <p className={styles.hinweis}>
          {t("accounts.empty")}
        </p>
      )}

      {formOffen && (
        <div className={styles.form}>
          <h5 className={styles.formTitel}>{bearbeitet ? t("accounts.editTitle", { name: bearbeitet }) : t("accounts.newTitle")}</h5>

          {!bearbeitet && (
            <label className={styles.feld}>
              <span className={styles.beschriftung}>{t("accounts.nameLabel")}</span>
              <input
                className={styles.eingabe}
                placeholder={t("accounts.namePlaceholder")}
                value={kontoname}
                onChange={(e) => setKontoname(e.target.value)}
              />
            </label>
          )}

          {slots.map((slot) => (
            <label key={slot.key} className={styles.feld}>
              <span className={styles.beschriftung}>
                {slot.label} {slot.required && <span className={styles.pflicht} aria-label={t("accounts.required")}>*</span>}
              </span>
              <div className={styles.eingabeZeile}>
                <input
                  className={styles.eingabe}
                  type={slot.type === "password" && !sichtbar[slot.key] ? "password" : "text"}
                  placeholder={slot.type === "url" ? "https://…" : ""}
                  value={werte[slot.key] || ""}
                  onChange={(e) => setWerte({ ...werte, [slot.key]: e.target.value })}
                />
                {slot.type === "password" && (
                  <button
                    type="button"
                    className={styles.eingabeKnopf}
                    aria-label={sichtbar[slot.key] ? t("accounts.hideValue") : t("accounts.showValue")}
                    onClick={() => setSichtbar((v) => ({ ...v, [slot.key]: !v[slot.key] }))}
                  >
                    {sichtbar[slot.key] ? t("accounts.hide") : t("accounts.show")}
                  </button>
                )}
              </div>
            </label>
          ))}

          {fehler && <p className={styles.fehler} role="alert">{fehler}</p>}

          <div className={styles.formAktionen}>
            <button className={styles.primaer} onClick={sichern} disabled={speichertGerade}>
              {speichertGerade ? t("accounts.saving") : t("accounts.save")}
            </button>
            <button className={styles.sekundaer} onClick={zuruecksetzen}>{t("accounts.cancel")}</button>
          </div>
        </div>
      )}
    </div>
  );
}
