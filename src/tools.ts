/**
 * tools.ts — dynamic-analysis tools driving one gdb-multiarch session against
 * the QEMU dhd harness gdbstub. One process-global GdbSession (one target).
 *
 * Workflow: start the harness with GDB=1 (gdbstub on :1234, CPU halted), then
 *   gdb_connect -> gdb_break <sym> -> gdb_continue -> gdb_regs/gdb_mem/gdb_bt.
 *
 * Env: HARNESS_GDB (default localhost:1234), HARNESS_VMLINUX (default symbols).
 */

import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GdbSession, type StopInfo } from "./gdb.js";
import { capOutput, errMsg } from "./util.js";

const DEFAULT_TARGET = process.env.HARNESS_GDB ?? "localhost:1234";
const DEFAULT_SYMBOLS = process.env.HARNESS_VMLINUX ?? "";
// Harness lifecycle (RUN only — heavy BUILDs stay on dev-build via rtk/SSH).
const HARNESS_DIR = process.env.HARNESS_DIR ?? "/home/guillaume/be98/gt-be98-open-wifi/qemu-harness";
const HARNESS_LOG = path.join(HARNESS_DIR, "traces", "dhd-harness.log");

function shell(cmd: string, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("bash", ["-lc", cmd], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err: any, out, errout) => {
      const s = (out || "") + (errout ? "\n[stderr] " + errout : "");
      // Only a spawn failure (ENOENT etc., string code) is fatal; a non-zero EXIT
      // (e.g. pkill found nothing) is normal for these admin commands — return output.
      if (err && typeof err.code === "string") reject(new Error((err.message || "exec failed").slice(0, 200)));
      else resolve(s);
    });
  });
}
const tailFile = (p: string, n: number): string =>
  fs.existsSync(p) ? fs.readFileSync(p, "utf8").split("\n").slice(-n).join("\n") : "";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}
function fail(s: string) {
  return { content: [{ type: "text" as const, text: s }], isError: true };
}
async function guard(fn: () => Promise<any>) {
  try {
    return await fn();
  } catch (e) {
    return fail(`error: ${errMsg(e)}`);
  }
}
const capped = (s: string) => text(capOutput(s));
const fmtStop = (s: StopInfo) =>
  s.stopped
    ? `stopped: reason=${s.reason ?? "?"} @ ${s.addr ?? "?"} ${s.func ?? ""}${s.line ? " (" + (s.file ?? "") + ":" + s.line + ")" : ""}`
    : s.note ?? "(no stop)";

const gdb = new GdbSession();

