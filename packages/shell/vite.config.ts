import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import svgr from "vite-plugin-svgr";
import path from "path";
import { createRequire } from "module";

// pdfjs-dist is only a dependency of react-pdf (pnpm does not put it in our
// node_modules) — resolve it through react-pdf for the worker import.
const reactPdfDir = path.dirname(createRequire(import.meta.filename).resolve("react-pdf/package.json"));
const pdfjsDir = path.dirname(
  createRequire(path.join(reactPdfDir, "package.json")).resolve("pdfjs-dist/package.json"),
);

export default defineConfig({
  plugins: [react(), svgr()],
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
    sourcemap: true,
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
