/**
 * re-dyn-mcp — dynamic-analysis MCP (gdb-multiarch over GDB/MI vs the QEMU dhd
 * harness gdbstub). Runs on dev-build (where QEMU + gdb + symbols live); mcpproxy
 * on the RE container fronts it as the "dyn" upstream over VLAN 50.
 *
 * Env: RE_DYN_PORT (8781), RE_DYN_HOST (0.0.0.0 — reachable cross-host),
 *      HARNESS_GDB (localhost:1234), HARNESS_VMLINUX, GDB_BIN, LOG_LEVEL.
 */

import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.js";
import { log } from "./util.js";

const PORT = parseInt(process.env.RE_DYN_PORT ?? "8781", 10);
const HOST = process.env.RE_DYN_HOST ?? "0.0.0.0";
const MCP_PATH = "/mcp";

function buildServer(): McpServer {
  const server = new McpServer({ name: "re-dyn-mcp", version: "1.0.0" });
  registerTools(server);
  return server;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const httpServer = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: "re-dyn-mcp" }));
      return;
    }
    const url = (req.url ?? "").split("?")[0];
    if (url !== MCP_PATH) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found — MCP endpoint is " + MCP_PATH);
      return;
    }
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);

    let parsedBody: unknown = undefined;
    if (req.method === "POST") {
      const raw = await readBody(req);
      if (raw) {
        try {
          parsedBody = JSON.parse(raw);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
          return;
        }
      }
    }
    await transport.handleRequest(req, res, parsedBody);
  } catch (e) {
    log.error("request handler error:", e);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
    }
  }
});

httpServer.listen(PORT, HOST, () => {
  log.info(`re-dyn-mcp listening on http://${HOST}:${PORT}${MCP_PATH}`);
});
