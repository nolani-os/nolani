/**
 * Names users see: the product and its assistant.
 *
 * The product ships as NolaniOS with the assistant Nolani. An installation
 * renames both — at build time (the shell's installation config, so the first
 * paint is already right) and at runtime (`brand` in /api/claraos/me, so a cell
 * can rename its assistant without a rebuild).
 *
 * Translations reference them as `{{product}}` / `{{assistant}}`; code uses
 * `getBrand()` (outside React) or `useBrand()` (re-renders on a rename).
 */
import i18next from "i18next";
import { create } from "zustand";

export interface Brand {
  product: string;
  assistant: string;
}

export const DEFAULT_BRAND: Brand = { product: "NolaniOS", assistant: "Nolani" };

const useBrandStore = create<Brand>()(() => DEFAULT_BRAND);

export const useBrand = (): Brand => useBrandStore();

export const getBrand = (): Brand => useBrandStore.getState();

/** Interpolation defaults for i18next (`{{product}}`, `{{assistant}}`). */
export const brandVariables = (): Record<string, string> => ({ ...getBrand() });

/** Apply a (partial) brand; empty values keep the current name. */
export function setBrand(b: Partial<Brand> | null | undefined): void {
  const cur = getBrand();
  const next: Brand = {
    product: b?.product?.trim() || cur.product,
    assistant: b?.assistant?.trim() || cur.assistant,
  };
  if (next.product === cur.product && next.assistant === cur.assistant) return;
  useBrandStore.setState(next, true);
  if (typeof document !== "undefined") document.title = next.product;
  if (i18next.isInitialized) {
    i18next.options.interpolation = { ...i18next.options.interpolation, defaultVariables: brandVariables() };
    // Re-render everything that translated with the old names.
    void i18next.changeLanguage(i18next.language);
  }
}
