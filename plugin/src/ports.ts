// Automatic port claims for the plugin's own listeners and for the ones the
// supervised EasyTier core owns.
//
// Two rules shape this module:
//
//   1. A port is never *chosen* by binding, closing and hoping. Either the
//      claim holds the socket until the real listener takes over, or the child
//      that should own it has to prove after start that it really listens.
//   2. A port that cannot be proven is a failure, not a retry-forever. When the
//      proof fails the caller migrates the port and rewrites the state that
//      names it (catalogue, ACL, forward, Remote Magpie URL); a listener that
//      belongs to some other process is never used for an overlay connection.
//
// The ledger is persisted with the plugin state: the chosen ports live in the
// config, and this ledger records what was migrated and when it was last
// verified, so a restart shows the truth instead of a fresh "everything fine".

export type PortPurpose =
  | "overlay-listen"
  | "easytier-rpc"
  | "catalog"
  | "catalog-socks"
  | "gateway"
  | "forward"
  | "control"
  | "console"
  | "api";

export type PortOwner = "plugin" | "easytier" | "magpie" | "unknown";

export type PortState = "stable" | "migrated" | "conflict" | "unverified" | "failed" | "unknown";

/**
 * Where a listener can actually be reached. B-service's control listener must
 * report "lan" when it binds a LAN address: calling that "overlay-only" would
 * misstate the security boundary.
 */
export type PortReachability = "loopback" | "overlay" | "lan" | "unknown";

export interface PortMigration {
  at: string;
  purpose: PortPurpose;
  from: number;
  to: number;
  reason: string;
}

export interface PortEvidence {
  purpose: PortPurpose;
  port: number;
  host: string;
  owner: PortOwner;
  state: PortState;
  /** defaults from the host when absent */
  reachability?: PortReachability;
  /** when the proof ran, never when a page was rendered */
  verifiedAt: string;
  detail: string | null;
}

export interface PortLedger {
  version: 1;
  migrations: PortMigration[];
  /** latest proof per (purpose, port); a restart re-proves, never trusts this */
  evidence: PortEvidence[];
}

export const PORT_MIGRATION_LIMIT = 50;
export const PORT_EVIDENCE_LIMIT = 64;

export function emptyPortLedger(): PortLedger {
  return { version: 1, migrations: [], evidence: [] };
}

const PURPOSES: ReadonlySet<string> = new Set<PortPurpose>([
  "overlay-listen",
  "easytier-rpc",
  "catalog",
  "catalog-socks",
  "gateway",
  "forward",
  "control",
  "console",
  "api",
]);
const OWNERS: ReadonlySet<string> = new Set<PortOwner>(["plugin", "easytier", "magpie", "unknown"]);
const STATES: ReadonlySet<string> = new Set<PortState>(["stable", "migrated", "conflict", "unverified", "failed", "unknown"]);
const REACHABILITY: ReadonlySet<string> = new Set<PortReachability>(["loopback", "overlay", "lan", "unknown"]);

/** The reachability a host address implies, when the caller does not know better. */
export function reachabilityOf(host: string | null | undefined): PortReachability {
  if (!host) return "unknown";
  const h = host.trim().replace(/^\[|\]$/g, "");
  if (h === "127.0.0.1" || h === "localhost" || h === "::1" || h.startsWith("127.")) return "loopback";
  if (h === "0.0.0.0" || h === "::") return "lan";
  if (/^10\.77\.\d{1,3}\.\d{1,3}$/.test(h)) return "overlay";
  return "lan";
}

function portNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

function shortText(value: unknown, max = 200): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

/** Reads a persisted ledger without trusting it; unknown entries are dropped. */
export function normalizePortLedger(raw: unknown): PortLedger {
  const rec = raw as Partial<PortLedger> | null;
  const migrations: PortMigration[] = [];
  const evidence: PortEvidence[] = [];
  if (rec && Array.isArray(rec.migrations)) {
    for (const m of rec.migrations) {
      if (!m || typeof m !== "object") continue;
      const from = portNumber((m as PortMigration).from);
      const to = portNumber((m as PortMigration).to);
      const purpose = String((m as PortMigration).purpose ?? "");
      if (!from || !to || !PURPOSES.has(purpose)) continue;
      migrations.push({
        at: typeof m.at === "string" ? m.at : new Date(0).toISOString(),
        purpose: purpose as PortPurpose,
        from,
        to,
        reason: shortText(m.reason, 300) ?? "migrated",
      });
    }
  }
  if (rec && Array.isArray(rec.evidence)) {
    for (const e of rec.evidence) {
      if (!e || typeof e !== "object") continue;
      const port = portNumber((e as PortEvidence).port);
      const purpose = String((e as PortEvidence).purpose ?? "");
      const owner = String((e as PortEvidence).owner ?? "unknown");
      const state = String((e as PortEvidence).state ?? "unverified");
      if (!port || !PURPOSES.has(purpose)) continue;
      const reach = String((e as PortEvidence).reachability ?? "");
      const host = shortText(e.host, 120) ?? "127.0.0.1";
      evidence.push({
        purpose: purpose as PortPurpose,
        port,
        host,
        owner: (OWNERS.has(owner) ? owner : "unknown") as PortOwner,
        state: (STATES.has(state) ? state : "unverified") as PortState,
        // A persisted record from before the field existed still states a
        // boundary: derive it from the recorded bind address.
        reachability: (REACHABILITY.has(reach) ? reach : reachabilityOf(host)) as PortReachability,
        verifiedAt: typeof e.verifiedAt === "string" ? e.verifiedAt : new Date(0).toISOString(),
        detail: shortText(e.detail, 300),
      });
    }
  }
  return {
    version: 1,
    migrations: migrations.slice(-PORT_MIGRATION_LIMIT),
    evidence: evidence.slice(-PORT_EVIDENCE_LIMIT),
  };
}

