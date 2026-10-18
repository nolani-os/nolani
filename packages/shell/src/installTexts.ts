// UI wording that would name this installation's own infrastructure. The
// product uses neutral wording; an installation sets its own in heim.config.ts
// (UI_TEXTS, optional).
export interface InstallTexts {
  /** Settings → push: requirement after the ntfy explanation ("" = none). */
  pushNetworkHint: string;
  /** File share dialog (not in a cell): who can reach a share link. */
  shareLinkReach: string;
  /** New user wizard: the mail admin secret is missing. */
  mailSecretMissing: string;
  /** File browser, device source: reachable, but SSH is not running. */
  deviceSshdDown: string;
  /** File browser, device source: offline. */
  deviceOffline: string;
}

const heimConfig = import.meta.glob<{ UI_TEXTS?: Partial<InstallTexts> }>("./heim.config.ts", { eager: true });

export const INSTALL_TEXTS: InstallTexts = {
  pushNetworkHint: "",
  shareLinkReach: "Erreichbar sind Links allerdings nur im lokalen Netz.",
  mailSecretMissing: "⚠ Stalwart-Admin-Secret fehlt — Mail wird übersprungen.",
  deviceSshdDown: "Auf dem Gerät den SSH-Dienst (sshd) starten.",
  deviceOffline: "Gerät einschalten und mit dem Netzwerk verbinden, dann erneut versuchen.",
  ...Object.values(heimConfig)[0]?.UI_TEXTS,
};