export function registerTools(server: McpServer): void {
  // ---- harness lifecycle (RUN/STOP/LOGS) — build stays on dev-build via rtk ----
  server.registerTool(
    "harness_run",
    {
      title: "Run the QEMU dhd harness",
      description:
        "Launch the QEMU dhd harness in the background (run-harness-dhd.sh). gdb:true opens the gdbstub on " +
        ":1234 halted at reset — then call gdb_connect. Does NOT build: if you changed the device-model/kernel, " +
        "rebuild on dev-build first (apply-to-qemu.sh / build-harness-kernel.sh via rtk). Stops any prior run. " +
        "devprops e.g. 'chipid=0x6726,ipc-rev=8'.",
      inputSchema: {
        gdb: z.boolean().optional().describe("open gdbstub :1234, CPU halted at reset (default false)."),
        devprops: z.string().optional().describe("extra broadcom-fmac-stub device props."),
        timeout_s: z.number().optional().describe("max harness runtime (default 120; gdb mode 3600)."),
      },
    },
    async ({ gdb: useGdb, devprops, timeout_s }) =>
      guard(async () => {
        await shell(`[ -f /tmp/harness.pid ] && kill -TERM -- -"$(cat /tmp/harness.pid)" 2>/dev/null; true`).catch(() => {});
        const to = timeout_s ?? (useGdb ? 3600 : 120);
        const dp = (devprops ?? "").replace(/[^A-Za-z0-9=,_x]/g, "");
        // setsid -> the run pipeline is its own process group; pid saved so harness_stop
        // can kill the whole group precisely (no pkill self-match games).
        const cmd = `cd ${HARNESS_DIR} && setsid bash -c "GDB=${useGdb ? 1 : 0} TIMEOUT=${to} ./scripts/run-harness-dhd.sh '${dp}'" >/tmp/harness-run.out 2>&1 & echo $! > /tmp/harness.pid`;
        await shell(cmd, 8_000);
        await new Promise((r) => setTimeout(r, useGdb ? 1500 : 4500));
        const tail = tailFile(HARNESS_LOG, 25) || tailFile("/tmp/harness-run.out", 15) || "(no trace yet)";
        return capped(
          `harness launched (gdb=${!!useGdb}, timeout=${to}s)` +
            (useGdb ? " — gdbstub :1234 halted at reset; call gdb_connect." : "") +
            `\n--- trace tail ---\n${tail}`
        );
      })
  );

  server.registerTool(
    "harness_stop",
    {
      title: "Stop the QEMU harness",
      description: "Kill the running QEMU dhd harness (and any attached gdb session).",
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        gdb.kill();
        const out = await shell(
          `if [ -f /tmp/harness.pid ]; then kill -TERM -- -"$(cat /tmp/harness.pid)" 2>/dev/null; sleep 1; kill -KILL -- -"$(cat /tmp/harness.pid)" 2>/dev/null; rm -f /tmp/harness.pid; echo stopped; else echo 'no harness pid (not started via harness_run)'; fi`
        );
        return text(out.trim() || "stopped");
      })
  );

  server.registerTool(
    "harness_logs",
    {
      title: "Tail the harness trace",
      description: "Tail the harness boot / dhd-probe / IPC trace (traces/dhd-harness.log).",
      inputSchema: { lines: z.number().optional().describe("number of trailing lines (default 60).") },
    },
    async ({ lines }) =>
      guard(async () => {
        const data = tailFile(HARNESS_LOG, lines ?? 60);
        return data ? capped(data) : text("(no trace log yet — run harness_run first)");
      })
  );

  server.registerTool(
    "gdb_connect",
    {
      title: "Connect gdb to the QEMU harness",
      description:
        "(Re)start gdb-multiarch, load symbols, and attach to the QEMU gdbstub. Start the harness first " +
        "with GDB=1 (gdbstub :1234, CPU halted at reset). target defaults to env HARNESS_GDB, symbols to " +
        "HARNESS_VMLINUX (the vmlinux.harness with kernel symbols).",
      inputSchema: {
        target: z.string().optional().describe(`remote target host:port (default ${DEFAULT_TARGET}).`),
        symbols: z.string().optional().describe("path to symbol file (vmlinux.harness); default env HARNESS_VMLINUX."),
      },
    },
    async ({ target, symbols }) =>
      guard(async () => {
        gdb.start();
        await gdb.mi("-gdb-set architecture aarch64");
        await gdb.mi("-gdb-set pagination off");
        // async so -exec-interrupt works while the target is running (else it hangs).
        await gdb.mi("-gdb-set mi-async on");
        const sym = symbols ?? DEFAULT_SYMBOLS;
        let symNote = "no symbols loaded (set symbols/HARNESS_VMLINUX)";
        if (sym) {
          const r = await gdb.mi(`-file-exec-and-symbols ${sym}`);
          symNote = r.class === "done" ? `symbols: ${sym}` : `symbol load failed: ${r.payload}`;
        }
        const tgt = target ?? DEFAULT_TARGET;
        const r = await gdb.mi(`-target-select remote ${tgt}`, { timeoutMs: 20_000 });
        if (r.class === "error") throw new Error(`connect ${tgt} failed: ${r.payload}`);
        return capped(`connected to ${tgt}\n${symNote}\n${r.console.trim()}`);
      })
  );

  server.registerTool(
    "gdb_break",
    {
      title: "Set a breakpoint",
      description: "Insert a breakpoint (`-break-insert`). location = symbol, file:line, *0xADDR, or fn+off.",
      inputSchema: {
        location: z.string().describe("e.g. 'dhd_bus_init', 'pcie.c:303', '*0xffff000010800abc'."),
        temporary: z.boolean().optional().describe("one-shot breakpoint (default false)."),
      },
    },
    async ({ location, temporary }) =>
      guard(async () => {
        const r = await gdb.mi(`-break-insert ${temporary ? "-t " : ""}${location}`);
        return r.class === "error" ? fail(`break failed: ${r.payload}`) : capped(`breakpoint set: ${r.payload}`);
      })
  );

  for (const [name, mi, title] of [
    ["gdb_continue", "-exec-continue", "Continue execution"],
    ["gdb_step", "-exec-step", "Step (source line, into calls)"],
    ["gdb_next", "-exec-next", "Step over (source line)"],
    ["gdb_finish", "-exec-finish", "Run until current frame returns"],
    ["gdb_stepi", "-exec-step-instruction", "Step one instruction"],
  ] as const) {
    server.registerTool(
      name,
      {
        title,
        description: `${title} (\`${mi}\`), then report where the target halts. timeout_s bounds the wait for a stop.`,
        inputSchema: { timeout_s: z.number().optional().describe("max seconds to wait for a stop (default 20).") },
      },
      async ({ timeout_s }) =>
        guard(async () => {
          const { result, stop } = await gdb.execAndWait(mi, (timeout_s ?? 20) * 1000);
          if (result.class === "error") return fail(`${mi} failed: ${result.payload}`);
          return capped(`${fmtStop(stop)}\n${result.console.trim()}`);
        })
    );
  }

  server.registerTool(
    "gdb_interrupt",
    {
      title: "Interrupt (halt) the target",
      description: "Halt a running target (`-exec-interrupt`) and report where it stopped.",
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const stop = await gdb.interrupt(8_000);
        return capped(fmtStop(stop));
      })
  );

  server.registerTool(
    "gdb_regs",
    {
      title: "Read registers",
      description: "Dump register values in hex (`-data-list-register-values x`).",
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const names = await gdb.mi("-data-list-register-names");
        const vals = await gdb.mi("-data-list-register-values x");
        return capped(`${names.payload}\n${vals.payload}`);
      })
  );

  server.registerTool(
    "gdb_mem",
    {
      title: "Read memory",
      description: "Read `count` bytes at `addr` (`-data-read-memory-bytes`). addr = expr or 0xADDR.",
      inputSchema: {
        addr: z.string().describe("address expression, e.g. '0xffff000010800000' or '&dhd_global'."),
        count: z.number().describe("number of bytes to read."),
      },
    },
    async ({ addr, count }) =>
      guard(async () => {
        const r = await gdb.mi(`-data-read-memory-bytes ${addr} ${count}`);
        return r.class === "error" ? fail(`read failed: ${r.payload}`) : capped(r.payload);
      })
  );

  server.registerTool(
    "gdb_bt",
    {
      title: "Backtrace",
      description: "Current call stack (`-stack-list-frames`).",
      inputSchema: {},
    },
    async () =>
      guard(async () => capped((await gdb.mi("-stack-list-frames")).payload))
  );

  server.registerTool(
    "gdb_eval",
    {
      title: "Evaluate expression",
      description: "Evaluate a C/gdb expression in the current frame (`-data-evaluate-expression`).",
      inputSchema: { expr: z.string().describe("e.g. 'dhd_global->busstate', '(int)bus->sih->chip'.") },
    },
    async ({ expr }) =>
      guard(async () => {
        const r = await gdb.mi(`-data-evaluate-expression "${expr.replace(/"/g, '\\"')}"`);
        return r.class === "error" ? fail(`eval failed: ${r.payload}`) : capped(r.payload);
      })
  );

  server.registerTool(
    "gdb_cmd",
    {
      title: "Raw gdb console command",
      description:
        "Escape hatch: run any gdb console command (`-interpreter-exec console`), e.g. 'info functions dhd', " +
        "'lx-symbols', 'x/8xw 0x...'. Returns the console output.",
      inputSchema: { cmd: z.string().describe("gdb console command.") },
    },
    async ({ cmd }) =>
      guard(async () => {
        const r = await gdb.mi(`-interpreter-exec console "${cmd.replace(/"/g, '\\"')}"`, { timeoutMs: 30_000 });
        return r.class === "error" ? fail(`cmd failed: ${r.payload}`) : capped(r.console.trim() || "(ok, no output)");
      })
  );

  server.registerTool(
    "gdb_status",
    {
      title: "Session status",
      description: "Whether a gdb session is live, and the default target/symbols.",
      inputSchema: {},
    },
    async () =>
      guard(async () =>
        text(`gdb running: ${gdb.running}\ndefault target: ${DEFAULT_TARGET}\ndefault symbols: ${DEFAULT_SYMBOLS || "(none)"}`)
      )
  );

  server.registerTool(
    "gdb_disconnect",
    {
      title: "Disconnect / end session",
      description: "Detach and terminate the gdb process.",
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        try {
          await gdb.mi("-target-disconnect", { timeoutMs: 5_000 });
        } catch {
          /* ignore */
        }
        gdb.kill();
        return text("gdb session ended.");
      })
  );
}
