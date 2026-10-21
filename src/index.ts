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
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import {
  JwtTokenVerifier,
  namespaceFrom,
  protectedResourceMetadata,
} from "./auth/index.js";
import { BrainBackend } from "./backend/index.js";
import { type Config, ConfigError, loadConfig } from "./config/index.js";
import { buildServer } from "./server/index.js";

const JSONRPC_METHOD_NOT_ALLOWED = -32000;
/** JSON-RPC "Invalid Request" — the body never became a valid envelope. */
const JSONRPC_INVALID_REQUEST = -32600;

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

  // A body over the limit is rejected by the JSON parser before any MCP code
  // runs, and express's default handler answers with an HTML error page. The
  // MCP client cannot parse that, so it raises a TRANSPORT error — the agent
  // sees the connection break rather than a tool result it can read, and a
  // single oversized `remember` looks like the server fell over.
  //
  // Answering in JSON-RPC instead keeps an oversized request a normal,
  // readable failure. The tool schemas cap their own inputs well below 1 MB;
  // this is the backstop for anything that slips past them.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const e = err as { type?: string; status?: number };
    const tooLarge = e?.type === "entity.too.large" || e?.status === 413;
    res.status(tooLarge ? 413 : 400).json({
      jsonrpc: "2.0",
      error: {
        code: JSONRPC_INVALID_REQUEST,
        message: tooLarge
          ? "Request body too large (limit 1MB). Split the content into " +
            "smaller memories — remember() accepts up to ~256 KB per call."
          : "Malformed request body.",
      },
      id: null,
    });
  });

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

async function main(): Promise<void> {
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

  if (wantsStdio()) {
    await serveStdio(cfg);
    return;
  }

  buildApp(cfg).listen(cfg.port, cfg.host, () => {
    const mode = cfg.oauth ? `oauth (issuer ${cfg.oauth.issuer})` : "no-auth (M1)";
    console.error(
      `brain-mcp listening on http://${cfg.host}:${cfg.port}/mcp ` +
        `→ backend ${cfg.backendUrl} (namespace ${cfg.namespace}) [${mode}]`,
    );
  });
}

/**
 * Whether to speak MCP over stdio instead of HTTP.
 *
 * `package.json` declares a `bin`, which is the conventional signal for a
 * stdio server, so the natural client config is
 * `{"command": "npx", "args": ["-y", "@brain-db/mcp"]}`. Without this the
 * binary started an HTTP listener instead, printed a log line to stdout, and
 * ignored the `initialize` frame on stdin — the client hung forever with no
 * error. Supporting both is the honest reading of shipping a `bin`.
 */
function wantsStdio(): boolean {
  return process.argv.includes("--stdio") || isTruthy(process.env.BRAIN_MCP_STDIO);
}

function isTruthy(v: string | undefined): boolean {
  if (v === undefined) return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

/**
 * Serve one MCP session over stdin/stdout.
 *
 * Unlike the HTTP path there is no per-request server: a stdio client owns the
 * process for its lifetime, so one backend and one server are built once and
 * live until the stream closes.
 *
 * Nothing may be written to stdout except protocol frames — a stray log line
 * is a parse error at the client. Every diagnostic here goes to stderr, which
 * clients surface as server logs.
 */
async function serveStdio(cfg: Config): Promise<void> {
  if (cfg.oauth) {
    // OAuth authenticates an HTTP caller. Over stdio the client already owns
    // the process; there is no request to bear a token, so silently running
    // unauthenticated would misrepresent the deployment.
    console.error(
      "brain-mcp: BRAIN_MCP_OAUTH_ENABLED is set but OAuth does not apply to " +
        "stdio — the client owns this process and sends no HTTP request. " +
        "Run without --stdio to use OAuth, or unset it to serve stdio.",
    );
    process.exit(1);
  }
  const server = buildServer(new BrainBackend(cfg));
  const transport = new StdioServerTransport();
  console.error(
    `brain-mcp on stdio → backend ${cfg.backendUrl} (namespace ${cfg.namespace})`,
  );
  await server.connect(transport);
}

// Only start a listener when run directly, not when imported by tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // stderr, never stdout: on the stdio transport stdout carries protocol
    // frames and a stray line is a parse error at the client.
    console.error("brain-mcp: fatal:", err);
    process.exit(1);
  });
}
