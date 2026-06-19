# @nebuloss/re-dyn-mcp

A **dynamic-analysis MCP server** for the GT-BE98 / Broadcom BCM6726b0 WiFi-driver
reverse-engineering effort. It drives **`gdb-multiarch` over GDB/MI** against the
QEMU `dhd` harness gdbstub, and manages the harness lifecycle (run / stop / logs).

This is the **runtime/dynamic** counterpart to the **static** stack:

| Server | Repo | What it does |
|---|---|---|
| `re` (radare2) | [`r2-re-mcp`](https://github.com/nebuloss/r2-re-mcp) | static disassembly, xrefs, signatures |
| `utils` | [`re-utils-mcp`](https://github.com/nebuloss/re-utils-mcp) | binwalk, source search |
| **`dyn`** | **this repo** | **live gdb against the booting harness** |

## Topology — this is a DIRECT MCP entry, not behind mcpproxy

`re-dyn-mcp` runs on **dev-build (10.0.50.21)**, because that is where QEMU,
`gdb-multiarch`, the kernel symbols (`vmlinux.harness`), and the harness scripts
live. The build never leaves dev-build.

Unlike the static servers (`re`/`utils`/`files`/`ghidra`), which are aggregated
behind **mcpproxy** on the RE container, **`dyn` is registered directly in the
client's `.mcp.json`** as:

```json
{ "dyn": "http://10.0.50.21:8781/mcp" }
```

It is **not** a mcpproxy upstream. Dynamic debugging is stateful and latency-
sensitive (a live gdb session, breakpoints, single-stepping) — fronting it behind
the proxy's `retrieve_tools` / `call_tool` indirection added latency and an
approval gate for no benefit. The client talks to it straight over VLAN 50, so it
binds `0.0.0.0` (not loopback).

## Tools (18)

### Harness lifecycle
| Tool | Purpose |
|---|---|
| `harness_run` | Boot the QEMU `dhd` harness (`run-harness-dhd.sh`) in the background, gdbstub on `:1234`. setsid + pidfile so `harness_stop` can kill the whole process group. |
| `harness_stop` | Kill the running harness (and any attached gdb session). |
| `harness_logs` | Tail the harness boot / dhd-probe / IPC trace (`traces/dhd-harness.log`). |

### gdb session
| Tool | GDB/MI | Purpose |
|---|---|---|
| `gdb_connect` | `-target-select remote` | Attach to the harness gdbstub (default `localhost:1234`), load symbols. |
| `gdb_break` | `-break-insert` | Breakpoint at symbol, `file:line`, `*0xADDR`, or `fn+off`. |
| `gdb_continue` | `-exec-continue` | Resume; report where it halts. |
| `gdb_step` | `-exec-step` | Step into (source line). |
| `gdb_next` | `-exec-next` | Step over (source line). |
| `gdb_finish` | `-exec-finish` | Run to caller. |
| `gdb_stepi` | `-exec-step-instruction` | Single instruction. |
| `gdb_interrupt` | SIGINT | Halt a running target, report where it stopped. |
| `gdb_regs` | `-data-list-register-values x` | Registers in hex. |
| `gdb_mem` | `-data-read-memory-bytes` | Read `count` bytes at an address/expr. |
| `gdb_bt` | `-stack-list-frames` | Call stack. |
| `gdb_eval` | `-data-evaluate-expression` | Evaluate a C/gdb expression in the current frame. |
| `gdb_cmd` | (raw) | Escape hatch — run an arbitrary gdb/MI command. |
| `gdb_status` | — | Whether a gdb session is live; default target/symbols. |
| `gdb_disconnect` | — | Detach and terminate the gdb process. |

## Typical workflow

```
harness_run                      # boot the dhd harness, gdbstub :1234 (GDB=1 set internally)
gdb_connect                      # attach gdb-multiarch, load vmlinux.harness symbols
gdb_break  brcmf_pcie_probe      # set a breakpoint on the probe path
gdb_continue                     # run to it
gdb_bt ; gdb_regs ; gdb_mem ...  # inspect
gdb_disconnect
harness_stop                     # tear the harness down
```

## Config (environment)

| Var | Default | Meaning |
|---|---|---|
| `RE_DYN_PORT` | `8781` | HTTP listen port. |
| `RE_DYN_HOST` | `0.0.0.0` | Bind address (cross-host: the client is on dev-code). |
| `HARNESS_DIR` | — | Dir holding `run-harness-dhd.sh` (the QEMU dhd harness). |
| `HARNESS_GDB` | `localhost:1234` | gdbstub address the harness exposes. |
| `HARNESS_VMLINUX` | — | Kernel image with symbols for gdb to load. |
| `GDB_BIN` | `gdb-multiarch` | gdb binary. |
| `LOG_LEVEL` | `info` | Log verbosity. |

The MCP endpoint is `POST /mcp`; `GET /health` returns `{"status":"ok"}`.

## Build & run

```bash
npm install
npm run build        # tsc -> dist/
npm start            # node dist/server.js
```

### Deploy (dev-build)

```bash
sudo cp systemd/re-dyn-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now re-dyn-mcp
# expects the built server at /opt/re-dyn-mcp/dist/server.js
```

The service runs as **`guillaume`** (not root) so `harness_run` behaves like a
manual run and doesn't litter root-owned files in the user tree. `MemoryMax=512M`.

## Prerequisite — harness artifacts

`gdb_connect` can only attach once the harness actually boots. That needs two
build artifacts present on dev-build:

- `rootfs/initramfs-dhd.cpio.gz` (initrd)
- `vmlinux.harness` (kernel image + symbols, path from `HARNESS_VMLINUX`)

Rebuild them on dev-build (via `rtk`) before expecting live attach to work. The
server itself runs fine without them — `harness_run` will just fail to boot until
they exist.

## CI

Typecheck-only (`tsc`). The runtime drives `gdb-multiarch` against QEMU, neither
of which exists on GitHub runners — the real exercise happens on dev-build.

## License

MIT
