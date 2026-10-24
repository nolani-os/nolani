import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import svgr from "vite-plugin-svgr";
import path from "path";
import { createRequire } from "module";
import fs from "fs";

// pdfjs-dist is only a dependency of react-pdf (pnpm does not put it in our
// node_modules) — resolve it through react-pdf for the worker import.
const reactPdfDir = path.dirname(createRequire(import.meta.filename).resolve("react-pdf/package.json"));
const pdfjsDir = path.dirname(
  createRequire(path.join(reactPdfDir, "package.json")).resolve("pdfjs-dist/package.json"),
);

// Product name for the static files (page title, PWA manifest), which exist before
// any JavaScript runs: the installation's own name from src/heim.config.ts (BRAND),
// otherwise the product's (core/src/brand.ts).
function productName(): string {
  try {
    const cfg = fs.readFileSync(path.join(import.meta.dirname, "src/heim.config.ts"), "utf8");
    return /BRAND\s*=\s*\{\s*product:\s*"([^"]+)"/.exec(cfg)?.[1] ?? "NolaniOS";
  } catch {
    return "NolaniOS";
  }
}

function brandStatic() {
  const name = productName();
  return {
    name: "brand-static",
    transformIndexHtml: (html: string) => html.replaceAll("%PRODUCT_NAME%", name),
    closeBundle() {
      const file = path.join(import.meta.dirname, "dist/manifest.webmanifest");
      if (fs.existsSync(file)) {
        fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll("%PRODUCT_NAME%", name));
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), svgr(), brandStatic()],
  resolve: {
    alias: {
      "@claraos/core": path.resolve(import.meta.dirname, "../core/src"),
      "@claraos/skins": path.resolve(import.meta.dirname, "../skins/src"),
      "pdfjs-dist": pdfjsDir,
    },
  },
  css: {
    modules: {
      localsConvention: "camelCase",
    },
  },
  server: {
    port: 3000,
    host: true,
  },
  build: {
    outDir: "dist",
    // /assets/* is served without login: maps would expose installation-specific
    // sources (e.g. heim.config.ts) to anyone. Enable locally when debugging.
    sourcemap: false,
    rollupOptions: {
      output: {
        // Force unique filenames on every build to bust browser cache
        entryFileNames: `assets/[name]-[hash]-${Date.now()}.js`,
        chunkFileNames: `assets/[name]-[hash].js`,
        // The frontend nginx serves .mjs as application/octet-stream, so a module worker
        // (pdf.js) would be refused. Emit such assets as .js instead.
        assetFileNames: (info) =>
          [info.name, ...(info.names ?? [])].some((n) => n?.endsWith(".mjs"))
            ? "assets/[name]-[hash].js"
            : "assets/[name]-[hash].[ext]",
      },
    },
  },
});
