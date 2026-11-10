/**
 * git-Emulation für wterm/just-bash.
 *
 * Basiert auf isomorphic-git und arbeitet direkt auf dem virtuellen
 * Dateisystem von just-bash. Es werden nur lokale Befehle unterstützt;
 * Remote-Befehle (clone, fetch, pull, push, …) melden, dass sie in der
 * Simulation nicht verfügbar sind.
 */
import * as git from "isomorphic-git";
import { structuredPatch } from "diff";
import type { IFileSystem } from "just-bash";
import { createGitFs } from "./fs-adapter.js";

/** Interne Flags für das Zusammenspiel mit dem Commit-Editor (nano). */
export const EDITMSG_PREPARE = "--wterm-prepare-editmsg";
export const EDITMSG_USE = "--wterm-use-editmsg";
export const EDITMSG_MARKER = "EDITMSG:";

export interface GitContext {
  fs: IFileSystem;
  cwd: string;
  env: Map<string, string> | Record<string, string>;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  boldCyan: "\x1b[1;36m",
  boldGreen: "\x1b[1;32m",
  boldYellow: "\x1b[1;33m",
  boldRed: "\x1b[1;31m",
};

const REMOTE_COMMANDS = new Set([
  "clone",
  "fetch",
  "pull",
  "push",
  "remote",
  "ls-remote",
  "submodule",
  "request-pull",
  "send-email",
  "svn",
  "p4",
]);

const UNSUPPORTED_COMMANDS = new Set([
  "stash",
  "rebase",
  "cherry-pick",
  "revert",
  "bisect",
  "blame",
  "worktree",
  "gc",
  "reflog",
  "notes",
  "am",
  "apply",
  "format-patch",
  "clean",
  "grep",
  "describe",
  "shortlog",
]);

class GitError extends Error {
  constructor(
    message: string,
    public exitCode = 128,
  ) {
    super(message);
  }
}

// ───────────────────────────── Pfade ─────────────────────────────

function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return "/" + parts.join("/");
}

function resolve(cwd: string, path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return normalize(home + "/" + path.slice(2));
  return normalize(path.startsWith("/") ? path : `${cwd}/${path}`);
}

