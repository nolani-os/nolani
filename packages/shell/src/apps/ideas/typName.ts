/** Display name of an object type.
 *
 * The built-in types (`is_system`, seeded by the API as "Idee", "Notiz", …)
 * are translated by id; self-made types are user data and keep their name. */
import { i18n } from "@claraos/core";

export function typName(typ: { id: string; name: string; is_system?: boolean }): string {
  return typ.is_system ? i18n.t(`wissen:objType.${typ.id}`, { defaultValue: typ.name }) : typ.name;
}

/** Same, when only the type id is known (e.g. search hits). */
export function typNameVonId(id: string): string {
  return i18n.t(`wissen:objType.${id}`, { defaultValue: id });
}
