// Photorealistic weather graphics (SDXL-generated, background-removed, WebP with
// alpha). Mapped from Bright Sky / DWD condition codes. These replace the vector
// Meteocons for a realistic, rendered look matching the reference design.
import sun from "./sun.webp";
import cloud from "./cloud.webp";
import partly from "./partly.webp";
import rain from "./rain.webp";
import snow from "./snow.webp";
import storm from "./storm.webp";

const BY_CODE: Record<string, string> = {
  "clear-day": sun,
  "clear-night": sun, // no dedicated moon asset yet
  "partly-cloudy-day": partly,
  "partly-cloudy-night": partly,
  "cloudy": cloud,
  "fog": cloud,
  "wind": cloud,
  "rain": rain,
  "sleet": rain,
  "hail": rain,
  "snow": snow,
  "thunderstorm": storm,
};

/** WebP URL of the photorealistic graphic for a Bright Sky icon code
 *  (cloud fallback for unknown/empty). */
export function weatherPhoto(code: string | null | undefined): string {
  return (code && BY_CODE[code]) || cloud;
}
