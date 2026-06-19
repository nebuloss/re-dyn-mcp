/**
 * gdb.ts — a thin async driver for one gdb-multiarch process over GDB/MI.
 *
 * Single serialized session (matches a single QEMU gdbstub target). Commands are
 * token-tagged; each resolves on its matching MI result record (^done/^error/…).
 * Execution commands (continue/step/…) return ^running, then we await the next
 * `*stopped` async record (bounded by a timeout) so the caller learns where the
 * target halted.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { log } from "./util.js";

export interface MiResult {
  class: string; // done | error | running | connected | exit
  payload: string; // raw MI result body (key=value,…)
  console: string; // accumulated ~"…" stream output for this command
}

export interface StopInfo {
  stopped: boolean;
  raw: string; // the raw *stopped record (or "" if none / timeout)
  reason?: string;
  addr?: string;
  func?: string;
  file?: string;
  line?: string;
  note?: string;
}

const EXEC_RE = /^-exec-(continue|step|next|finish|until|step-instruction|next-instruction)\b/;

export class GdbSession {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private token = 0;
  private buf = "";
  private pending: { token: number; resolve: (r: MiResult) => void; reject: (e: Error) => void } | null = null;
  private consoleBuf = "";
  private stopResolve: ((s: string) => void) | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  readonly gdbPath: string;

  constructor(gdbPath = process.env.GDB_BIN ?? "gdb-multiarch") {
    this.gdbPath = gdbPath;
  }

  get running(): boolean {
    return !!this.proc && !this.proc.killed;
  }

  /** (Re)start the gdb process. */
  start(): void {
    this.kill();
    this.proc = spawn(this.gdbPath, ["--interpreter=mi3", "-nx", "-q"], { stdio: ["pipe", "pipe", "pipe"] });
    this.buf = "";
    this.proc.stdout.on("data", (d) => this.onData(d.toString("utf8")));
    this.proc.stderr.on("data", (d) => log.debug("gdb stderr:", d.toString("utf8").trim()));
    this.proc.on("exit", (code) => {
      log.info(`gdb exited (${code})`);
      this.proc = null;
      if (this.pending) {
        this.pending.reject(new Error(`gdb exited (${code})`));
        this.pending = null;
      }
    });
  }

  kill(): void {
    if (this.proc) {
      try {
        this.proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      this.proc = null;
    }
  }

  private onData(s: string): void {
    this.buf += s;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, "");
      this.buf = this.buf.slice(nl + 1);
      this.onLine(line);
    }
  }

  private onLine(line: string): void {
    if (line === "(gdb)" || line === "") return;
    // stream records: ~ console, @ target, & log
    if (line[0] === "~" || line[0] === "@" || line[0] === "&") {
      try {
        this.consoleBuf += JSON.parse(line.slice(1)) as string;
      } catch {
        this.consoleBuf += line.slice(1);
      }
      return;
    }
    // async exec record: *stopped,... (also *running)
    if (line[0] === "*") {
      if (line.startsWith("*stopped") && this.stopResolve) {
        const r = this.stopResolve;
        this.stopResolve = null;
        r(line);
      }
      return;
    }
    // notify/status async (= and +) — ignore
    if (line[0] === "=" || line[0] === "+") return;
    // result record: <token>^class[,payload]
    const m = line.match(/^(\d*)\^([a-z-]+)(?:,(.*))?$/);
    if (m && this.pending && (m[1] === "" || Number(m[1]) === this.pending.token)) {
      const p = this.pending;
      this.pending = null;
      const cls = m[2];
      const res: MiResult = { class: cls, payload: m[3] ?? "", console: this.consoleBuf };
      this.consoleBuf = "";
      p.resolve(res);
    }
  }

  /** Send one MI command, serialized; resolves on its result record. */
  mi(command: string, opts?: { timeoutMs?: number }): Promise<MiResult> {
    const run = this.chain.then(() => this.send(command, opts?.timeoutMs ?? 30_000));
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private send(command: string, timeoutMs: number): Promise<MiResult> {
    if (!this.proc) return Promise.reject(new Error("gdb not started — call gdb_connect first"));
    const tok = ++this.token;
    this.consoleBuf = "";
    return new Promise<MiResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.token === tok) this.pending = null;
        reject(new Error(`gdb command timed out after ${Math.round(timeoutMs / 1000)}s: ${command}`));
      }, timeoutMs);
      this.pending = {
        token: tok,
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this.proc!.stdin.write(`${tok}${command}\n`);
    });
  }

  /** Execution command: returns ^running then awaits the next *stopped (bounded). */
  async execAndWait(miCommand: string, stopTimeoutMs = 20_000): Promise<{ result: MiResult; stop: StopInfo }> {
    const stopPromise = new Promise<string>((resolve) => {
      this.stopResolve = resolve;
      setTimeout(() => {
        if (this.stopResolve === resolve) {
          this.stopResolve = null;
          resolve("");
        }
      }, stopTimeoutMs);
    });
    const result = await this.mi(miCommand, { timeoutMs: stopTimeoutMs + 5_000 });
    if (result.class === "error") {
      this.stopResolve = null;
      return { result, stop: { stopped: false, raw: "" } };
    }
    const rawStop = await stopPromise;
    return { result, stop: parseStop(rawStop) };
  }

  isExec(miCommand: string): boolean {
    return EXEC_RE.test(miCommand);
  }

  /** Halt a running target by signalling gdb (like interactive Ctrl-C); robust
   *  for remote stubs where -exec-interrupt is flaky. Awaits the *stopped. */
  interrupt(timeoutMs = 8_000): Promise<StopInfo> {
    if (!this.proc) return Promise.reject(new Error("gdb not started"));
    return new Promise<StopInfo>((resolve) => {
      let done = false;
      const finish = (raw: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(parseStop(raw));
      };
      const timer = setTimeout(() => {
        if (this.stopResolve === finish) this.stopResolve = null;
        finish("");
      }, timeoutMs);
      this.stopResolve = finish;
      try {
        this.proc!.kill("SIGINT");
      } catch {
        /* ignore */
      }
    });
  }
}

function field(raw: string, key: string): string | undefined {
  const m = raw.match(new RegExp(`${key}="((?:[^"\\\\]|\\\\.)*)"`));
  return m ? m[1] : undefined;
}

export function parseStop(raw: string): StopInfo {
  if (!raw) return { stopped: false, raw: "", note: "no stop within timeout — target still running (set a breakpoint or gdb_interrupt)" };
  return {
    stopped: true,
    raw,
    reason: field(raw, "reason"),
    addr: field(raw, "addr"),
    func: field(raw, "func"),
    file: field(raw, "fullname") ?? field(raw, "file"),
    line: field(raw, "line"),
  };
}
