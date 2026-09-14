#!/usr/bin/env node
/**
 * Entry point: a stateless Streamable-HTTP MCP server in front of Brain.
 *
 * Stateless mode (no session id) builds a fresh server + transport per POST —
 * the right fit for a horizontally-scaled service where any instance can serve
 * any request. Tool-only clients never need the GET notification stream, so GET
 * and DELETE return 405.
 *
 * M1 authenticates to Brain with a single service API key (bearer) and scopes
 * per customer via headers. OAuth 2.1 for the MCP client itself is M2.
 */

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";
import { BrainBackend } from "./backend.js";
import { ConfigError, loadConfig } from "./config.js";
import { buildServer } from "./server.js";

const JSONRPC_METHOD_NOT_ALLOWED = -32000;

function methodNotAllowed(res: Response): void {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: JSONRPC_METHOD_NOT_ALLOWED, message: "Method not allowed." },
    id: null,
  });
}

async function main(): Promise<void> {
  let cfg: ReturnType<typeof loadConfig>;
  try {
    cfg = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`brain-mcp: configuration error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const backend = new BrainBackend(cfg);
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Liveness — cheap, unauthenticated, no backend call.
  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok", service: "brain-mcp" });
  });

  // Stateless MCP endpoint: fresh server + transport per request.
  app.post("/mcp", async (req: Request, res: Response) => {
    const server = buildServer(backend);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("brain-mcp: error handling MCP request:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error." },
          id: null,
        });
      }
    }
  });

  // Stateless: no server-initiated streams or session teardown.
  app.get("/mcp", (_req: Request, res: Response) => methodNotAllowed(res));
  app.delete("/mcp", (_req: Request, res: Response) => methodNotAllowed(res));

  app.listen(cfg.port, cfg.host, () => {
    console.error(
      `brain-mcp listening on http://${cfg.host}:${cfg.port}/mcp ` +
        `→ backend ${cfg.backendUrl} (namespace ${cfg.namespace})`,
    );
  });
}

main().catch((err) => {
  console.error("brain-mcp: fatal:", err);
  process.exit(1);
});
