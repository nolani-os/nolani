// Vite config for the skin-bars harness (run from packages/shell):
//   npx vite build --config test/skin-bars/vite.config.mjs
//   npx vite preview --config test/skin-bars/vite.config.mjs --port 8798
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import svgr from "vite-plugin-svgr";
import path from "path";
import { createRequire } from "module";

const shell = path.resolve(import.meta.dirname, "../..");
// pdfjs-dist is only a dependency of react-pdf (pnpm does not put it in our
// node_modules) — same resolution as the shell's vite.config.ts.
const reactPdfDir = path.dirname(createRequire(path.join(shell, "package.json")).resolve("react-pdf/package.json"));
const pdfjsDir = path.dirname(createRequire(path.join(reactPdfDir, "package.json")).resolve("pdfjs-dist/package.json"));

export default defineConfig({
  root: import.meta.dirname,
  publicDir: path.join(shell, "public"),
  plugins: [react(), svgr()],
  resolve: {
    alias: [
      { find: "@claraos/core", replacement: path.join(shell, "../core/src") },
      { find: "@claraos/skins", replacement: path.join(shell, "../skins/src") },
      { find: "pdfjs-dist", replacement: pdfjsDir },
    ],
  },
  css: { modules: { localsConvention: "camelCase" } },
  build: { outDir: path.join(import.meta.dirname, "dist"), emptyOutDir: true, sourcemap: false },
  preview: { port: 8798, strictPort: true, host: "127.0.0.1" },
});
