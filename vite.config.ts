import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { fileURLToPath } from "node:url";

const pkg = (p: string) => fileURLToPath(new URL(`./packages/${p}`, import.meta.url));
const page = (p: string) => fileURLToPath(new URL(`./${p}`, import.meta.url));

export default defineConfig({
  // Relative Pfade: Die Seite funktioniert unter jedem Unterpfad,
  // z. B. https://<name>.github.io/<repo>/ (GitHub Pages).
  base: "./",
  plugins: [nodePolyfills({ include: ["zlib", "stream", "buffer"], globals: { Buffer: true } })],
  resolve: {
    dedupe: ["vite-plugin-node-polyfills"],
    // Die wterm-Pakete werden direkt aus dem lokalen Quellcode gebaut.
    alias: [
      { find: /^@wterm\/dom\/css$/, replacement: pkg("dom/src/terminal.css") },
      { find: /^@wterm\/dom$/, replacement: pkg("dom/src/index.ts") },
      { find: /^@wterm\/core$/, replacement: pkg("core/src/index.ts") },
      { find: /^@wterm\/just-bash$/, replacement: pkg("just-bash/src/index.ts") },
      { find: /^@wterm\/python$/, replacement: pkg("python/src/index.ts") },
    ],
  },
  // Pyodide lädt seine Laufzeitdateien selbst (aus public/pyodide/).
  optimizeDeps: { exclude: ["pyodide"] },
  build: {
    target: "es2022",
    // just-bash ist als Bundle ~1,5 MB groß; das ist erwartet.
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        main: page("index.html"),
        python: page("python.html"),
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    // große, unveränderliche Laufzeitdateien nicht überwachen
    watch: { ignored: ["**/public/pyodide/**"] },
  },
});
