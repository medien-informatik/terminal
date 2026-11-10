/**
 * Adapter: just-bash-Dateisystem (IFileSystem) → Node-ähnliches `fs.promises`,
 * wie es isomorphic-git erwartet.
 */
import type { IFileSystem } from "just-bash";

type BufferLike = Uint8Array & { toString(encoding?: string): string };

function toBuffer(bytes: Uint8Array): BufferLike {
  const B = (globalThis as { Buffer?: { from(b: Uint8Array): BufferLike } }).Buffer;
  return B ? B.from(bytes) : (bytes as BufferLike);
}

/** Fehlercodes (ENOENT, EEXIST, …) aus den Fehlermeldungen von just-bash übernehmen. */
function withCode<T>(promise: Promise<T>): Promise<T> {
  return promise.catch((err: unknown) => {
    const e = err instanceof Error ? err : new Error(String(err));
    const anyErr = e as Error & { code?: string };
    if (!anyErr.code) {
      const m = /\b(E[A-Z]{2,})\b/.exec(e.message);
      anyErr.code = m ? m[1] : /not found|no such/i.test(e.message) ? "ENOENT" : "EIO";
    }
    throw anyErr;
  });
}

function inoFor(path: string): number {
  let h = 2166136261;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

async function statOf(fs: IFileSystem, path: string, link: boolean) {
  const s = await withCode(link ? fs.lstat(path) : fs.stat(path));
  const typeBits = s.isSymbolicLink ? 0o120000 : s.isDirectory ? 0o040000 : 0o100000;
  const perm = s.mode & 0o7777 || (s.isDirectory ? 0o755 : 0o644);
  const mtimeMs = s.mtime instanceof Date ? s.mtime.getTime() : Date.now();
  return {
    type: s.isSymbolicLink ? "symlink" : s.isDirectory ? "dir" : "file",
    mode: typeBits | perm,
    size: s.size,
    ino: typeof s.ino === "number" ? s.ino : inoFor(path),
    mtimeMs,
    ctimeMs: mtimeMs,
    uid: 1000,
    gid: 1000,
    dev: 1,
    isFile: () => s.isFile,
    isDirectory: () => s.isDirectory,
    isSymbolicLink: () => s.isSymbolicLink,
  };
}

export function createGitFs(fs: IFileSystem) {
  return {
    promises: {
      async readFile(path: string, options?: { encoding?: string } | string) {
        const encoding = typeof options === "string" ? options : options?.encoding;
        if (encoding === "utf8" || encoding === "utf-8") {
          return withCode(fs.readFile(path));
        }
        return toBuffer(await withCode(fs.readFileBuffer(path)));
      },
      async writeFile(path: string, data: string | Uint8Array, options?: { mode?: number } | string) {
        await withCode(fs.writeFile(path, data));
        const mode = typeof options === "object" ? options?.mode : undefined;
        if (mode && mode & 0o111) await fs.chmod(path, 0o755).catch(() => {});
      },
      unlink: (path: string) => withCode(fs.rm(path)),
      readdir: (path: string) => withCode(fs.readdir(path)),
      async mkdir(path: string) {
        if (await fs.exists(path)) {
          const err = new Error(`EEXIST: file already exists, mkdir '${path}'`) as Error & { code: string };
          err.code = "EEXIST";
          throw err;
        }
        await withCode(fs.mkdir(path));
      },
      async rmdir(path: string) {
        const entries = await withCode(fs.readdir(path));
        if (entries.length > 0) {
          const err = new Error(`ENOTEMPTY: directory not empty, rmdir '${path}'`) as Error & { code: string };
          err.code = "ENOTEMPTY";
          throw err;
        }
        await withCode(fs.rm(path, { recursive: true }));
      },
      stat: (path: string) => statOf(fs, path, false),
      lstat: (path: string) => statOf(fs, path, true),
      readlink: (path: string) => withCode(fs.readlink(path)),
      symlink: (target: string, path: string) => withCode(fs.symlink(target, path)),
      chmod: (path: string, mode: number) => withCode(fs.chmod(path, mode)),
    },
  };
}
