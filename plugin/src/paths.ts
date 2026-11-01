import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

/** Magpie runs the plugin host with the settings directory as its working directory. */
export function magpieDataDir(): string {
  return process.cwd();
}

export function stateDir(): string {
  return join(magpieDataDir(), "oh-my-aihub");
}

export function statePath(...parts: string[]): string {
  return join(stateDir(), ...parts);
}

/** The plugin's own folder (the installed copy), used for the page snapshot. */
export function pluginRoot(): string {
  return join(import.meta.dir, "..");
}

export interface ResolveOptions {
  /** override, normally OH_MY_AIHUB_MAGPIE */
  env?: string | undefined;
  /** the Magpie that started this host */
  ppid?: number;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  /** Linux /proc/<pid>/exe reader; a symlink reader, never a file reader */
  readlink?: (path: string) => string;
  /** the parent's command line */
  parentCommand?: () => string;
  /** the parent's working directory, for a relative argv[0] such as ./Magpie.app/… */
  parentCwd?: () => string;
  /** `which magpie` */
  which?: () => string;
}

function defaultParentCommand(ppid: number): string {
  return Bun.spawnSync(["ps", "-p", String(ppid), "-o", "command="]).stdout.toString().trim();
}

function defaultParentCwd(ppid: number): string {
  const out = Bun.spawnSync(["lsof", "-a", "-p", String(ppid), "-d", "cwd", "-Fn"]).stdout.toString();
  const line = out.split("\n").find((l) => l.startsWith("n"));
  return line ? line.slice(1) : "";
}

function defaultWhich(): string {
  return Bun.spawnSync(["which", "magpie"]).stdout.toString().trim();
}

function looksLikeMagpie(path: string): boolean {
  return /^magpie(\.exe)?$/i.test(basename(path));
}

/**
 * The magpie binary running this host.
 *
 * The host is a child of the magpie process, so the parent's executable is the
 * same binary with the same data directory (portable or installed). On Linux the
 * parent's path comes from `/proc/<pid>/exe`, which is a **symlink**: reading the
 * file itself would load a 60 MB executable into memory and return its bytes as
 * the path. A parent that is clearly a magpie but cannot be resolved is an error,
 * not a reason to use some other installation.
 */
export function resolveMagpieBin(opts: ResolveOptions = {}): string {
  const platform = opts.platform ?? process.platform;
  const ppid = opts.ppid ?? process.ppid;
  const exists = opts.exists ?? existsSync;
  const readlink = opts.readlink ?? readlinkSync;
  const parentCommand = opts.parentCommand ?? (() => defaultParentCommand(ppid));
  const parentCwd = opts.parentCwd ?? (() => defaultParentCwd(ppid));
  const which = opts.which ?? defaultWhich;

  const override = opts.env ?? process.env.OH_MY_AIHUB_MAGPIE;
  if (override) {
    if (exists(override)) return override;
    // An explicit override that is gone must not silently become another Magpie.
    throw new Error(`OH_MY_AIHUB_MAGPIE is set to ${override}, which does not exist`);
  }

  let unresolvedMagpie: string | null = null;

  if (platform === "linux") {
    try {
      const target = readlink(`/proc/${ppid}/exe`).replace(/ \(deleted\)$/, "");
      // The parent is often a shell or a test runner: only a program named
      // magpie is the Magpie that started this host.
      if (target && looksLikeMagpie(target)) {
        if (exists(target)) return target;
        unresolvedMagpie = target;
      }
    } catch {
      /* the parent is gone or /proc is not mounted */
    }
  }

  try {
    const cmd = parentCommand();
    const argv0 = cmd.split(/\s+/)[0] ?? "";
    if (argv0) {
      if (isAbsolute(argv0)) {
        if (looksLikeMagpie(argv0)) {
          if (exists(argv0)) return argv0;
          unresolvedMagpie = argv0;
        }
      } else {
        const cwd = parentCwd();
        if (cwd) {
          const candidate = join(cwd, argv0);
          if (looksLikeMagpie(argv0)) {
            if (exists(candidate)) return candidate;
            unresolvedMagpie = candidate;
          }
        }
      }
    }
  } catch {
    /* ps/lsof unavailable */
  }

  if (unresolvedMagpie) {
    throw new Error(
      `the magpie running this plugin host (${unresolvedMagpie}) cannot be resolved; ` +
        `refusing to fall back to another installation. Set OH_MY_AIHUB_MAGPIE to its path.`,
    );
  }

  if (platform === "darwin") {
    const app = "/Applications/magpie.app/Contents/MacOS/magpie";
    if (exists(app)) return app;
  }
  const onPath = which();
  if (onPath && exists(onPath)) return onPath;
  throw new Error("cannot locate the magpie binary (set OH_MY_AIHUB_MAGPIE to its path)");
}


export function isMac(): boolean {
  return process.platform === "darwin";
}

export function isLinux(): boolean {
  return process.platform === "linux";
}

/** Kept for callers that only need the content of a small file. */
export function readSmallFile(path: string): string {
  return readFileSync(path, "utf8");
}
