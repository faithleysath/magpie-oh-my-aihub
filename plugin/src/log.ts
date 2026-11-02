import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./paths.ts";

export type Level = "debug" | "info" | "warn" | "error";

/** Values that must never appear in a log line, no matter who logs them. */
const secrets = new Set<string>();

export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 8) secrets.add(value);
}

export function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join("<redacted>");
  // gateway keys and bearer tokens, even when they were not registered
  out = out.replace(/sk-[A-Za-z0-9._-]{12,}/g, "<redacted-key>");
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._-]{12,}/gi, "$1<redacted>");
  out = out.replace(/(network_secret\s*=\s*")[^"]+(")/gi, "$1<redacted>$2");
  out = out.replace(/(local-private-key[= ]+)[A-Za-z0-9+/=_-]{16,}/gi, "$1<redacted>");
  // the same key as it appears in a generated TOML (`local_private_key = "…"`)
  out = out.replace(/(local_private_key\s*=\s*")[^"]+(")/gi, "$1<redacted>$2");
  return out;
}

function logFile(): string {
  return join(stateDir(), "plugin.log");
}

let ready = false;
/** Keep the host's log bounded; a long-lived watcher is noisy by nature. */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

function ensureDir(): void {
  if (ready) return;
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  ready = true;
}

function rotateIfNeeded(path: string): void {
  try {
    if (!existsSync(path) || statSync(path).size <= MAX_LOG_BYTES) return;
    rmSync(`${path}.1`, { force: true });
    renameSync(path, `${path}.1`);
  } catch {
    /* rotation is best effort, exactly like the log itself */
  }
}

export function log(level: Level, message: string): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${redact(message)}`;
  try {
    ensureDir();
    const file = logFile();
    rotateIfNeeded(file);
    appendFileSync(file, line + "\n", { mode: 0o600 });
  } catch {
    /* the log is best effort */
  }
  console.error(`[oh-my-aihub] ${line}`);
}

export const logger = {
  debug: (m: string) => log("debug", m),
  info: (m: string) => log("info", m),
  warn: (m: string) => log("warn", m),
  error: (m: string) => log("error", m),
};
