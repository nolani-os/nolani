import path from "path";
import { createRequire } from "module";

// The app reuses the shell's code and dependencies; resolve tooling from there
// so this package needs no install of its own during the spike.
const shellDir = path.resolve(import.meta.dirname, "../shell");
const fromShell = createRequire(path.join(shellDir, "package.json"));
const plugin = (id: string) => { const m = fromShell(id); return m.default ?? m; };
const react = plugin("@vitejs/plugin-react-swc");
const svgr = plugin("vite-plugin-svgr");

export default {
  root: import.meta.dirname,
  plugins: [react(), svgr()],
  resolve: {
    alias: {
      "@claraos/core": path.resolve(import.meta.dirname, "../core/src"),
      "@claraos/skins": path.resolve(import.meta.dirname, "../skins/src"),
      react: path.join(shellDir, "node_modules/react"),
      "react-dom": path.join(shellDir, "node_modules/react-dom"),
    },
    dedupe: ["react", "react-dom"],
  },
  css: { modules: { localsConvention: "camelCase" } },
  server: { port: 3100, host: true, fs: { allow: [path.resolve(import.meta.dirname, "..")] } },
  build: { outDir: "dist", emptyOutDir: true },
};
