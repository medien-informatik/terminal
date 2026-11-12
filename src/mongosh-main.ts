import { WTerm } from "@wterm/dom";
import { startMongosh, type ShellScript } from "@wterm/mongosh";
import "@wterm/dom/css";

const container = document.getElementById("terminal")!;

const term = new WTerm(container, {
  debug: new URLSearchParams(location.search).has("debug"),
});

await term.init();
term.focus?.();

/** Liest alle <script type="text/mongosh"> der Seite (inline oder per src) in Dokumentreihenfolge. */
async function collectScripts(): Promise<ShellScript[]> {
  const elements = [...document.querySelectorAll<HTMLScriptElement>('script[type="text/mongosh"]')];
  const scripts: ShellScript[] = [];
  for (const [i, el] of elements.entries()) {
    const src = el.getAttribute("src");
    const name = el.dataset.name ?? (src ? src.split("/").pop()! : `script-${i + 1}.js`);
    let code = el.textContent ?? "";
    if (src) {
      try {
        const res = await fetch(new URL(src, document.baseURI));
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        code = await res.text();
      } catch (err) {
        term.write(`\x1b[31mmongosh: ${name}: konnte nicht geladen werden (${(err as Error).message})\x1b[0m\r\n`);
        continue;
      }
    }
    scripts.push({ name, code });
  }
  return scripts;
}

if (import.meta.env.DEV) {
  Object.assign(window, { wterm: { term } });
}

await startMongosh(term, {
  scripts: await collectScripts(),
  db: container.dataset.db,
});
