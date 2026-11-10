/**
 * Abgleich zwischen dem virtuellen Dateisystem von just-bash und dem
 * (Emscripten-)Dateisystem von Pyodide.
 *
 * Vor einer Python-Ausführung werden die Arbeitsverzeichnisse nach Pyodide
 * kopiert, danach werden neue, geänderte und gelöschte Dateien zurückgeschrieben.
 */
import type { IFileSystem } from "just-bash";

/** Minimaler Ausschnitt der Emscripten-FS-API, die hier benötigt wird. */
export interface EmscriptenFS {
  analyzePath(path: string): { exists: boolean };
  mkdirTree(path: string): void;
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string): Uint8Array;
  readdir(path: string): string[];
  stat(path: string): { mode: number };
  isDir(mode: number): boolean;
  isFile(mode: number): boolean;
  unlink(path: string): void;
  rmdir(path: string): void;
}

/** Verzeichnisse, die nie abgeglichen werden. */
const SKIP = new Set([".git", "__pycache__"]);

export type Snapshot = Map<string, Uint8Array>;

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function walkShell(fs: IFileSystem, dir: string, files: string[], dirs: string[]): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP.has(name)) continue;
    const path = dir === "/" ? `/${name}` : `${dir}/${name}`;
    try {
      const st = await fs.lstat(path);
      if (st.isDirectory) {
        dirs.push(path);
        await walkShell(fs, path, files, dirs);
      } else if (st.isFile) {
        files.push(path);
      }
    } catch {
      /* ignorieren */
    }
  }
}

function walkPy(FS: EmscriptenFS, dir: string, files: string[], dirs: string[]): void {
  let entries: string[];
  try {
    entries = FS.readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "." || name === ".." || SKIP.has(name)) continue;
    const path = dir === "/" ? `/${name}` : `${dir}/${name}`;
    const { mode } = FS.stat(path);
    if (FS.isDir(mode)) {
      dirs.push(path);
      walkPy(FS, path, files, dirs);
    } else if (FS.isFile(mode)) {
      files.push(path);
    }
  }
}

/** Kopiert die Wurzelverzeichnisse nach Pyodide und liefert einen Schnappschuss. */
export async function syncToPython(fs: IFileSystem, FS: EmscriptenFS, roots: string[]): Promise<Snapshot> {
  const snapshot: Snapshot = new Map();
  for (const root of roots) {
    if (!(await fs.exists(root))) continue;
    const files: string[] = [];
    const dirs: string[] = [];
    await walkShell(fs, root, files, dirs);
    FS.mkdirTree(root);
    for (const d of dirs) FS.mkdirTree(d);
    const wanted = new Set(files);
    for (const f of files) {
      const data = await fs.readFileBuffer(f);
      FS.writeFile(f, data);
      snapshot.set(f, data);
    }
    // In Pyodide verbliebene Dateien entfernen, die es in der Shell nicht mehr gibt
    const pyFiles: string[] = [];
    const pyDirs: string[] = [];
    walkPy(FS, root, pyFiles, pyDirs);
    for (const f of pyFiles) if (!wanted.has(f)) FS.unlink(f);
    const shellDirs = new Set(dirs);
    for (const d of pyDirs.reverse()) {
      if (!shellDirs.has(d)) {
        try {
          FS.rmdir(d);
        } catch {
          /* nicht leer */
        }
      }
    }
  }
  return snapshot;
}

/** Schreibt Änderungen aus Pyodide zurück in die Shell und aktualisiert den Schnappschuss. */
export async function syncFromPython(
  fs: IFileSystem,
  FS: EmscriptenFS,
  roots: string[],
  snapshot: Snapshot,
): Promise<void> {
  const seen = new Set<string>();
  for (const root of roots) {
    if (!FS.analyzePath(root).exists) continue;
    const files: string[] = [];
    const dirs: string[] = [];
    walkPy(FS, root, files, dirs);
    for (const d of dirs) {
      if (!(await fs.exists(d))) await fs.mkdir(d, { recursive: true });
    }
    for (const f of files) {
      seen.add(f);
      const data = FS.readFile(f);
      const before = snapshot.get(f);
      if (before && equalBytes(before, data)) continue;
      const parent = f.slice(0, f.lastIndexOf("/")) || "/";
      if (!(await fs.exists(parent))) await fs.mkdir(parent, { recursive: true });
      await fs.writeFile(f, data);
      snapshot.set(f, data);
    }
  }
  for (const f of [...snapshot.keys()]) {
    if (!seen.has(f) && roots.some((r) => f === r || f.startsWith(r + "/"))) {
      await fs.rm(f, { force: true }).catch(() => {});
      snapshot.delete(f);
    }
  }
}
