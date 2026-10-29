import { registerSecret } from "./log.ts";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  /** milliseconds; the child is killed when it runs longer */
  timeoutMs?: number;
  /** extra environment */
  env?: Record<string, string>;
  /** called for every complete stderr line (for long-running processes) */
  onStderrLine?: (line: string) => void;
  cwd?: string;
}

/**
 * Runs a program with an argv array. There is no shell anywhere in this module:
 * every argument reaches the child as one argument, so a network name, a key or a
 * path containing quotes, spaces or `;` can never become a command.
 */
export async function run(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== "string")) {
    throw new Error("run(): argv must be a non-empty array of strings");
  }
  const proc = Bun.spawn({
    cmd: argv,
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = opts.timeoutMs ?? 30_000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }, timeout);

  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = opts.onStderrLine
    ? readLines(proc.stderr, opts.onStderrLine)
    : new Response(proc.stderr).text();

  const [stdout, stderr, code] = await Promise.all([stdoutPromise, stderrPromise, proc.exited]);
  clearTimeout(timer);
  for (const line of stdout.split("\n")) {
    const m = /^\s*(sk-[A-Za-z0-9._-]{12,})\s*$/.exec(line);
    if (m) registerSecret(m[1]);
  }
  return { code, stdout, stderr, timedOut };
}

async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let rest = "";
  let all = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    all += text;
    rest += text;
    let idx = rest.indexOf("\n");
    while (idx >= 0) {
      const line = rest.slice(0, idx);
      rest = rest.slice(idx + 1);
      if (line.trim()) onLine(line);
      idx = rest.indexOf("\n");
    }
  }
  if (rest.trim()) onLine(rest);
  return all;
}

/** Runs a program and throws unless it exits 0. */
export async function runOk(argv: string[], opts: RunOptions = {}): Promise<string> {
  const r = await run(argv, opts);
  if (r.code !== 0) {
    const why = r.timedOut ? "timed out" : `exit ${r.code}`;
    throw new Error(`${argv[0]} ${argv.slice(1, 3).join(" ")} failed (${why}): ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
  }
  return r.stdout;
}