function relative(from: string, to: string): string {
  const a = from.split("/").filter(Boolean);
  const b = to.split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const rel = [...Array(a.length - i).fill(".."), ...b.slice(i)].join("/");
  return rel || ".";
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

const textDecoder = new TextDecoder();

function isBinary(bytes: Uint8Array): boolean {
  const len = Math.min(bytes.length, 8000);
  for (let i = 0; i < len; i++) if (bytes[i] === 0) return true;
  return false;
}

function gitDate(timestamp: number, offsetMinutes: number): string {
  // isomorphic-git speichert den Offset wie Date#getTimezoneOffset (invertiert).
  const shift = -offsetMinutes;
  const d = new Date((timestamp + shift * 60) * 1000);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n: number) => String(n).padStart(2, "0");
  const sign = shift >= 0 ? "+" : "-";
  const abs = Math.abs(shift);
  return (
    `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${d.getUTCDate()} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ` +
    `${d.getUTCFullYear()} ${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
  );
}

// ───────────────────────────── Konfiguration (~/.gitconfig) ─────────────────────────────

function parseIni(text: string): Map<string, string> {
  const map = new Map<string, string>();
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sec = /^\[\s*([^\s\]"]+)(?:\s+"([^"]*)")?\s*\]$/.exec(line);
    if (sec) {
      section = sec[2] !== undefined ? `${sec[1].toLowerCase()}.${sec[2]}` : sec[1].toLowerCase();
      continue;
    }
    const kv = /^([A-Za-z][\w-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (kv && section) {
      let value = kv[2] ?? "true";
      if (/^".*"$/.test(value)) value = value.slice(1, -1);
      map.set(`${section}.${kv[1].toLowerCase()}`, value);
    }
  }
  return map;
}

function serializeIni(map: Map<string, string>): string {
  const sections = new Map<string, [string, string][]>();
  for (const [key, value] of map) {
    const idx = key.lastIndexOf(".");
    const sec = key.slice(0, idx);
    const name = key.slice(idx + 1);
    if (!sections.has(sec)) sections.set(sec, []);
    sections.get(sec)!.push([name, value]);
  }
  let out = "";
  for (const [sec, entries] of sections) {
    const dot = sec.indexOf(".");
    out += dot >= 0 ? `[${sec.slice(0, dot)} "${sec.slice(dot + 1)}"]\n` : `[${sec}]\n`;
    for (const [k, v] of entries) out += `\t${k} = ${/[\s#;]/.test(v) ? `"${v}"` : v}\n`;
  }
  return out;
}

// ───────────────────────────── Ausführungskontext ─────────────────────────────

type GitFs = ReturnType<typeof createGitFs>;
type WalkerKind = "tree" | "stage" | "workdir";

interface FileVersion {
  oid: string;
  mode: number;
  read: () => Promise<Uint8Array>;
}

interface ChangeEntry {
  path: string;
  a?: FileVersion;
  b?: FileVersion;
}

class GitRunner {
  private out = "";
  private err = "";
  private readonly gfs: GitFs;
  private readonly cache = {};
  private readonly home: string;
  private dir = "";
  private gitdir = "";

  constructor(
    private readonly fs: IFileSystem,
    private cwd: string,
    env: Map<string, string> | Record<string, string>,
  ) {
    this.gfs = createGitFs(fs);
    const get = (k: string) => (env instanceof Map ? env.get(k) : env[k]);
    this.home = get("HOME") || "/home/user";
  }

  private quiet = false;

  private print(text = ""): void {
    this.out += text + "\n";
  }

  /** Statusmeldungen, die mit -q/--quiet unterdrückt werden. */
  private info(text: string, toStderr = false): void {
    if (this.quiet) return;
    if (toStderr) this.printErr(text);
    else this.print(text);
  }

  private printErr(text: string): void {
    this.err += text + "\n";
  }

  private result(exitCode: number): GitResult {
    return { stdout: this.out, stderr: this.err, exitCode };
  }

  private get base() {
    return { fs: this.gfs, dir: this.dir, gitdir: this.gitdir, cache: this.cache };
  }

  private abs(path: string): string {
    return resolve(this.cwd, path, this.home);
  }

  /** Pfad relativ zum Repository (für isomorphic-git). */
  private repoPath(path: string): string {
    const abs = this.abs(path);
    const rel = relative(this.dir, abs);
    if (rel.startsWith("..")) {
      throw new GitError(`fatal: ${path}: '${path}' is outside repository at '${this.dir}'`);
    }
    return rel === "." ? "" : rel;
  }

  /** Repository-Pfad für die Ausgabe relativ zum aktuellen Verzeichnis. */
  private show(path: string): string {
    return relative(this.cwd, normalize(`${this.dir}/${path}`));
  }

  private async findRepo(): Promise<void> {
    try {
      this.dir = await git.findRoot({ fs: this.gfs, filepath: this.cwd });
      this.gitdir = `${this.dir === "/" ? "" : this.dir}/.git`;
    } catch {
      throw new GitError("fatal: not a git repository (or any of the parent directories): .git");
    }
  }

  // ───── Konfiguration ─────

  private globalConfigPath(): string {
    return `${this.home}/.gitconfig`;
  }

  private async readGlobalConfig(): Promise<Map<string, string>> {
    try {
      return parseIni(await this.fs.readFile(this.globalConfigPath()));
    } catch {
      return new Map();
    }
  }

  private async readLocalConfig(): Promise<Map<string, string>> {
    try {
      return parseIni(await this.fs.readFile(`${this.gitdir}/config`));
    } catch {
      return new Map();
    }
  }

  private async configValue(key: string): Promise<string | undefined> {
    if (this.dir) {
      const local = await git.getConfig({ ...this.base, path: key }).catch(() => undefined);
      if (local !== undefined && local !== null) return String(local);
    }
    return (await this.readGlobalConfig()).get(key.toLowerCase());
  }

  private async author() {
    const name = await this.configValue("user.name");
    const email = await this.configValue("user.email");
    if (!name || !email) {
      throw new GitError(
        [
          "Author identity unknown",
          "",
          "*** Please tell me who you are.",
          "",
          "Run",
          "",
          '  git config --global user.email "you@example.com"',
          '  git config --global user.name "Your Name"',
          "",
          "to set your account's default identity.",
        ].join("\n"),
      );
    }
    return { name, email };
  }

  // ───── Revisionen ─────

  private async headOid(): Promise<string | null> {
    try {
      return await git.resolveRef({ ...this.base, ref: "HEAD" });
    } catch {
      return null;
    }
  }

  private async currentBranch(): Promise<string | undefined> {
    return (await git.currentBranch({ ...this.base, fullname: false }).catch(() => undefined)) ?? undefined;
  }

  /** Name des Branches, auf den HEAD zeigt (auch ohne Commits). */
  private async headBranchName(): Promise<string | undefined> {
    try {
      const head = (await this.fs.readFile(`${this.gitdir}/HEAD`)).trim();
      const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
      return m?.[1];
    } catch {
      return undefined;
    }
  }

  private async peel(oid: string): Promise<string> {
    for (let i = 0; i < 10; i++) {
      try {
        await git.readCommit({ ...this.base, oid });
        return oid;
      } catch {
        try {
          const { tag } = await git.readTag({ ...this.base, oid });
          oid = tag.object;
        } catch {
          break;
        }
      }
    }
    return oid;
  }

  private async tryResolveRev(rev: string): Promise<string | null> {
    const m = /^(.*?)((?:[~^]\d*)*)$/.exec(rev);
    if (!m) return null;
    const baseName = m[1] || "HEAD";
    let oid: string | null = null;
    try {
      oid = await git.resolveRef({ ...this.base, ref: baseName });
    } catch {
      if (/^[0-9a-f]{4,40}$/i.test(baseName)) {
        oid = await git.expandOid({ ...this.base, oid: baseName.toLowerCase() }).catch(() => null);
      }
    }
    if (!oid) return null;
    oid = await this.peel(oid);
    for (const op of m[2].matchAll(/([~^])(\d*)/g)) {
      const n = op[2] === "" ? 1 : parseInt(op[2], 10);
      if (op[1] === "~") {
        for (let i = 0; i < n; i++) {
          const { commit } = await git.readCommit({ ...this.base, oid });
          if (!commit.parent[0]) return null;
          oid = commit.parent[0];
        }
      } else if (n > 0) {
        const { commit } = await git.readCommit({ ...this.base, oid });
        if (!commit.parent[n - 1]) return null;
        oid = commit.parent[n - 1];
      }
    }
    return oid;
  }

  private async resolveRev(rev: string): Promise<string> {
    const oid = await this.tryResolveRev(rev);
    if (!oid) {
      throw new GitError(
        `fatal: ambiguous argument '${rev}': unknown revision or path not in the working tree.`,
      );
    }
    return oid;
  }

  private async commitSummary(oid: string): Promise<string> {
    const { commit } = await git.readCommit({ ...this.base, oid });
    return `${oid.slice(0, 7)} ${commit.message.split("\n")[0]}`;
  }

  // ───── Vergleiche ─────

  private walker(kind: WalkerKind, ref?: string) {
    if (kind === "tree") return git.TREE({ ref: ref! });
    if (kind === "stage") return git.STAGE();
    return git.WORKDIR();
  }

  /**
   * Vergleicht zwei Stände (Commit-Baum, Index oder Arbeitsverzeichnis).
   * `a === null` bedeutet „leerer Stand“ (z. B. vor dem ersten Commit).
   */
  private async changes(
    a: { kind: WalkerKind; ref?: string } | null,
    b: { kind: WalkerKind; ref?: string },
    filter?: (path: string) => boolean,
  ): Promise<ChangeEntry[]> {
    const kinds: { kind: WalkerKind; ref?: string }[] = a ? [a, b] : [b];
    const trees = kinds.map((k) => this.walker(k.kind, k.ref));
    const readFor = (kind: WalkerKind, entry: git.WalkerEntry, oid: string) => async () => {
      if (kind === "workdir") {
        const content = await entry.content();
        return content ?? new Uint8Array();
      }
      const { blob } = await git.readBlob({ ...this.base, oid });
      return blob;
    };
    const results = (await git.walk({
      ...this.base,
      trees,
      map: async (filepath, entries) => {
        if (filepath === ".") return undefined;
        const versions: (FileVersion | undefined)[] = [];
        for (let i = 0; i < kinds.length; i++) {
          const entry = entries[i];
          if (!entry) {
            versions.push(undefined);
            continue;
          }
          const type = await entry.type();
          if (type !== "blob") {
            versions.push(undefined);
            continue;
          }
          const oid = await entry.oid();
          const mode = await entry.mode();
          versions.push({ oid, mode, read: readFor(kinds[i].kind, entry, oid) });
        }
        const [va, vb] = a ? versions : [undefined, versions[0]];
        if (!va && !vb) return undefined;
        if (va && vb && va.oid === vb.oid && va.mode === vb.mode) return undefined;
        if (filter && !filter(filepath)) return undefined;
        return { path: filepath, a: va, b: vb } satisfies ChangeEntry;
      },
    })) as ChangeEntry[];
    return results.filter(Boolean).sort((x, y) => (x.path < y.path ? -1 : 1));
  }

  private pathFilter(specs: string[]): ((path: string) => boolean) | undefined {
    if (specs.length === 0) return undefined;
    const rel = specs.map((s) => this.repoPath(s));
    return (path) => rel.some((r) => r === "" || path === r || path.startsWith(r + "/"));
  }

  private async diffText(entries: ChangeEntry[]): Promise<{ text: string; ins: number; del: number }> {
    let text = "";
    let ins = 0;
    let del = 0;
    for (const e of entries) {
      const before = e.a ? await e.a.read() : new Uint8Array();
      const after = e.b ? await e.b.read() : new Uint8Array();
      const modeStr = (m?: number) => (m ?? 0o100644).toString(8);
      text += `${C.bold}diff --git a/${e.path} b/${e.path}${C.reset}\n`;
      if (!e.a) text += `${C.bold}new file mode ${modeStr(e.b?.mode)}${C.reset}\n`;
      if (!e.b) text += `${C.bold}deleted file mode ${modeStr(e.a?.mode)}${C.reset}\n`;
      if (e.a && e.b && e.a.mode !== e.b.mode) {
        text += `${C.bold}old mode ${modeStr(e.a.mode)}${C.reset}\n${C.bold}new mode ${modeStr(e.b.mode)}${C.reset}\n`;
      }
      const short = (v?: FileVersion) => (v ? v.oid.slice(0, 7) : "0000000");
      const sameMode = e.a && e.b && e.a.mode === e.b.mode ? ` ${modeStr(e.a.mode)}` : "";
      text += `${C.bold}index ${short(e.a)}..${short(e.b)}${sameMode}${C.reset}\n`;
      if (isBinary(before) || isBinary(after)) {
        text += `Binary files ${e.a ? "a/" + e.path : "/dev/null"} and ${e.b ? "b/" + e.path : "/dev/null"} differ\n`;
        continue;
      }
      const oldText = textDecoder.decode(before);
      const newText = textDecoder.decode(after);
      if (oldText === newText) continue;
      text += `${C.bold}--- ${e.a ? "a/" + e.path : "/dev/null"}${C.reset}\n`;
      text += `${C.bold}+++ ${e.b ? "b/" + e.path : "/dev/null"}${C.reset}\n`;
      const patch = structuredPatch(e.path, e.path, oldText, newText, "", "", { context: 3 });
      for (const h of patch.hunks) {
        const range = (start: number, lines: number) =>
          lines === 1 ? `${start}` : `${lines === 0 ? start : start},${lines}`;
        text += `${C.cyan}@@ -${range(h.oldStart, h.oldLines)} +${range(h.newStart, h.newLines)} @@${C.reset}\n`;
        for (const line of h.lines) {
          if (line.startsWith("+")) {
            ins++;
            text += `${C.green}${line}${C.reset}\n`;
          } else if (line.startsWith("-")) {
            del++;
            text += `${C.red}${line}${C.reset}\n`;
          } else {
            text += `${line}\n`;
          }
        }
      }
    }
    return { text, ins, del };
  }

  private async diffStat(entries: ChangeEntry[]): Promise<string> {
    const { ins, del } = await this.diffText(entries);
    let line = ` ${plural(entries.length, "file changed", "files changed")}`;
    if (ins > 0 || del === 0) line += `, ${plural(ins, "insertion(+)", "insertions(+)")}`;
    if (del > 0 || ins === 0) line += `, ${plural(del, "deletion(-)", "deletions(-)")}`;
    let out = line + "\n";
    for (const e of entries) {
      if (!e.a) out += ` create mode ${(e.b?.mode ?? 0o100644).toString(8)} ${e.path}\n`;
      else if (!e.b) out += ` delete mode ${e.a.mode.toString(8)} ${e.path}\n`;
    }
    return out;
  }

  // ───── Status ─────

  private async matrix() {
    return git.statusMatrix({ ...this.base });
  }

  // ───── Ungelöste Merge-Konflikte ─────
  // isomorphic-git kennt keine Konflikt-Stufen im Index; die Liste der noch
  // ungelösten Dateien wird deshalb in .git/WTERM_UNMERGED geführt.

  private get unmergedPath(): string {
    return `${this.gitdir}/WTERM_UNMERGED`;
  }

  private async unmerged(): Promise<string[]> {
    try {
      return (await this.fs.readFile(this.unmergedPath)).split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  private async setUnmerged(files: string[]): Promise<void> {
    if (files.length) await this.fs.writeFile(this.unmergedPath, files.join("\n") + "\n");
    else await this.fs.rm(this.unmergedPath, { force: true }).catch(() => {});
  }

  private async resolveUnmerged(file: string): Promise<void> {
    const list = await this.unmerged();
    if (list.includes(file)) await this.setUnmerged(list.filter((f) => f !== file));
  }

  private async clearMergeState(): Promise<void> {
    for (const f of ["MERGE_HEAD", "MERGE_MSG", "WTERM_UNMERGED"]) {
      await this.fs.rm(`${this.gitdir}/${f}`, { force: true }).catch(() => {});
    }
  }

  private async statusText(): Promise<{ text: string; staged: number; unstaged: number; untracked: number }> {
    const head = await this.headOid();
    const branch = await this.currentBranch();
    const matrix = await this.matrix();
    const staged: string[] = [];
    const unstaged: string[] = [];
    const untrackedFiles: string[] = [];
    const tracked = new Set<string>();
    const unmerged = await this.unmerged();

    for (const [file, h, w, s] of matrix) {
      if (h === 1 || s !== 0) tracked.add(file);
      if (unmerged.includes(file)) continue;
      // Index gegenüber HEAD
      if (h === 0 && s !== 0) staged.push(`new file:   ${this.show(file)}`);
      else if (h === 1 && s === 0) staged.push(`deleted:    ${this.show(file)}`);
      else if (h === 1 && (s === 2 || s === 3)) staged.push(`modified:   ${this.show(file)}`);
      // Arbeitsverzeichnis gegenüber Index
      if (s === 0 && w === 2) untrackedFiles.push(file);
      else if (s !== 0 && w === 0) unstaged.push(`deleted:    ${this.show(file)}`);
      else if (s === 3 || (s === 1 && w === 2)) unstaged.push(`modified:   ${this.show(file)}`);
    }

    // Komplett unversionierte Verzeichnisse wie git als "dir/" zusammenfassen.
    const trackedList = [...tracked];
    const untracked = new Set<string>();
    for (const file of untrackedFiles) {
      const segs = file.split("/");
      let shown = file;
      for (let k = 1; k < segs.length; k++) {
        const prefix = segs.slice(0, k).join("/");
        if (!trackedList.some((t) => t.startsWith(prefix + "/"))) {
          shown = prefix + "/";
          break;
        }
      }
      untracked.add(shown);
    }

    let text = "";
    if (branch) text += `On branch ${branch}\n`;
    else if (head) text += `HEAD detached at ${head.slice(0, 7)}\n`;
    else text += `On branch ${(await this.headBranchName()) ?? "main"}\n`;
    if (unmerged.length) {
      text += "You have unmerged paths.\n";
      text += '  (fix conflicts and run "git commit")\n';
      text += '  (use "git merge --abort" to abort the merge)\n';
    } else if (await this.fs.exists(`${this.gitdir}/MERGE_HEAD`)) {
      text += "All conflicts fixed but you are still merging.\n";
      text += '  (use "git commit" to conclude merge)\n';
    }
    if (unmerged.length) {
      text += "\nUnmerged paths:\n";
      text += '  (use "git add <file>..." to mark resolution)\n';
      for (const f of unmerged) text += `\t${C.red}both modified:   ${this.show(f)}${C.reset}\n`;
    }
    if (!head) text += "\nNo commits yet\n";

    if (staged.length) {
      text += "\nChanges to be committed:\n";
      text += head
        ? '  (use "git restore --staged <file>..." to unstage)\n'
        : '  (use "git rm --cached <file>..." to unstage)\n';
      for (const l of staged) text += `\t${C.green}${l}${C.reset}\n`;
    }
    if (unstaged.length) {
      text += "\nChanges not staged for commit:\n";
      text += '  (use "git add <file>..." to update what will be committed)\n';
      text += '  (use "git restore <file>..." to discard changes in working directory)\n';
      for (const l of unstaged) text += `\t${C.red}${l}${C.reset}\n`;
    }
    if (untracked.size) {
      text += "\nUntracked files:\n";
      text += '  (use "git add <file>..." to include in what will be committed)\n';
      for (const f of [...untracked].sort()) text += `\t${C.red}${this.show(f)}${f.endsWith("/") ? "/" : ""}${C.reset}\n`;
    }
    text += "\n";
    if (!staged.length) {
      if (unstaged.length || unmerged.length) text += 'no changes added to commit (use "git add" and/or "git commit -a")\n';
      else if (untracked.size) text += 'nothing added to commit but untracked files present (use "git add" to track)\n';
      else if (!head) text += 'nothing to commit (create/copy files and use "git add" to track)\n';
      else text += "nothing to commit, working tree clean\n";
    }
    return { text, staged: staged.length, unstaged: unstaged.length, untracked: untracked.size };
  }

  // ───────────────────────────── Befehle ─────────────────────────────

  async run(argv: string[]): Promise<GitResult> {
    const args = [...argv];
    // globale Option -C <pfad>
    while (args[0] === "-C" && args[1] !== undefined) {
      this.cwd = this.abs(args[1]);
      args.splice(0, 2);
    }
    const cmd = args.shift();
    // Zusammengefasste Kurzoptionen zerlegen (-qb → -q -b), außer nach "--"
    // und bei config (dort sind die Argumente Werte).
    if (cmd !== "config") {
      const dash = args.indexOf("--");
      for (let i = (dash < 0 ? args.length : dash) - 1; i >= 0; i--) {
        if (/^-[a-zA-Z]{2,}$/.test(args[i]) && args[i] !== "-vv") {
          args.splice(i, 1, ...[...args[i].slice(1)].map((c) => `-${c}`));
        }
      }
    }
    this.quiet = args.includes("-q") || args.includes("--quiet");
    try {
      if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") return this.help();
      if (cmd === "--version" || cmd === "version") {
        this.print(`git version 2.47.0 (wterm-Simulation, isomorphic-git ${git.version()})`);
        return this.result(0);
      }
      if (REMOTE_COMMANDS.has(cmd)) {
        this.printErr(
          `git ${cmd}: Remote-Befehle sind in dieser Simulation nicht verfügbar (kein Netzwerkzugriff).`,
        );
        this.printErr("Verfügbar sind nur lokale Befehle – siehe 'git help'.");
        return this.result(1);
      }
      if (UNSUPPORTED_COMMANDS.has(cmd)) {
        this.printErr(`git ${cmd}: wird in dieser Simulation nicht unterstützt – siehe 'git help'.`);
        return this.result(1);
      }
      switch (cmd) {
        case "init":
          return await this.init(args);
        case "config":
          return await this.config(args);
      }
      await this.findRepo();
      switch (cmd) {
        case "status":
          return await this.status(args);
        case "add":
          return await this.add(args);
        case "rm":
          return await this.rm(args);
        case "mv":
          return await this.mv(args);
        case "commit":
          return await this.commit(args);
        case "log":
          return await this.log(args);
        case "show":
          return await this.showCmd(args);
        case "diff":
          return await this.diff(args);
        case "branch":
          return await this.branch(args);
        case "checkout":
          return await this.checkout(args);
        case "switch":
          return await this.switchCmd(args);
        case "restore":
          return await this.restore(args);
        case "merge":
          return await this.merge(args);
        case "tag":
          return await this.tag(args);
        case "reset":
          return await this.reset(args);
        case "rev-parse":
          return await this.revParse(args);
        case "ls-files":
          return await this.lsFiles();
        default:
          this.printErr(`git: '${cmd}' is not a git command. See 'git --help'.`);
          return this.result(1);
      }
    } catch (e) {
      if (e instanceof GitError) {
        this.printErr(e.message);
        return this.result(e.exitCode);
      }
      const err = e as Error & { code?: string; data?: { filepaths?: string[] } };
      if (err.code === "CheckoutConflictError") {
        this.printErr("error: Your local changes to the following files would be overwritten by checkout:");
        for (const f of err.data?.filepaths ?? []) this.printErr(`\t${this.show(f)}`);
        this.printErr("Please commit your changes or stash them before you switch branches.\nAborting");
        return this.result(1);
      }
      this.printErr(`fatal: ${err.message ?? String(e)}`);
      return this.result(128);
    }
  }

  private help(): GitResult {
    this.print(`usage: git [-C <path>] <command> [<args>]

Verfügbare Befehle in der wterm-Simulation (nur lokal):

Arbeitsbereich anlegen
   init        Leeres Repository anlegen
   config      Einstellungen lesen/setzen (z. B. user.name, user.email)

Änderungen erfassen
   add         Dateien zum Index hinzufügen
   mv          Datei verschieben/umbenennen
   restore     Dateien wiederherstellen / aus dem Index nehmen
   rm          Dateien entfernen

Historie ansehen
   diff        Änderungen anzeigen
   log         Commit-Historie anzeigen
   show        Commit anzeigen
   status      Zustand des Arbeitsverzeichnisses
   ls-files    Dateien im Index auflisten

Historie verändern
   branch      Branches auflisten, anlegen, löschen
   checkout    Branch wechseln oder Dateien wiederherstellen
   commit      Änderungen festschreiben (ohne -m öffnet sich nano)
   merge       Branches zusammenführen
   reset       HEAD zurücksetzen (--soft, --mixed, --hard)
   switch      Branch wechseln
   tag         Tags auflisten, anlegen, löschen

Remote-Befehle (clone, fetch, pull, push, remote, …) sind in der
Simulation nicht verfügbar.`);
    return this.result(0);
  }

  private async init(args: string[]): Promise<GitResult> {
    let branch = (await this.readGlobalConfig()).get("init.defaultbranch") ?? "main";
    let target: string | undefined;
    let quiet = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-b" || a === "--initial-branch") branch = args[++i] ?? branch;
      else if (a.startsWith("--initial-branch=")) branch = a.slice(17);
      else if (a === "-q" || a === "--quiet") quiet = true;
      else if (!a.startsWith("-")) target = a;
    }
    const dir = target ? this.abs(target) : this.cwd;
    if (!(await this.fs.exists(dir))) await this.fs.mkdir(dir, { recursive: true });
    const gitdir = `${dir === "/" ? "" : dir}/.git`;
    const existed = await this.fs.exists(gitdir);
    if (!existed) await git.init({ fs: this.gfs, dir, defaultBranch: branch });
    if (!quiet) {
      this.print(`${existed ? "Reinitialized existing" : "Initialized empty"} Git repository in ${gitdir}/`);
    }
    return this.result(0);
  }

  private async config(args: string[]): Promise<GitResult> {
    let global = false;
    let list = false;
    let unset = false;
    const rest: string[] = [];
    for (const a of args) {
      if (a === "--global") global = true;
      else if (a === "--local") global = false;
      else if (a === "-l" || a === "--list") list = true;
      else if (a === "--unset") unset = true;
      else rest.push(a);
    }
    if (!global) {
      try {
        await this.findRepo();
      } catch (e) {
        if (rest.length > 1 || unset) throw new GitError("fatal: not in a git directory");
        if (!list && rest.length === 1) {
          const v = (await this.readGlobalConfig()).get(rest[0].toLowerCase());
          if (v === undefined) return this.result(1);
          this.print(v);
          return this.result(0);
        }
        if (!list) throw e;
      }
    }
    if (list) {
      for (const [k, v] of await this.readGlobalConfig()) this.print(`${k}=${v}`);
      if (!global && this.dir) for (const [k, v] of await this.readLocalConfig()) this.print(`${k}=${v}`);
      return this.result(0);
    }
    const key = rest[0];
    if (!key) {
      this.printErr("usage: git config [--global] <name> [<value>]");
      return this.result(129);
    }
    if (!/^[A-Za-z][\w-]*(\.[^\s]+)?\.[A-Za-z][\w-]*$/.test(key)) {
      throw new GitError(`error: key does not contain a section: ${key}`, 1);
    }
    if (global) {
      const map = await this.readGlobalConfig();
      if (unset) map.delete(key.toLowerCase());
      else if (rest.length > 1) map.set(key.toLowerCase(), rest.slice(1).join(" "));
      else {
        const v = map.get(key.toLowerCase());
        if (v === undefined) return this.result(1);
        this.print(v);
        return this.result(0);
      }
      await this.fs.writeFile(this.globalConfigPath(), serializeIni(map));
      return this.result(0);
    }
    if (unset) {
      await git.setConfig({ ...this.base, path: key, value: undefined });
    } else if (rest.length > 1) {
      await git.setConfig({ ...this.base, path: key, value: rest.slice(1).join(" ") });
    } else {
      const v = await this.configValue(key);
      if (v === undefined) return this.result(1);
      this.print(v);
    }
    return this.result(0);
  }

  private async status(args: string[]): Promise<GitResult> {
    if (args.includes("-s") || args.includes("--short") || args.includes("--porcelain")) {
      const color = !args.includes("--porcelain");
      const matrix = await this.matrix();
      const lines: string[] = [];
      const untracked: string[] = [];
      for (const [file, h, w, s] of matrix) {
        if (s === 0 && w === 2 && h === 0) {
          untracked.push(file);
          continue;
        }
        let x = " ";
        if (h === 0 && s !== 0) x = "A";
        else if (h === 1 && s === 0) x = "D";
        else if (h === 1 && (s === 2 || s === 3)) x = "M";
        let y = " ";
        if (s !== 0 && w === 0) y = "D";
        else if (s === 3 || (s === 1 && w === 2)) y = "M";
        if (h === 1 && s === 0 && w === 2) untracked.push(file);
        if (x === " " && y === " ") continue;
        lines.push(
          color
            ? `${C.green}${x}${C.reset}${C.red}${y}${C.reset} ${this.show(file)}`
            : `${x}${y} ${this.show(file)}`,
        );
      }
      for (const f of untracked) lines.push(color ? `${C.red}??${C.reset} ${this.show(f)}` : `?? ${this.show(f)}`);
      if (lines.length) this.print(lines.join("\n"));
      return this.result(0);
    }
    this.out += (await this.statusText()).text;
    return this.result(0);
  }

  private async add(args: string[]): Promise<GitResult> {
    const all = args.some((a) => a === "-A" || a === "--all");
    const updateOnly = args.some((a) => a === "-u" || a === "--update");
    const verbose = args.some((a) => a === "-v" || a === "--verbose");
    const specs = args.filter((a) => !a.startsWith("-") || a === "-");
    if (!specs.length && !all && !updateOnly) {
      this.print("Nothing specified, nothing added.");
      this.print("hint: Maybe you wanted to say 'git add .'?");
      return this.result(0);
    }
    const filter = this.pathFilter(specs);
    const matrix = await this.matrix();
    for (const spec of specs) {
      const rel = this.repoPath(spec);
      const matched = matrix.some(([f]) => rel === "" || f === rel || f.startsWith(rel + "/"));
      if (!matched) {
        const ignored = await git.isIgnored({ ...this.base, filepath: rel }).catch(() => false);
        if (ignored) {
          this.printErr("The following paths are ignored by one of your .gitignore files:");
          this.printErr(spec);
          this.printErr('hint: Use -f if you really want to add them.');
          return this.result(1);
        }
        throw new GitError(`fatal: pathspec '${spec}' did not match any files`);
      }
    }
    const unmerged = await this.unmerged();
    for (const [file, h, w, s] of matrix) {
      if (filter && !filter(file)) continue;
      if (unmerged.includes(file)) {
        // git add markiert einen Konflikt als gelöst
        await git.add({ ...this.base, filepath: file });
        await this.resolveUnmerged(file);
        continue;
      }
      if (h === 1 && w === 1 && s === 1) continue;
      if (updateOnly && h === 0 && s === 0) continue;
      if (w === 0) {
        if (s !== 0) {
          await git.remove({ ...this.base, filepath: file });
          if (verbose) this.print(`remove '${this.show(file)}'`);
        }
      } else if (!(s === 2 && w === 2) || h === 0) {
        await git.add({ ...this.base, filepath: file });
        if (verbose) this.print(`add '${this.show(file)}'`);
      }
    }
    return this.result(0);
  }

  private async rm(args: string[]): Promise<GitResult> {
    const cached = args.includes("--cached");
    const recursive = args.some((a) => /^-[a-z]*r/.test(a) && !a.startsWith("--"));
    const quiet = args.includes("-q") || args.includes("--quiet");
    const specs = args.filter((a) => !a.startsWith("-"));
    if (!specs.length) {
      this.printErr("usage: git rm [<options>] [--] <file>...");
      return this.result(129);
    }
    const files = await git.listFiles({ ...this.base });
    for (const spec of specs) {
      const rel = this.repoPath(spec);
      const exact = files.includes(rel);
      const under = files.filter((f) => rel === "" || f.startsWith(rel + "/"));
      if (!exact && !under.length) throw new GitError(`fatal: pathspec '${spec}' did not match any files`);
      if (!exact && !recursive) throw new GitError(`fatal: not removing '${spec}' recursively without -r`);
      for (const f of exact ? [rel] : under) {
        await git.remove({ ...this.base, filepath: f });
        if (!cached) await this.fs.rm(`${this.dir}/${f}`, { force: true }).catch(() => {});
        if (!quiet) this.print(`rm '${f}'`);
      }
    }
    return this.result(0);
  }

  private async mv(args: string[]): Promise<GitResult> {
    const specs = args.filter((a) => !a.startsWith("-"));
    if (specs.length !== 2) {
      this.printErr("usage: git mv [<options>] <source>... <destination>");
      return this.result(129);
    }
    const srcAbs = this.abs(specs[0]);
    let dstAbs = this.abs(specs[1]);
    const srcRel = this.repoPath(specs[0]);
    const files = await git.listFiles({ ...this.base });
    const moved = files.filter((f) => f === srcRel || f.startsWith(srcRel + "/"));
    if (!moved.length) throw new GitError(`fatal: not under version control, source=${specs[0]}, destination=${specs[1]}`);
    if (await this.fs.exists(dstAbs)) {
      const st = await this.fs.stat(dstAbs);
      if (st.isDirectory) dstAbs = `${dstAbs}/${srcAbs.split("/").pop()}`;
      else throw new GitError(`fatal: destination exists, source=${specs[0]}, destination=${specs[1]}`);
    }
    await this.fs.mv(srcAbs, dstAbs);
    const dstRel = relative(this.dir, dstAbs);
    for (const f of moved) {
      await git.remove({ ...this.base, filepath: f });
      await git.add({ ...this.base, filepath: dstRel + f.slice(srcRel.length) });
    }
    return this.result(0);
  }

  private async commit(args: string[]): Promise<GitResult> {
    const messages: string[] = [];
    let all = false;
    let amend = false;
    let allowEmpty = false;
    let prepare = false;
    let useEditMsg = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === EDITMSG_PREPARE) prepare = true;
      else if (a === EDITMSG_USE) useEditMsg = true;
      else if (a === "-m" || a === "--message") messages.push(args[++i] ?? "");
      else if (a.startsWith("--message=")) messages.push(a.slice(10));
      else if (a === "-a" || a === "--all") all = true;
      else if (a === "--amend") amend = true;
      else if (a === "--allow-empty") allowEmpty = true;
      else if (/^-[a-zA-Z]+$/.test(a)) {
        // kombinierte Kurzoptionen, z. B. -am "Nachricht"
        for (const ch of a.slice(1)) {
          if (ch === "a") all = true;
          else if (ch === "m") messages.push(args[++i] ?? "");
        }
      }
    }

    const head = await this.headOid();
    if (amend && !head) throw new GitError("fatal: You have nothing to amend.");
    const mergeHeadPath = `${this.gitdir}/MERGE_HEAD`;
    const mergeHead = (await this.fs.exists(mergeHeadPath))
      ? (await this.fs.readFile(mergeHeadPath)).trim()
      : null;

    if (all) {
      for (const [file, h, w, s] of await this.matrix()) {
        if (h === 0 && s === 0) continue;
        if (w === 0 && s !== 0) await git.remove({ ...this.base, filepath: file });
        else if (w === 2 && s !== 2) await git.add({ ...this.base, filepath: file });
      }
    }

    if ((await this.unmerged()).length) {
      throw new GitError(
        "error: Committing is not possible because you have unmerged files.\n" +
          "hint: Fix them up in the work tree, and then use 'git add/rm <file>'\n" +
          "hint: as appropriate to mark resolution and make a commit.\n" +
          "fatal: Exiting because of an unresolved conflict.",
      );
    }
    const status = await this.statusText();
    if (!status.staged && !allowEmpty && !amend && !mergeHead) {
      this.out += status.text;
      return this.result(1);
    }

    const author = await this.author();
    const editMsgPath = `${this.gitdir}/COMMIT_EDITMSG`;

    let message: string;
    if (prepare) {
      let previous = "";
      if (amend && head) previous = (await git.readCommit({ ...this.base, oid: head })).commit.message;
      else if (mergeHead && (await this.fs.exists(`${this.gitdir}/MERGE_MSG`))) {
        previous = await this.fs.readFile(`${this.gitdir}/MERGE_MSG`);
      }
      const plain = status.text.replace(/\x1b\[[0-9;]*m/g, "");
      const template =
        (previous ? previous.replace(/\n*$/, "\n") : "\n") +
        "# Please enter the commit message for your changes. Lines starting\n" +
        "# with '#' will be ignored, and an empty message aborts the commit.\n#\n" +
        plain
          .split("\n")
          .filter((l) => !l.startsWith("  (use") && !/^(no changes|nothing)/.test(l))
          .map((l) => (l ? `# ${l}` : "#"))
          .join("\n")
          .replace(/#\n#$/, "#") +
        "\n";
      await this.fs.writeFile(editMsgPath, template);
      this.print(`${EDITMSG_MARKER}${editMsgPath}`);
      return this.result(0);
    }
    if (useEditMsg) {
      const raw = (await this.fs.readFile(editMsgPath).catch(() => "")) as string;
      message = raw
        .split("\n")
        .filter((l) => !l.startsWith("#"))
        .join("\n")
        .trim();
      if (!message) {
        this.printErr("Aborting commit due to empty commit message.");
        return this.result(1);
      }
    } else if (messages.length) {
      message = messages.join("\n\n");
    } else if (amend && head && args.includes("--no-edit")) {
      message = (await git.readCommit({ ...this.base, oid: head })).commit.message.trim();
    } else {
      throw new GitError(
        "error: kein Editor verfügbar – nutze 'git commit -m \"Nachricht\"' oder starte 'git commit' direkt in der Shell.",
        1,
      );
    }

    const parents = amend ? undefined : mergeHead && head ? [head, mergeHead] : undefined;
    const oid = await git.commit({
      ...this.base,
      message: message + "\n",
      author,
      amend,
      ...(parents ? { parent: parents } : {}),
    });
    if (mergeHead) await this.clearMergeState();

    const { commit } = await git.readCommit({ ...this.base, oid });
    const parent = commit.parent[0];
    const branch = (await this.currentBranch()) ?? "detached HEAD";
    const root = !parent ? " (root-commit)" : "";
    this.info(`[${branch}${root} ${oid.slice(0, 7)}] ${message.split("\n")[0]}`);
    const entries = await this.changes(parent ? { kind: "tree", ref: parent } : null, { kind: "tree", ref: oid });
    if (!this.quiet) this.out += await this.diffStat(entries);
    return this.result(0);
  }

  private async decorations(): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    const add = (oid: string, label: string) => {
      if (!map.has(oid)) map.set(oid, []);
      map.get(oid)!.push(label);
    };
    const current = await this.currentBranch();
    const head = await this.headOid();
    if (head && !current) add(head, `${C.boldCyan}HEAD${C.reset}`);
    for (const b of await git.listBranches({ ...this.base })) {
      const oid = await git.resolveRef({ ...this.base, ref: `refs/heads/${b}` }).catch(() => null);
      if (!oid) continue;
      if (b === current) add(oid, `${C.boldCyan}HEAD -> ${C.boldGreen}${b}${C.reset}`);
      else add(oid, `${C.boldGreen}${b}${C.reset}`);
    }
    for (const t of await git.listTags({ ...this.base })) {
      const oid = await this.tryResolveRev(`refs/tags/${t}`);
      if (oid) add(oid, `${C.boldYellow}tag: ${t}${C.reset}`);
    }
    // HEAD -> branch zuerst
    for (const labels of map.values()) labels.sort((a, b) => (b.includes("HEAD") ? 1 : 0) - (a.includes("HEAD") ? 1 : 0));
    return map;
  }

  private formatCommit(
    oid: string,
    commit: git.CommitObject,
    decor: Map<string, string[]>,
    oneline: boolean,
  ): string {
    const labels = decor.get(oid);
    const deco = labels ? `${C.yellow} (${C.reset}${labels.join(`${C.yellow}, ${C.reset}`)}${C.yellow})${C.reset}` : "";
    if (oneline) return `${C.yellow}${oid.slice(0, 7)}${C.reset}${deco} ${commit.message.split("\n")[0]}\n`;
    let text = `${C.yellow}commit ${oid}${C.reset}${deco}\n`;
    if (commit.parent.length > 1) text += `Merge: ${commit.parent.map((p) => p.slice(0, 7)).join(" ")}\n`;
    text += `Author: ${commit.author.name} <${commit.author.email}>\n`;
    text += `Date:   ${gitDate(commit.author.timestamp, commit.author.timezoneOffset)}\n\n`;
    text += commit.message.replace(/\n+$/, "").split("\n").map((l) => `    ${l}`).join("\n") + "\n";
    return text;
  }

  private async log(args: string[]): Promise<GitResult> {
    let oneline = false;
    let depth: number | undefined;
    let rev = "HEAD";
    let stat = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--oneline") oneline = true;
      else if (a === "--stat") stat = true;
      else if (a === "-n" || a === "--max-count") depth = parseInt(args[++i] ?? "", 10);
      else if (/^--max-count=\d+$/.test(a)) depth = parseInt(a.slice(12), 10);
      else if (/^-\d+$/.test(a)) depth = parseInt(a.slice(1), 10);
      else if (a === "--all" || a === "--graph" || a === "--decorate") continue;
      else if (!a.startsWith("-")) rev = a;
    }
    const start = await this.tryResolveRev(rev);
    if (!start) {
      if (rev === "HEAD") {
        const branch = (await this.headBranchName()) ?? "main";
        throw new GitError(`fatal: your current branch '${branch}' does not have any commits yet`);
      }
      await this.resolveRev(rev);
    }
    const commits = this.orderCommits(await git.log({ ...this.base, ref: start! })).slice(
      0,
      depth ?? Infinity,
    );
    const decor = await this.decorations();
    const parts: string[] = [];
    for (const c of commits) {
      let text = this.formatCommit(c.oid, c.commit, decor, oneline);
      if (stat) {
        const parent = c.commit.parent[0];
        const entries = await this.changes(parent ? { kind: "tree", ref: parent } : null, { kind: "tree", ref: c.oid });
        text += "\n" + (await this.diffStat(entries));
      }
      parts.push(text);
    }
    this.out += parts.join(oneline ? "" : "\n");
    return this.result(0);
  }

  /**
   * Entfernt Duplikate (isomorphic-git folgt bei Merges allen Eltern) und
   * sortiert wie git: Kinder vor Eltern, sonst neueste zuerst.
   */
  private orderCommits(commits: git.ReadCommitResult[]): git.ReadCommitResult[] {
    const byOid = new Map<string, git.ReadCommitResult>();
    const firstSeen = new Map<string, number>();
    commits.forEach((c, i) => {
      if (!byOid.has(c.oid)) {
        byOid.set(c.oid, c);
        firstSeen.set(c.oid, i);
      }
    });
    const pending = new Map<string, number>();
    for (const c of byOid.values()) {
      for (const p of c.commit.parent) if (byOid.has(p)) pending.set(p, (pending.get(p) ?? 0) + 1);
    }
    const ready = [...byOid.values()].filter((c) => !pending.get(c.oid));
    const result: git.ReadCommitResult[] = [];
    while (ready.length) {
      ready.sort(
        (a, b) =>
          b.commit.committer.timestamp - a.commit.committer.timestamp ||
          firstSeen.get(a.oid)! - firstSeen.get(b.oid)!,
      );
      const next = ready.shift()!;
      result.push(next);
      for (const p of next.commit.parent) {
        if (!byOid.has(p)) continue;
        const left = pending.get(p)! - 1;
        pending.set(p, left);
        if (left === 0) ready.push(byOid.get(p)!);
      }
    }
    return result;
  }

  private async showCmd(args: string[]): Promise<GitResult> {
    const rev = args.find((a) => !a.startsWith("-")) ?? "HEAD";
    const oid = await this.resolveRev(rev);
    const { commit } = await git.readCommit({ ...this.base, oid });
    const decor = await this.decorations();
    this.out += this.formatCommit(oid, commit, decor, args.includes("--oneline"));
    const parent = commit.parent[0];
    const entries = await this.changes(parent ? { kind: "tree", ref: parent } : null, { kind: "tree", ref: oid });
    const { text } = await this.diffText(entries);
    if (text) this.out += "\n" + text;
    return this.result(0);
  }

  private async diff(args: string[]): Promise<GitResult> {
    let staged = false;
    let stat = false;
    let nameOnly = false;
    const revs: string[] = [];
    const paths: string[] = [];
    let afterDashes = false;
    for (const a of args) {
      if (afterDashes) paths.push(a);
      else if (a === "--") afterDashes = true;
      else if (a === "--staged" || a === "--cached") staged = true;
      else if (a === "--stat") stat = true;
      else if (a === "--name-only") nameOnly = true;
      else if (a.startsWith("-")) continue;
      else if (a.includes("..")) revs.push(...a.split("..").map((r) => r || "HEAD"));
      else if (await this.tryResolveRev(a)) revs.push(a);
      else paths.push(a);
    }
    const filter = this.pathFilter(paths);
    let entries: ChangeEntry[];
    if (revs.length >= 2) {
      entries = await this.changes(
        { kind: "tree", ref: await this.resolveRev(revs[0]) },
        { kind: "tree", ref: await this.resolveRev(revs[1]) },
        filter,
      );
    } else if (staged) {
      const base = revs[0] ? await this.resolveRev(revs[0]) : await this.headOid();
      entries = await this.changes(base ? { kind: "tree", ref: base } : null, { kind: "stage" }, filter);
    } else {
      const tracked = new Set(await git.listFiles({ ...this.base }));
      const a = revs[0] ? { kind: "tree" as const, ref: await this.resolveRev(revs[0]) } : { kind: "stage" as const };
      entries = (await this.changes(a, { kind: "workdir" }, filter)).filter((e) => e.a || tracked.has(e.path));
    }
    if (nameOnly) {
      for (const e of entries) this.print(e.path);
    } else if (stat) {
      if (entries.length) this.out += await this.diffStat(entries);
    } else {
      this.out += (await this.diffText(entries)).text;
    }
    return this.result(0);
  }

  private async branch(args: string[]): Promise<GitResult> {
    const flags = args.filter((a) => a.startsWith("-"));
    const names = args.filter((a) => !a.startsWith("-"));
    const current = await this.currentBranch();
    const has = (...f: string[]) => flags.some((x) => f.includes(x));

    if (has("-d", "-D", "--delete")) {
      const force = has("-D", "--force");
      for (const name of names) {
        if (name === current) {
          throw new GitError(`error: cannot delete branch '${name}' used by worktree at '${this.dir}'`, 1);
        }
        const oid = await git.resolveRef({ ...this.base, ref: `refs/heads/${name}` }).catch(() => null);
        if (!oid) throw new GitError(`error: branch '${name}' not found.`, 1);
        const head = await this.headOid();
        if (!force && head && oid !== head) {
          const merged = await git.isDescendent({ ...this.base, oid: head, ancestor: oid }).catch(() => false);
          if (!merged) {
            throw new GitError(
              `error: the branch '${name}' is not fully merged.\nhint: If you are sure you want to delete it, run 'git branch -D ${name}'`,
              1,
            );
          }
        }
        await git.deleteBranch({ ...this.base, ref: name });
        this.print(`Deleted branch ${name} (was ${oid.slice(0, 7)}).`);
      }
      return this.result(0);
    }
    if (has("-m", "-M", "--move")) {
      const [from, to] = names.length === 1 ? [current, names[0]] : names;
      if (!from || !to) throw new GitError("fatal: branch name required");
      await git.renameBranch({ ...this.base, oldref: from, ref: to, checkout: from === current });
      return this.result(0);
    }
    if (names.length > 0 && !has("--list", "-l")) {
      const [name, start] = names;
      const object = start ? await this.resolveRev(start) : await this.headOid();
      if (!object) throw new GitError(`fatal: not a valid object name: '${current ?? "HEAD"}'`);
      const exists = await git.resolveRef({ ...this.base, ref: `refs/heads/${name}` }).catch(() => null);
      if (exists) throw new GitError(`fatal: a branch named '${name}' already exists`);
      await git.branch({ ...this.base, ref: name, object });
      return this.result(0);
    }
    const verbose = has("-v", "-vv", "--verbose");
    const branches = (await git.listBranches({ ...this.base })).sort();
    const head = await this.headOid();
    if (!current && head) this.print(`* ${C.green}(HEAD detached at ${head.slice(0, 7)})${C.reset}`);
    for (const b of branches) {
      let line = b === current ? `* ${C.green}${b}${C.reset}` : `  ${b}`;
      if (verbose) {
        const oid = await git.resolveRef({ ...this.base, ref: `refs/heads/${b}` });
        line += ` ${C.yellow}${oid.slice(0, 7)}${C.reset} ${(await this.commitSummary(oid)).slice(8)}`;
      }
      this.print(line);
    }
    return this.result(0);
  }

  private async switchToBranch(name: string): Promise<void> {
    const current = await this.currentBranch();
    if (name === current) {
      this.info(`Already on '${name}'`, true);
      return;
    }
    await git.checkout({ ...this.base, ref: name });
    this.info(`Switched to branch '${name}'`, true);
  }

  private async createAndSwitch(name: string, start?: string): Promise<void> {
    const exists = await git.resolveRef({ ...this.base, ref: `refs/heads/${name}` }).catch(() => null);
    if (exists) throw new GitError(`fatal: a branch named '${name}' already exists`);
    const object = start ? await this.resolveRev(start) : await this.headOid();
    if (!object) {
      // Noch keine Commits: nur HEAD umbiegen.
      await git.writeRef({ ...this.base, ref: "HEAD", value: `refs/heads/${name}`, symbolic: true, force: true });
    } else {
      await git.branch({ ...this.base, ref: name, object });
      await git.checkout({ ...this.base, ref: name });
    }
    this.info(`Switched to a new branch '${name}'`, true);
  }

  /** Dateien aus dem Index (oder einem Commit) ins Arbeitsverzeichnis zurückholen. */
  private async restoreFiles(specs: string[], source?: string): Promise<void> {
    const filter = this.pathFilter(specs)!;
    const kind = source ? { kind: "tree" as const, ref: await this.resolveRev(source) } : { kind: "stage" as const };
    const entries = await this.changes(kind, { kind: "workdir" }, filter);
    const known = new Set((await git.listFiles({ ...this.base, ...(source ? { ref: kind.ref } : {}) })).filter(filter));
    if (!known.size) throw new GitError(`error: pathspec '${specs[0]}' did not match any file(s) known to git`, 1);
    for (const e of entries) {
      if (!e.a) continue;
      const content = await e.a.read();
      const abs = `${this.dir}/${e.path}`;
      const parent = abs.slice(0, abs.lastIndexOf("/"));
      if (!(await this.fs.exists(parent))) await this.fs.mkdir(parent, { recursive: true });
      await this.fs.writeFile(abs, content);
    }
  }

  private async checkout(args: string[]): Promise<GitResult> {
    const dashIdx = args.indexOf("--");
    if (dashIdx >= 0) {
      const before = args.slice(0, dashIdx).filter((a) => !a.startsWith("-"));
      await this.restoreFiles(args.slice(dashIdx + 1), before[0]);
      return this.result(0);
    }
    const bIdx = args.findIndex((a) => a === "-b" || a === "-B");
    if (bIdx >= 0) {
      const name = args[bIdx + 1];
      if (!name) throw new GitError("error: switch `b' requires a value", 129);
      await this.createAndSwitch(name, args.slice(bIdx + 2).find((a) => !a.startsWith("-")));
      return this.result(0);
    }
    const target = args.find((a) => !a.startsWith("-"));
    if (!target) {
      this.printErr("usage: git checkout [<options>] <branch>");
      return this.result(129);
    }
    const isBranch = (await git.listBranches({ ...this.base })).includes(target);
    if (isBranch) {
      await this.switchToBranch(target);
      return this.result(0);
    }
    const oid = await this.tryResolveRev(target);
    if (oid) {
      await git.checkout({ ...this.base, ref: oid });
      this.printErr(`Note: switching to '${target}'.\n`);
      this.printErr("You are in 'detached HEAD' state. You can look around, make experimental");
      this.printErr("changes and commit them, and you can discard any commits you make in this");
      this.printErr("state without impacting any branches by switching back to a branch.\n");
      this.printErr(`HEAD is now at ${await this.commitSummary(oid)}`);
      return this.result(0);
    }
    await this.restoreFiles(args.filter((a) => !a.startsWith("-")));
    return this.result(0);
  }

  private async switchCmd(args: string[]): Promise<GitResult> {
    const cIdx = args.findIndex((a) => a === "-c" || a === "-C" || a === "--create");
    if (cIdx >= 0) {
      const name = args[cIdx + 1];
      if (!name) throw new GitError("error: switch `c' requires a value", 129);
      await this.createAndSwitch(name, args.slice(cIdx + 2).find((a) => !a.startsWith("-")));
      return this.result(0);
    }
    const name = args.find((a) => !a.startsWith("-"));
    if (!name) throw new GitError("fatal: missing branch or commit argument");
    if (!(await git.listBranches({ ...this.base })).includes(name)) {
      throw new GitError(`fatal: invalid reference: ${name}`);
    }
    await this.switchToBranch(name);
    return this.result(0);
  }

  private async restore(args: string[]): Promise<GitResult> {
    const stagedFlag = args.includes("--staged") || args.includes("-S");
    const worktreeFlag = args.includes("--worktree") || args.includes("-W");
    let source: string | undefined;
    const specs: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-s" || a === "--source") source = args[++i];
      else if (a.startsWith("--source=")) source = a.slice(9);
      else if (!a.startsWith("-")) specs.push(a);
    }
    if (!specs.length) throw new GitError("fatal: you must specify path(s) to restore");
    if (stagedFlag) {
      const ref = source ? await this.resolveRev(source) : await this.headOid();
      const filter = this.pathFilter(specs)!;
      const matrix = await this.matrix();
      for (const [file] of matrix) {
        if (!filter(file)) continue;
        if (ref) await git.resetIndex({ ...this.base, filepath: file, ref });
        else await git.remove({ ...this.base, filepath: file });
      }
    }
    if (!stagedFlag || worktreeFlag) await this.restoreFiles(specs, source);
    return this.result(0);
  }

  private async merge(args: string[]): Promise<GitResult> {
    const mergeHeadPath = `${this.gitdir}/MERGE_HEAD`;
    if (args.includes("--abort")) {
      if (!(await this.fs.exists(mergeHeadPath))) throw new GitError("fatal: There is no merge to abort (MERGE_HEAD missing).");
      const branch = await this.currentBranch();
      await git.checkout({ ...this.base, ref: branch ?? (await this.headOid())!, force: true });
      await this.clearMergeState();
      return this.result(0);
    }
    if (await this.fs.exists(mergeHeadPath)) {
      throw new GitError(
        "error: Merging is not possible because you have unmerged files.\nhint: Fix them up in the work tree, and then use 'git add/rm <file>'\nhint: as appropriate to mark resolution and make a commit.\nfatal: Exiting because of an unresolved conflict.",
      );
    }
    const theirsName = args.find((a) => !a.startsWith("-"));
    if (!theirsName) throw new GitError("fatal: No remote for the current branch.");
    const noFf = args.includes("--no-ff");
    const ours = await this.currentBranch();
    if (!ours) throw new GitError("fatal: merge in detached HEAD wird in der Simulation nicht unterstützt.");
    const before = await this.headOid();
    const theirs = await this.resolveRev(theirsName);
    const author = await this.author();
    const message = `Merge branch '${theirsName}'`;
    try {
      const res = await git.merge({
        ...this.base,
        ours,
        theirs,
        author,
        message,
        fastForward: !noFf,
        abortOnConflict: false,
      });
      if (res.alreadyMerged) {
        this.print("Already up to date.");
        return this.result(0);
      }
      await git.checkout({ ...this.base, ref: ours, force: true });
      const after = res.oid!;
      if (res.fastForward) {
        this.print(`Updating ${before!.slice(0, 7)}..${after.slice(0, 7)}`);
        this.print("Fast-forward");
      } else {
        this.print("Merge made by the 'ort' strategy.");
      }
      const entries = await this.changes({ kind: "tree", ref: before! }, { kind: "tree", ref: after });
      this.out += await this.diffStat(entries);
      return this.result(0);
    } catch (e) {
      const err = e as Error & { code?: string; data?: { filepaths?: string[]; bothModified?: string[] } };
      if (err.code !== "MergeConflictError") throw e;
      await this.fs.writeFile(mergeHeadPath, theirs + "\n");
      await this.fs.writeFile(`${this.gitdir}/MERGE_MSG`, message + "\n");
      await this.setUnmerged(err.data?.filepaths ?? []);
      for (const f of err.data?.filepaths ?? []) {
        this.print(`Auto-merging ${this.show(f)}`);
        this.print(`CONFLICT (content): Merge conflict in ${this.show(f)}`);
      }
      this.print("Automatic merge failed; fix conflicts and then commit the result.");
      return this.result(1);
    }
  }

  private async tag(args: string[]): Promise<GitResult> {
    const names = args.filter((a, i) => !a.startsWith("-") && !["-m", "--message"].includes(args[i - 1]));
    if (args.includes("-d") || args.includes("--delete")) {
      for (const name of names) {
        const oid = await git.resolveRef({ ...this.base, ref: `refs/tags/${name}` }).catch(() => null);
        if (!oid) throw new GitError(`error: tag '${name}' not found.`, 1);
        await git.deleteTag({ ...this.base, ref: name });
        this.print(`Deleted tag '${name}' (was ${oid.slice(0, 7)})`);
      }
      return this.result(0);
    }
    if (!names.length || args.includes("-l") || args.includes("--list")) {
      for (const t of (await git.listTags({ ...this.base })).sort()) this.print(t);
      return this.result(0);
    }
    const [name, rev] = names;
    const object = await this.resolveRev(rev ?? "HEAD");
    const mIdx = args.findIndex((a) => a === "-m" || a === "--message");
    const exists = await git.resolveRef({ ...this.base, ref: `refs/tags/${name}` }).catch(() => null);
    if (exists && !args.includes("-f")) throw new GitError(`fatal: tag '${name}' already exists`);
    if (mIdx >= 0 || args.includes("-a")) {
      const message = mIdx >= 0 ? (args[mIdx + 1] ?? "") : name;
      await git.annotatedTag({ ...this.base, ref: name, object, message, tagger: await this.author(), force: true });
    } else {
      await git.tag({ ...this.base, ref: name, object, force: true });
    }
    return this.result(0);
  }

  private async reset(args: string[]): Promise<GitResult> {
    let mode: "soft" | "mixed" | "hard" = "mixed";
    const rest: string[] = [];
    let afterDashes = false;
    const paths: string[] = [];
    for (const a of args) {
      if (afterDashes) paths.push(a);
      else if (a === "--") afterDashes = true;
      else if (a === "--soft") mode = "soft";
      else if (a === "--mixed") mode = "mixed";
      else if (a === "--hard") mode = "hard";
      else if (!a.startsWith("-")) rest.push(a);
    }
    // git reset <datei>: aus dem Index nehmen
    let target = "HEAD";
    if (rest.length && !paths.length) {
      if (await this.tryResolveRev(rest[0])) target = rest.shift()!;
      paths.push(...rest);
    } else if (rest.length) target = rest[0];

    const head = await this.headOid();
    if (paths.length) {
      const filter = this.pathFilter(paths)!;
      const ref = head ? await this.resolveRev(target) : null;
      for (const [file] of await this.matrix()) {
        if (!filter(file)) continue;
        if (ref) await git.resetIndex({ ...this.base, filepath: file, ref });
        else await git.remove({ ...this.base, filepath: file });
      }
      return this.result(0);
    }

    if (!head) throw new GitError("fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.");
    const oid = await this.resolveRev(target);
    const branch = await this.currentBranch();
    // Dateien merken, die vor dem Zurücksetzen im Index/Commit waren
    const before = new Set([
      ...(await git.listFiles({ ...this.base })),
      ...(await git.listFiles({ ...this.base, ref: oid })),
    ]);
    await git.writeRef({ ...this.base, ref: branch ? `refs/heads/${branch}` : "HEAD", value: oid, force: true });

    if (mode === "hard") {
      await git.checkout({ ...this.base, ref: branch ?? oid, force: true });
      // Dateien entfernen, die nur im alten Stand versioniert waren
      const now = new Set(await git.listFiles({ ...this.base, ref: oid }));
      for (const f of before) {
        if (!now.has(f)) {
          await this.fs.rm(`${this.dir}/${f}`, { force: true }).catch(() => {});
          await git.remove({ ...this.base, filepath: f }).catch(() => {});
        }
      }
      await this.clearMergeState();
      this.info(`HEAD is now at ${await this.commitSummary(oid)}`);
    } else if (mode === "mixed") {
      for (const f of before) await git.resetIndex({ ...this.base, filepath: f, ref: oid });
      const unstaged: string[] = [];
      for (const [file, h, w, s] of await this.matrix()) {
        if (s !== 0 && w === 0) unstaged.push(`D\t${this.show(file)}`);
        else if (h === 1 && (w === 2 || s !== 1)) unstaged.push(`M\t${this.show(file)}`);
      }
      if (unstaged.length) {
        this.print("Unstaged changes after reset:");
        for (const l of unstaged) this.print(l);
      }
    }
    return this.result(0);
  }

  private async revParse(args: string[]): Promise<GitResult> {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--show-toplevel") this.print(this.dir);
      else if (a === "--git-dir") this.print(relative(this.cwd, this.gitdir) === ".git" ? ".git" : this.gitdir);
      else if (a === "--is-inside-work-tree") this.print("true");
      else if (a === "--abbrev-ref") {
        const rev = args[++i] ?? "HEAD";
        if (rev === "HEAD") this.print((await this.currentBranch()) ?? "HEAD");
        else this.print(rev);
      } else if (a === "--short") {
        const rev = args[++i] ?? "HEAD";
        this.print((await this.resolveRev(rev)).slice(0, 7));
      } else if (!a.startsWith("-")) this.print(await this.resolveRev(a));
    }
    return this.result(0);
  }

  private async lsFiles(): Promise<GitResult> {
    for (const f of await git.listFiles({ ...this.base })) this.print(this.show(f));
    return this.result(0);
  }
}

/** Führt einen git-Befehl im virtuellen Dateisystem aus. */
export async function runGit(args: string[], ctx: GitContext): Promise<GitResult> {
  return new GitRunner(ctx.fs, ctx.cwd, ctx.env).run(args);
}

/**
 * Prüft, ob eine Kommandozeile ein eigenständiges `git commit` ohne
 * Nachricht ist – dann soll die Shell nano als Commit-Editor öffnen.
 */
export function needsCommitEditor(args: string[]): boolean {
  const rest = [...args];
  while (rest[0] === "-C" && rest[1] !== undefined) rest.splice(0, 2);
  if (rest[0] !== "commit") return false;
  for (const a of rest.slice(1)) {
    if (a === "-m" || a.startsWith("--message") || a === "-F" || a.startsWith("--file") || a === "--no-edit") return false;
    if (/^-[a-zA-Z]+$/.test(a) && /[mF]/.test(a)) return false;
    if (a === "-h" || a === "--help") return false;
  }
  return true;
}
