import { createCorporateSkin } from "../createCorporateSkin";

// Asset URLs resolved by Vite at build time
import stylesheetUrl from "../stylesheet.css?url";
import logoUrl from "./logo.svg?url";
import wallpaperUrl from "./wallpaper.jpg";

// === The Medical Company — the example tenant of the corporate template ===
// White, clinic blue and a teal signal colour; logo: a white cross in a
// circle split blue/teal (own design). Wallpaper: an own render of white and
// teal glass waves with a calm area on the left for the desktop icons.

export const corporateMedicalWallpaper = wallpaperUrl;
export const corporateMedicalLogo = logoUrl;

export const corporateMedicalSkin = createCorporateSkin({
  id: "corporate-medical",
  companyName: "The Medical Company",
  tagline: "Nolani Workspace",
  logo: logoUrl,
  primary: "#0b4f8a",
  accent: "#0fa3a3",
  wallpaper: wallpaperUrl,
  stylesheet: stylesheetUrl,
});
