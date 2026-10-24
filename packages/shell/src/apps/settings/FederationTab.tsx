// Settings → Federation: "Verbundene Instanzen" (connected instances).
// Partner list with three-layer status lights + pairing wizard.
import { useCallback, useEffect, useState } from "react";
import {
  connectPartner,
  disconnectPartner,
  fetchPartners,
  mintPairingCode,
  probePartner,
  type FederationPartner,
  type LayerState,
  type TrustLevel,
} from "./federationApi";
import { Button } from "../../components/Button";
import { useTranslation } from "@claraos/core";
import styles from "./FederationTab.module.css";

function Ampel({ label, state, detail }: { label: string; state?: LayerState; detail?: string }) {
  const s = state ?? "n/a";
  return (
    <span className={styles.ampel} title={detail ? `${label}: ${s} — ${detail}` : `${label}: ${s}`}>
      <span className={styles.ampelPunkt} data-zustand={s} aria-hidden="true" />
      {label}
    </span>
  );
}

export function FederationTab() {
  const { t } = useTranslation("settingsTabs");
  const [partners, setPartners] = useState<FederationPartner[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pairing, setPairing] = useState<{ code: string; expires_in: number } | null>(null);
  // connect form
  const [showConnect, setShowConnect] = useState(false);
  const [fName, setFName] = useState("");
  const [fDomain, setFDomain] = useState("");
  const [fCode, setFCode] = useState("");
  const [fTrust, setFTrust] = useState<TrustLevel>("partial");

  const refresh = useCallback(() => {
    setError(null);
    fetchPartners()
      .then(setPartners)
      .catch((e) => setError(String(e?.message ?? e)));
  }, []);

  useEffect(() => refresh(), [refresh]);

  const handleMintCode = async () => {
    setError(null);
    try {
      const r = await mintPairingCode();
      setPairing({ code: r.code, expires_in: r.expires_in });
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  };

  const handleConnect = async () => {
    if (!fName.trim() || !fDomain.trim() || !fCode.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await connectPartner({
        name: fName.trim(),
        base_domain: fDomain.trim(),
        pairing_code: fCode.trim(),
        trust_level: fTrust,
      });
      setShowConnect(false);
      setFName(""); setFDomain(""); setFCode("");
      refresh();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const handleProbe = async (id: string) => {
    setError(null);
    try {
      await probePartner(id);
      refresh();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  };

  const handleDisconnect = async (p: FederationPartner) => {
    if (!confirm(t("federation.confirmDisconnect", { name: p.name, domain: p.base_domain }))) return;
    setError(null);
    try {
      await disconnectPartner(p.id);
      refresh();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  };

  return (
    <div className={styles.seite}>
      <div className={styles.kopf}>
        <h3>{t("federation.title")}</h3>
        <p>{t("federation.intro")}</p>
      </div>

      {error && <div className={`${styles.karte} ${styles.karteFehler}`} role="alert">{error}</div>}

      {/* Pairing code generator (on the side being joined) */}
      <div className={styles.karte}>
        <div className={styles.kartenTitel}>{t("federation.pairTitle")}</div>
        <div className={styles.kartenText}>{t("federation.pairText")}</div>
        <div className={styles.zeile}>
          <Button stufe="filled" groesse="s" icon="link" onClick={handleMintCode}>{t("federation.mintCode")}</Button>
          {pairing && <code className={styles.code}>{pairing.code}</code>}
          {pairing && <span className={styles.hinweis}>{t("federation.validFor", { minutes: Math.round(pairing.expires_in / 60) })}</span>}
        </div>
      </div>

      {/* Connect-Wizard */}
      <div className={styles.karte}>
        <div className={styles.zeileZwischen}>
          <span className={styles.kartenTitel}>{t("federation.connectTitle")}</span>
          <Button stufe={showConnect ? "text" : "tonal"} groesse="s" icon={showConnect ? "close" : "plus"}
                  onClick={() => setShowConnect((v) => !v)}>
            {showConnect ? t("federation.cancel") : t("federation.connect")}
          </Button>
        </div>
        {showConnect && (
          <div className={styles.formular}>
            <input placeholder={t("federation.namePlaceholder")} value={fName}
                   onChange={(e) => setFName(e.target.value)} />
            <input placeholder={t("federation.domainPlaceholder")} value={fDomain}
                   onChange={(e) => setFDomain(e.target.value)} />
            <input placeholder={t("federation.codePlaceholder")} value={fCode}
                   onChange={(e) => setFCode(e.target.value)} />
            <select value={fTrust} onChange={(e) => setFTrust(e.target.value as TrustLevel)}>
              <option value="partial">{t("federation.trustPartial")}</option>
              <option value="full">{t("federation.trustFull")}</option>
              <option value="per_app">{t("federation.trustPerApp")}</option>
            </select>
            <div className={styles.zeile}>
              <Button stufe="filled" groesse="s" onClick={handleConnect}
                      disabled={busy || !fName.trim() || !fDomain.trim() || !fCode.trim()}>
                {busy ? t("federation.connecting") : t("federation.establish")}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Partner list */}
      {partners === null ? (
        <div className={styles.leer}>{t("federation.loading")}</div>
      ) : partners.length === 0 ? (
        <div className={`${styles.karte} ${styles.leer}`}>{t("federation.empty")}</div>
      ) : (
        partners.map((p) => (
          <div key={p.id} className={styles.karte}>
            <div className={styles.zeileZwischen}>
              <span className={styles.partnerName}>{p.name}</span>
              <span className={styles.partnerTrust}>{p.trust_level}</span>
            </div>
            <div className={styles.kartenText}>{p.base_domain}</div>
            <div className={styles.ampeln}>
              <Ampel label="OIDC" state={p.status.oidc?.state} detail={p.status.oidc?.detail} />
              <Ampel label="Matrix" state={p.status.matrix?.state} detail={p.status.matrix?.detail} />
              <Ampel label="Nextcloud" state={p.status.nextcloud?.state} detail={p.status.nextcloud?.detail} />
            </div>
            <div className={styles.zeile}>
              <Button stufe="tonal" groesse="s" icon="reload" onClick={() => handleProbe(p.id)}>{t("federation.probe")}</Button>
              <Button stufe="danger" groesse="s" icon="close" onClick={() => handleDisconnect(p)}>{t("federation.disconnect")}</Button>
            </div>
            {p.status.probed_at && (
              <div className={styles.fussnote}>{t("federation.lastProbed", { time: p.status.probed_at })}</div>
            )}
          </div>
        ))
      )}
    </div>
  );
}
