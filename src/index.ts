#!/usr/bin/env node
/**
 * Entry point: a stateless Streamable-HTTP MCP server in front of Brain.
 *
 * Stateless mode (no session id) builds a fresh server + transport per POST —
 * the right fit for a horizontally-scaled service where any instance can serve
 * any request. Tool-only clients never need the GET notification stream, so GET
 * and DELETE return 405.
 *
 * Auth:
 * - OAuth off (M1): the MCP endpoint is unauthenticated — run behind a trust
 *   boundary. Brain is called with the configured service key; scope per customer.
 * - OAuth on (M2): every request needs a valid bearer token from the configured
 *   issuer; the token's tenant claim selects the namespace. Brain is still called
 *   with the service key + act_as, so the user token authorizes the caller, not
 *   the Brain connection.
 */

import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, {
  type Express,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { JwtTokenVerifier, namespaceFrom, protectedResourceMetadata } from "./auth.js";
import { BrainBackend } from "./backend.js";
import { type Config, ConfigError, loadConfig } from "./config.js";
import { buildServer } from "./server.js";

const JSONRPC_METHOD_NOT_ALLOWED = -32000;

function methodNotAllowed(res: Response): void {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: JSONRPC_METHOD_NOT_ALLOWED, message: "Method not allowed." },
    id: null,
  });
}

/** Build the Express app for `cfg` without binding a port (testable). */
export function buildApp(cfg: Config): Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Liveness — cheap, unauthenticated, no backend call.
  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok", service: "brain-mcp" });
  });

  // OAuth 2.1 resource-server surface (M2), only when configured.
  let authMiddleware: RequestHandler[] = [];
  if (cfg.oauth) {
    const oauth = cfg.oauth;
    const metadataPath = "/.well-known/oauth-protected-resource";
    const resourceMetadataUrl = `${oauth.publicUrl}${metadataPath}`;
    app.get(metadataPath, (_req: Request, res: Response) => {
      res.status(200).json(protectedResourceMetadata(oauth));
    });
    authMiddleware = [
      requireBearerAuth({
        verifier: new JwtTokenVerifier(oauth),
        requiredScopes: oauth.requiredScopes,
        resourceMetadataUrl,
      }),
    ];
  }

  // Stateless MCP endpoint: fresh server + transport per request. Namespace is
  // the token's tenant claim (OAuth) or the configured default.
  app.post("/mcp", ...authMiddleware, async (req: Request, res: Response) => {
    const namespace = cfg.oauth
      ? namespaceFrom(req.auth, cfg.oauth.namespaceClaim, cfg.namespace)
      : cfg.namespace;
    const backend = new BrainBackend({ ...cfg, namespace });
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

  return app;
}

function main(): void {
  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`brain-mcp: configuration error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  buildApp(cfg).listen(cfg.port, cfg.host, () => {
    const mode = cfg.oauth ? `oauth (issuer ${cfg.oauth.issuer})` : "no-auth (M1)";
    console.error(
      `brain-mcp listening on http://${cfg.host}:${cfg.port}/mcp ` +
        `→ backend ${cfg.backendUrl} (namespace ${cfg.namespace}) [${mode}]`,
    );
  });
}

// Only start a listener when run directly, not when imported by tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
