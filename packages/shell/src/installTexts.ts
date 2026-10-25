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

import { i18n } from "@claraos/core";

const heimConfig = import.meta.glob<{ UI_TEXTS?: Partial<InstallTexts> }>("./heim.config.ts", { eager: true });

const overrides: Partial<InstallTexts> = Object.values(heimConfig)[0]?.UI_TEXTS ?? {};

/** Neutral defaults come from the catalog (`common:install.*`), read at use time. */
function text(key: keyof InstallTexts): string {
  return overrides[key] ?? i18n.t(`common:install.${key}`);
}

export const INSTALL_TEXTS: InstallTexts = {
  get pushNetworkHint() { return overrides.pushNetworkHint ?? ""; },
  get shareLinkReach() { return text("shareLinkReach"); },
  get mailSecretMissing() { return text("mailSecretMissing"); },
  get deviceSshdDown() { return text("deviceSshdDown"); },
  get deviceOffline() { return text("deviceOffline"); },
};