/** Replaces the proof for one (purpose, port); the newest proof wins. */
export function recordPortEvidence(ledger: PortLedger, entry: PortEvidence): PortLedger {
  const kept = ledger.evidence.filter((e) => !(e.purpose === entry.purpose && e.port === entry.port));
  kept.push(entry);
  return { ...ledger, evidence: kept.slice(-PORT_EVIDENCE_LIMIT) };
}

/** Appends a migration, keeping the newest entries. */
export function recordPortMigration(ledger: PortLedger, entry: PortMigration): PortLedger {
  return { ...ledger, migrations: [...ledger.migrations, entry].slice(-PORT_MIGRATION_LIMIT) };
}

export function evidenceFor(ledger: PortLedger | undefined, purpose: PortPurpose, port: number): PortEvidence | null {
  if (!ledger) return null;
  const found = ledger.evidence.find((e) => e.purpose === purpose && e.port === port);
  return found ? { ...found } : null;
}

/** A held socket. Closing it hands the port to the real listener. */
export interface PortReservation {
  host: string;
  port: number;
  release(): Promise<void>;
}

export interface PortBinder {
  /**
   * Binds and keeps the socket. Resolves null when the address is unavailable.
   * This is the only way this module *chooses* a port.
   */
  reserve(host: string, port: number): Promise<PortReservation | null>;
  /** True when nothing answers a bind right now. Detection only, never allocation. */
  isFree(host: string, port: number): Promise<boolean>;
}

