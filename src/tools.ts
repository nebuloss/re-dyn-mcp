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
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GdbSession, type StopInfo } from "./gdb.js";
import { capOutput, errMsg } from "./util.js";

const DEFAULT_TARGET = process.env.HARNESS_GDB ?? "localhost:1234";
const DEFAULT_SYMBOLS = process.env.HARNESS_VMLINUX ?? "";

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
