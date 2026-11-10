import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { fileURLToPath } from "node:url";

const pkg = (p: string) => fileURLToPath(new URL(`./packages/${p}`, import.meta.url));
const page = (p: string) => fileURLToPath(new URL(`./${p}`, import.meta.url));

/**
 * PGlite importiert "stream/promises" nur unter Node.js. Das Polyfill-Plugin
 * leitet "stream" auf stream-browserify um, das kein "/promises" hat – daher
 * hier ein Platzhalter.
 */
const streamPromisesShim = {
  name: "wterm:stream-promises-shim",
  enforce: "pre" as const,
  resolveId(id: string) {
    if (/(^|[\\/])stream(-browserify)?([\\/]index\.js)?[\\/]promises$/.test(id)) {
      return pkg("psql/src/shims/stream-promises.ts");
    }
    return null;
  },
};

export default defineConfig({
  // Relative Pfade: Die Seite funktioniert unter jedem Unterpfad,
  // z. B. https://<name>.github.io/<repo>/ (GitHub Pages).
  base: "./",
  plugins: [streamPromisesShim, nodePolyfills({ include: ["zlib", "stream", "buffer"], globals: { Buffer: true } })],
  resolve: {
    dedupe: ["vite-plugin-node-polyfills"],
    // Die wterm-Pakete werden direkt aus dem lokalen Quellcode gebaut.
    alias: [
      { find: /^@wterm\/dom\/css$/, replacement: pkg("dom/src/terminal.css") },
      { find: /^@wterm\/dom$/, replacement: pkg("dom/src/index.ts") },
      { find: /^@wterm\/core$/, replacement: pkg("core/src/index.ts") },
      { find: /^@wterm\/just-bash$/, replacement: pkg("just-bash/src/index.ts") },
      { find: /^@wterm\/python$/, replacement: pkg("python/src/index.ts") },
      { find: /^@wterm\/psql$/, replacement: pkg("psql/src/index.ts") },
    ],
  },
  // Pyodide lädt seine Laufzeitdateien selbst (aus public/pyodide/).
  // PGlite lädt pglite.wasm/pglite.data über new URL(…, import.meta.url).
  optimizeDeps: { exclude: ["pyodide", "@electric-sql/pglite"] },
  build: {
    target: "es2022",
    // just-bash ist als Bundle ~1,5 MB groß; das ist erwartet.
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        main: page("index.html"),
        python: page("python.html"),
        psql: page("psql.html"),
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