/** The production binder: a real TCP listening socket held by this process. */
export class SocketBinder implements PortBinder {
  async reserve(host: string, port: number): Promise<PortReservation | null> {
    const { createServer } = await import("node:net");
    return new Promise<PortReservation | null>((resolve) => {
      const server = createServer();
      let settled = false;
      const finish = (value: PortReservation | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      server.once("error", () => finish(null));
      server.listen({ host, port }, () => {
        server.removeAllListeners("error");
        const address = server.address();
        const bound = address && typeof address === "object" ? address.port : port;
        finish({
          host,
          port: bound,
          release: () =>
            new Promise<void>((done) => {
              let closed = false;
              const finishClose = () => {
                if (closed) return;
                closed = true;
                done();
              };
              try {
                server.close(finishClose);
              } catch {
                finishClose();
              }
            }),
        });
      });
    });
  }

  async isFree(host: string, port: number): Promise<boolean> {
    const held = await this.reserve(host, port);
    if (!held) return false;
    await held.release();
    return true;
  }
}

export interface ClaimResult {
  reservation: PortReservation;
  /** candidates that were taken, for the diagnostic */
  skipped: number[];
}

/**
 * Reserves the first free candidate and keeps it. The caller must release it
 * only when the real listener is about to bind; a plugin-owned listener can
 * simply keep it (Bun/Node reuse the same port after close is not allowed).
 */
export async function claimFreePort(
  binder: PortBinder,
  host: string,
  candidates: number[],
  opts: { exclude?: Iterable<number> } = {},
): Promise<ClaimResult> {
  const skip = new Set(opts.exclude ?? []);
  const skipped: number[] = [];
  for (const port of candidates) {
    if (skip.has(port)) {
      skipped.push(port);
      continue;
    }
    const reservation = await binder.reserve(host, port);
    if (reservation) return { reservation, skipped };
    skipped.push(port);
  }
  const range = candidates.length ? `${candidates[0]}-${candidates[candidates.length - 1]}` : "none";
  throw new Error(`no free port for ${host} in ${range}`);
}

export interface PortProof {
  state: PortState;
  detail: string | null;
  /** listening PIDs the OS reported, or null when the probe was unavailable */
  pids: number[] | null;
  /** whether the OS socket-owner probe ran */
  ownership: "os" | "unavailable" | "none";
  reported: boolean | null;
}

/** The OS's answer to "which process listens on this TCP port?". */
export interface SocketOwnership {
  supported: boolean;
  pids: number[];
  detail: string | null;
}

export interface SocketOwnershipProbe {
  /** Never throws: an unavailable probe is `{supported:false}`, i.e. unknown. */
  listenerPids(port: number): Promise<SocketOwnership>;
}

async function runCommand(cmd: string[], timeoutMs = 5000): Promise<{ code: number; stdout: string }> {
  try {
    const proc = Bun.spawn({ cmd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    clearTimeout(timer);
    return { code, stdout };
  } catch {
    return { code: -1, stdout: "" };
  }
}

/**
 * The real socket-owner probe.
 *
 * Linux: `ss -lntpH` (`users:((...,pid=123,...))`), falling back to lsof.
 * macOS: `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fpc`.
 * Anything else (notably Windows without those tools) answers `supported:false`;
 * the caller must treat that as unknown, never as "stable".
 */
export class OsSocketOwnership implements SocketOwnershipProbe {
  async listenerPids(port: number): Promise<SocketOwnership> {
    if (process.platform === "linux") {
      const ss = await runCommand(["ss", "-lntpH", `sport = :${port}`]);
      if (ss.code === 0) {
        const pids = [...ss.stdout.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
        return { supported: true, pids: [...new Set(pids)], detail: null };
      }
      return this.lsof(port);
    }
    if (process.platform === "darwin") return this.lsof(port);
    return {
      supported: false,
      pids: [],
      detail: `no socket-owner probe is implemented for ${process.platform}; a listener cannot be attributed to a process`,
    };
  }

  private async lsof(port: number): Promise<SocketOwnership> {
    const r = await runCommand(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"]);
    if (r.code !== 0 && !r.stdout.trim()) {
      // lsof exits 1 when nothing matches; distinguish "not installed" by the
      // empty output plus a shell-level failure.
      return { supported: false, pids: [], detail: "lsof is unavailable; the listener owner cannot be proven" };
    }
    const pids = [...r.stdout.matchAll(/^p(\d+)$/gm)].map((m) => Number(m[1]));
    return { supported: true, pids: [...new Set(pids)], detail: null };
  }
}

/**
 * Proves that the *expected live process* owns the listening socket.
 *
 * `reported` is only the child's own claim or the plugin's bind success; it is
 * never enough. The OS must report a listener, and one of its PIDs must be in
 * `expectedPids` (the supervised child's live PID, or this plugin's PID for its
 * own listeners). No probe, no expected PID, a foreign PID or no listener all
 * fail closed as `unverified`/`conflict`/`failed` — never `stable`.
 */
export async function verifyOwnedPort(input: {
  ownership: SocketOwnershipProbe;
  purpose: PortPurpose;
  host: string;
  port: number;
  owner: PortOwner;
  reported: boolean | null;
  /** the live PIDs allowed to own this port; empty = no proof possible */
  expectedPids: number[];
  now?: () => Date;
}): Promise<PortProof> {
  const reported = input.reported;
  if (reported === null) {
    return { state: "unverified", detail: "no listener evidence was read", pids: null, ownership: "none", reported: null };
  }
  if (!reported) {
    return {
      state: "failed",
      detail: `${input.owner} does not hold ${input.host}:${input.port}`,
      pids: null,
      ownership: "none",
      reported: false,
    };
  }
  const expected = input.expectedPids.filter((p) => Number.isInteger(p) && p > 0);
  if (expected.length === 0) {
    return {
      state: "unverified",
      detail: `no live process identity is available for ${input.host}:${input.port}; a configuration claim is not ownership`,
      pids: null,
      ownership: "none",
      reported: true,
    };
  }
  const found = await input.ownership.listenerPids(input.port);
  if (!found.supported) {
    return {
      state: "unverified",
      detail: found.detail ?? "the OS socket-owner probe is unavailable on this platform; refusing to call the port stable",
      pids: null,
      ownership: "unavailable",
      reported: true,
    };
  }
  if (found.pids.length === 0) {
    return {
      state: "failed",
      detail: `${input.owner} claims ${input.host}:${input.port} but no process listens`,
      pids: [],
      ownership: "os",
      reported: true,
    };
  }
  if (!found.pids.some((pid) => expected.includes(pid))) {
    return {
      state: "conflict",
      detail: `${input.host}:${input.port} is held by pid ${found.pids.join(",")}, not the supervised process (${expected.join(",")}); refusing to use it`,
      pids: found.pids,
      ownership: "os",
      reported: true,
    };
  }
  return { state: "stable", detail: null, pids: found.pids, ownership: "os", reported: true };
}

/** Builds the portable evidence record from a proof. */
export function proofEvidence(input: {
  purpose: PortPurpose;
  host: string;
  port: number;
  owner: PortOwner;
  proof: PortProof;
  reachability?: PortReachability;
  at?: Date;
}): PortEvidence {
  return {
    purpose: input.purpose,
    port: input.port,
    host: input.host,
    owner: input.owner,
    state: input.proof.state,
    reachability: input.reachability ?? reachabilityOf(input.host),
    verifiedAt: (input.at ?? new Date()).toISOString(),
    detail: input.proof.detail,
  };
}

/** Integer port list for an inclusive range. */
export function portRange(from: number, to: number): number[] {
  const out: number[] = [];
  for (let p = from; p <= to; p++) out.push(p);
  return out;
}
