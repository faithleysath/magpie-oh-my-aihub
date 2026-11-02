// Crash-safe JSON files.
//
// The plugin's state is small and local: one JSON document per concern. A plain
// `writeFileSync` is not enough, because a process killed mid-write leaves a
// truncated file that loses every provider connection. Every write therefore
// goes to a temporary file in the same directory, is flushed with fsync, and is
// renamed over the target (rename is atomic on POSIX). The previous content is
// kept as `<file>.prev` so a document that is nevertheless unreadable (a disk
// that reordered, a hand edit) can be recovered instead of silently reset.
//
// Verified on macOS and Linux; on Windows `fsync` on a directory is not
// available, so that step is skipped and the rename still provides the swap.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/** Reads a JSON document, or null when it is missing/unreadable. */
export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* not supported everywhere (Windows); the rename is still atomic */
  }
}

function writeAtomic(path: string, body: string, mode: number, keepPrevious: boolean): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, "w", mode);
  try {
    const bytes = new TextEncoder().encode(body);
    let off = 0;
    while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // Keep the document that is being replaced, so a bad write can be undone.
  if (keepPrevious && existsSync(path)) {
    try {
      writeFileSync(`${path}.prev`, readFileSync(path), { mode });
    } catch {
      /* a missing backup never blocks the write itself */
    }
  }
  renameSync(tmp, path);
  fsyncDir(dir);
}

/** Atomically replaces a text file (the generated EasyTier TOML, for example). */
export function writeTextAtomic(path: string, body: string, mode = 0o600): void {
  writeAtomic(path, body, mode, false);
}

/** Atomically replaces a JSON file, keeping the old content in `<path>.prev`. */
export function writeJsonAtomic(path: string, value: unknown, mode = 0o600): void {
  writeAtomic(path, JSON.stringify(value, null, 1) + "\n", mode, true);
}

/**
 * Reads a document, falling back to the previous good copy. Returns where the
 * content came from so a caller can say when it recovered from `.prev`.
 */
export function readJsonWithBackup<T>(path: string): { value: T | null; from: "primary" | "previous" | "none"; error: string | null } {
  const primary = readJson<T>(path);
  if (primary !== null) return { value: primary, from: "primary", error: null };
  let error: string | null = null;
  if (existsSync(path)) {
    try {
      JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      error = String((e as Error).message ?? e);
    }
  }
  const previous = readJson<T>(`${path}.prev`);
  if (previous !== null) return { value: previous, from: "previous", error };
  return { value: null, from: "none", error };
}
