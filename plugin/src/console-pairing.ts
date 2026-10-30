import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

export interface PendingPairing {
  id: string;
  code: string;
  expiresAt: string;
}
export interface BrowserPairing extends PendingPairing {
  /** Returned only once to the requesting browser, never published or persisted. */
  secret: string;
}
interface PairingRecord {
  id: string;
  code: string;
  secretHash: string;
  createdAt: number;
  expiresAt: number;
  state: "pending" | "approved" | "consumed";
}
interface Journal {
  version: 1;
  records: PairingRecord[];
}

const TTL = 120_000;
const MAX_RECORDS = 8;
const MAX_FILE = 16 * 1024;
const ID = /^[0-9a-f]{32}$/;
const SECRET = /^[0-9a-f]{64}$/;
const CODE = /^[0-9]{8}$/;

/** Fixed errors deliberately carry no path, browser secret or parsed file content. */
export class PairingUnavailableError extends Error {
  constructor() { super("pairing store unavailable"); }
}
export class PairingCapacityError extends Error {
  constructor() { super("pairing limit reached"); }
}

function hashSecret(secret: string): string {
  return createHash("sha256").update("ohmyaihub/browser-pairing/v1\0").update(secret).digest("hex");
}
function publicRecord(record: PairingRecord): PendingPairing {
  return { id: record.id, code: record.code, expiresAt: new Date(record.expiresAt).toISOString() };
}
function keysEqual(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function validJournal(value: unknown): value is Journal {
  if (!value || typeof value !== "object" || Array.isArray(value) || !keysEqual(value, ["version", "records"])) return false;
  const journal = value as Journal;
  if (journal.version !== 1 || !Array.isArray(journal.records) || journal.records.length > MAX_RECORDS) return false;
  const ids = new Set<string>();
  for (const r of journal.records) {
    if (!r || typeof r !== "object" || Array.isArray(r) || !keysEqual(r, ["id", "code", "secretHash", "createdAt", "expiresAt", "state"])) return false;
    if (typeof r.id !== "string" || !ID.test(r.id) || ids.has(r.id) || typeof r.code !== "string" || !CODE.test(r.code) ||
        typeof r.secretHash !== "string" || !SECRET.test(r.secretHash) ||
        !Number.isSafeInteger(r.createdAt) || !Number.isSafeInteger(r.expiresAt) || r.createdAt < 0 ||
        r.expiresAt <= r.createdAt || r.expiresAt - r.createdAt > TTL || r.expiresAt > 8_640_000_000_000_000 ||
        !["pending", "approved", "consumed"].includes(r.state)) return false;
    ids.add(r.id);
  }
  return true;
}

/**
 * Short-lived pre-auth journal. The host lock must have one owner per data
 * directory. Every operation reloads durable state; no backup can revive a
 * consumed request. Authentication is never reconstructed from this file.
 */
export class ConsolePairingJournal {
  private failed = false;
  private readonly directory: string;

  constructor(private readonly file: string, private readonly now: () => number = Date.now) {
    if (!isAbsolute(file)) throw new PairingUnavailableError();
    this.directory = dirname(file);
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const directory = lstatSync(this.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error();
      chmodSync(this.directory, 0o700);
      try {
        lstatSync(file);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        this.save({ version: 1, records: [] });
      }
      this.load();
    } catch {
      this.failed = true;
    }
  }

  private load(): Journal {
    if (this.failed) throw new PairingUnavailableError();
    let fd: number | undefined;
    try {
      // A missing/replaced journal after initialization is uncertain, never an empty store.
      const stat = lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE || stat.nlink !== 1) throw new Error();
      fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size > MAX_FILE || opened.nlink !== 1) throw new Error();
      fchmodSync(fd, 0o600);
      const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
      if (!validJournal(value)) throw new Error();
      // Future-dated records cannot gain validity after the clock moves backwards.
      if (value.records.some((record) => record.createdAt > this.now())) throw new Error();
      return value;
    } catch {
      this.failed = true;
      throw new PairingUnavailableError();
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private save(journal: Journal): void {
    if (this.failed) throw new PairingUnavailableError();
    const temporary = `${this.file}.${randomBytes(16).toString("hex")}.tmp`;
    let fd: number | undefined;
    let directoryFd: number | undefined;
    try {
      // Refuse symlink/replace attacks instead of writing to an unexpected target.
      const directory = lstatSync(this.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error();
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeFileSync(fd, JSON.stringify(journal) + "\n", "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, this.file);
      directoryFd = openSync(this.directory, constants.O_RDONLY);
      fsyncSync(directoryFd);
    } catch {
      this.failed = true;
      throw new PairingUnavailableError();
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (directoryFd !== undefined) closeSync(directoryFd);
      try { unlinkSync(temporary); } catch { /* renamed or never created */ }
    }
  }

  pending(): PendingPairing[] {
    return this.load().records.filter((record) => record.state !== "consumed" && record.expiresAt > this.now()).map(publicRecord);
  }

  create(): BrowserPairing {
    const journal = this.load();
    // Retain consumed tombstones until their expiry, bounding repeated request
    // generation even when each request is approved/consumed immediately.
    journal.records = journal.records.filter((record) => record.expiresAt > this.now());
    if (journal.records.length >= MAX_RECORDS) throw new PairingCapacityError();
    const secret = randomBytes(32).toString("hex");
    const time = this.now();
    const record: PairingRecord = {
      id: randomBytes(16).toString("hex"), code: String(randomInt(100_000_000)).padStart(8, "0"),
      secretHash: hashSecret(secret), createdAt: time, expiresAt: time + TTL, state: "pending",
    };
    journal.records.push(record);
    this.save(journal);
    return { ...publicRecord(record), secret };
  }

  approve(id: string, code: string): boolean {
    const journal = this.load();
    if (typeof id !== "string" || !ID.test(id) || typeof code !== "string" || !CODE.test(code)) return false;
    const record = journal.records.find((r) => r.id === id);
    if (!record || record.code !== code || record.expiresAt <= this.now() || record.state === "consumed") return false;
    if (record.state === "approved") return true;
    record.state = "approved";
    this.save(journal);
    return true;
  }

  inspect(id: unknown, secret: unknown): "invalid" | "pending" | "approved" {
    const journal = this.load();
    if (typeof id !== "string" || !ID.test(id) || typeof secret !== "string" || !SECRET.test(secret)) return "invalid";
    const record = journal.records.find((r) => r.id === id);
    if (!record || record.state === "consumed" || record.expiresAt <= this.now()) return "invalid";
    if (!timingSafeEqual(Buffer.from(record.secretHash, "hex"), Buffer.from(hashSecret(secret), "hex"))) return "invalid";
    return record.state;
  }

  /** Must finish durably before the transport mints any NEW in-memory session. */
  consume(id: unknown, secret: unknown): boolean {
    if (this.inspect(id, secret) !== "approved") return false;
    const journal = this.load();
    const record = journal.records.find((r) => r.id === id)!;
    record.state = "consumed";
    this.save(journal);
    return true;
  }
}
