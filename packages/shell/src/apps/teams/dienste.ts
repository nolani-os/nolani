import { getBrand } from "@claraos/core";
/**
 * Where does a chat come from?
 *
 * Chats should be distinguishable by the icon of their service (Signal,
 * ClaraOS, …). For that the UI must be able to tell, per room, which service
 * it runs over.
 *
 * The answer lies in the **members**. A mautrix bridge creates a ghost account
 * in its own namespace for every contact (`@signal_<id>:example.com`,
 * `@whatsapp_…`, `@telegram_…`) and puts a bridge bot into the room. If such a
 * member is present, the room is bridged — everything else is a conversation
 * native to this server.
 *
 * Note: this detection is prepared but not verified end to end. Without running
 * mautrix bridges registered for the current homeserver domain there are no
 * bridge accounts, and every room is reported as "claraos".
 */

export type Dienst = "claraos" | "signal" | "whatsapp" | "telegram";

/** Namespace prefixes as mautrix assigns them by default. */
const PRAEFIXE: { dienst: Dienst; praefix: string; bot: string }[] = [
  { dienst: "signal", praefix: "@signal_", bot: "@signalbot:" },
  { dienst: "whatsapp", praefix: "@whatsapp_", bot: "@whatsappbot:" },
  { dienst: "telegram", praefix: "@telegram_", bot: "@telegrambot:" },
];

export const DIENST_NAME: Record<Dienst, string> = {
  get claraos() { return getBrand().product; },
  signal: "Signal",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
};

/**
 * Service of a room, based on its members.
 * @param members MXIDs of the joined members (from the Matrix store).
 */
export function dienstDesRaums(members: string[] | undefined): Dienst {
  if (!members || members.length === 0) return "claraos";
  for (const m of members) {
    const klein = m.toLowerCase();
    for (const p of PRAEFIXE) {
      if (klein.startsWith(p.praefix) || klein.startsWith(p.bot)) return p.dienst;
    }
  }
  return "claraos";
}
