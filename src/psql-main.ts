import { WTerm } from "@wterm/dom";
import { startPsql, type SqlScript } from "@wterm/psql";
import "@wterm/dom/css";

const container = document.getElementById("terminal")!;

const term = new WTerm(container, {
  debug: new URLSearchParams(location.search).has("debug"),
});

await term.init();
term.focus?.();

/** Liest alle <script type="text/sql"> der Seite (inline oder per src) in Dokumentreihenfolge. */
async function collectScripts(): Promise<SqlScript[]> {
  const elements = [...document.querySelectorAll<HTMLScriptElement>('script[type="text/sql"]')];
  const scripts: SqlScript[] = [];
  for (const [i, el] of elements.entries()) {
    const src = el.getAttribute("src");
    const name = el.dataset.name ?? (src ? src.split("/").pop()! : `script-${i + 1}.sql`);
    let sql = el.textContent ?? "";
    if (src) {
      try {
        const res = await fetch(new URL(src, document.baseURI));
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        sql = await res.text();
      } catch (err) {
        term.write(`\x1b[31mpsql: error: ${name}: konnte nicht geladen werden (${(err as Error).message})\x1b[0m\r\n`);
        continue;
      }
    }
    scripts.push({ name, sql });
  }
  return scripts;
}

if (import.meta.env.DEV) {
  Object.assign(window, { wterm: { term } });
}

await startPsql(term, { scripts: await collectScripts() });
