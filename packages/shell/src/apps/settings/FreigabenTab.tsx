/**
 * "Clara-Freigaben" (Clara permissions) — the "always" rules of the
 * confirmation card.
 *
 * Tapping "Always for <target>" on the card creates a rule: this tool with
 * this target runs without asking from now on. A permission nobody can see
 * any more would be an invisible power of attorney — so every rule is listed
 * here with tool, target and date, and each one can be deleted.
 * Endpoints: GET/DELETE /api/claraos/confirm/rules (own user only).
 */
import { useCallback, useEffect, useState } from "react";
import styles from "./ClaraMemoryTab.module.css";
import { regionLocale, useTranslation } from "@claraos/core";

interface Regel {
  id: number;
  tool: string;
  ziel: string;
  created_at?: string | null;
}

function werkzeugName(tool: string): string {
  // claraos_modules_vault__get_credential → vault › get credential ; device labels are returned unchanged
  if (tool.startsWith("Gerät:")) return tool;
  return tool
    .replace(/^claraos_modules_/, "")
    .replace(/__/g, " › ")
    .replace(/_/g, " ");
}

function datum(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(regionLocale(), { day: "numeric", month: "short", year: "numeric" });
}

export function FreigabenTab() {
  const { t } = useTranslation("settingsTabs");
  const [regeln, setRegeln] = useState<Regel[]>([]);
  const [status, setStatus] = useState<"laden" | "bereit" | "fehler">("laden");
  const [loescheId, setLoescheId] = useState<number | null>(null);

  const laden = useCallback(async () => {
    try {
      const r = await fetch("/api/claraos/confirm/rules", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setRegeln(Array.isArray(d.rules) ? d.rules : []);
      setStatus("bereit");
    } catch {
      setStatus("fehler");
    }
  }, []);
  useEffect(() => { void laden(); }, [laden]);

  const loeschen = async (id: number) => {
    setLoescheId(id);
    try {
      const r = await fetch(`/api/claraos/confirm/rules/${id}`, { method: "DELETE", credentials: "include" });
      if (r.ok) setRegeln((rs) => rs.filter((x) => x.id !== id));
    } finally {
      setLoescheId(null);
    }
  };

  return (
    <div className={styles.wrap} data-settings-tab="freigaben">
      <p className={styles.hint}>{t("permissions.intro")}</p>
      {status === "laden" && <p className={styles.meta}>{t("permissions.loading")}</p>}
      {status === "fehler" && <p className={styles.error}>{t("permissions.loadError")}</p>}
      {status === "bereit" && regeln.length === 0 && (
        <div className={styles.empty}>{t("permissions.empty")}</div>
      )}
      {regeln.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
          {regeln.map((r) => (
            <li key={r.id} className={styles.field} data-regel-id={r.id}>
              <div className={styles.fieldHead}>
                <div>
                  <div className={styles.label}>{werkzeugName(r.tool)}</div>
                  <p className={styles.meta}>
                    {t("permissions.target", { target: r.ziel === "*" ? t("permissions.all") : r.ziel })}
                    {datum(r.created_at) ? ` · ${t("permissions.since", { date: datum(r.created_at) })}` : ""}
                  </p>
                </div>
                <button
                  type="button"
                  className={styles.danger}
                  disabled={loescheId === r.id}
                  onClick={() => void loeschen(r.id)}
                  aria-label={t("permissions.deleteLabel", { tool: werkzeugName(r.tool) })}
                >
                  {loescheId === r.id ? "…" : t("permissions.delete")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className={styles.meta}>{t("permissions.footer")}</p>
    </div>
  );
}
