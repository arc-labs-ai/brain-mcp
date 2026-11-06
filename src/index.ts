#!/usr/bin/env node
/**
 * Entry point: a stateless Streamable-HTTP MCP server in front of Brain.
 *
 * Stateless mode (no session id) builds a fresh server + transport per POST —
 * the right fit for a horizontally-scaled service where any instance can serve
 * any request. Tool-only clients never need the GET notification stream, so GET
 * and DELETE return 405.
 *
 * Auth: the caller's own Brain API key, carried as `Authorization: Bearer`
 * and forwarded to the backend verbatim. The server holds no credential, so
 * one hosted deployment serves every user as themselves, and a request with no
 * bearer can do nothing but collect a 401. There is no ambient authority here
 * to misconfigure, which is also why this endpoint is safe to expose directly
 * rather than behind a shared-secret gate.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { BrainBackend } from "./backend/index.js";
import { type Config, ConfigError, loadConfig } from "./config/index.js";
import { buildServer } from "./server/index.js";

const JSONRPC_METHOD_NOT_ALLOWED = -32000;
/** JSON-RPC "Invalid Request" — the body never became a valid envelope. */
const JSONRPC_INVALID_REQUEST = -32600;

/**
 * The caller's bearer credential, or undefined.
 *
 * Only the `Bearer` scheme is read. `x-api-key` is NOT accepted even though
 * the gateway takes it, because this server's contract is one documented place
 * to put the credential; a second one is a second thing to get wrong and a
 * second place a key can be logged by an intermediary that knows the first.
 */
function bearerFrom(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const m = /^[Bb]earer[ ]+(.+)$/.exec(header.trim());
  const token = m?.[1]?.trim();
  return token !== undefined && token.length > 0 ? token : undefined;
}

/**
 * 401 for a request that presented no credential.
 *
 * Carries `WWW-Authenticate` so an MCP client can say what is wrong, and a
 * JSON-RPC envelope so a client that only parses JSON-RPC does not report a
 * transport fault. The message names the fix, because the most likely reader
 * is a user who pasted a client config without the header.
 */
function unauthorized(res: Response): void {
  res
    .status(401)
    .set("WWW-Authenticate", 'Bearer realm="brain-mcp"')
    .json({
      jsonrpc: "2.0",
      error: {
        code: JSONRPC_INVALID_REQUEST,
        message:
          "Missing Authorization header. This server runs every request as the " +
          "caller, so it needs your own Brain API key: send " +
          "`Authorization: Bearer <your key>`. Create one in the dashboard.",
      },
      id: null,
    });
}

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

  // Stateless MCP endpoint: fresh server + transport per request, and a fresh
  // backend bound to THIS caller's credential. Per-request construction is
  // what makes one deployment safe for many users — there is no cross-request
  // state for one caller's identity to leak into another's.
  app.post("/mcp", async (req: Request, res: Response) => {
    const credential = bearerFrom(req.headers.authorization);
    if (credential === undefined) {
      unauthorized(res);
      return;
    }
    const backend = new BrainBackend(cfg, credential);
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

/**
 * This package is a SERVER, not an installer.
 *
 * It used to carry an `init` subcommand that configured every MCP client on a
 * machine, plus a Claude Code plugin and a skill. All of that moved to
 * `@brain-db/cli`, and none of it is kept here as an alias.
 *
 * The split is not tidying. Setting a machine up and serving an agent's
 * requests are different jobs with different shapes:
 *
 * - The installer is **one-shot and interactive**: it opens a browser, waits
 *   on a human, shells out to other CLIs, and can churn freely because every
 *   run is somebody's first.
 * - This is **long-lived and on the hot path**: an agent starts it on every
 *   cold start and it must do nothing but speak the protocol.
 *
 * Fusing them also made the package the wrong thing to recommend. Nobody
 * wants an MCP server; they want their agent to remember things — and a tool
 * surface with no skill beside it is a tool surface an agent picks wrongly
 * from. The installer ships both. This ships the server.
 */
async function main(): Promise<void> {
  const stdio = wantsStdio();
  let cfg: Config;
  try {
    cfg = loadConfig(stdio);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`brain-mcp: configuration error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  if (stdio) {
    await serveStdio(cfg);
    return;
  }

  buildApp(cfg).listen(cfg.port, cfg.host, () => {
    console.error(
      `brain-mcp listening on http://${cfg.host}:${cfg.port}/mcp ` +
        `→ backend ${cfg.backendUrl} (per-caller credentials)`,
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
  // `loadConfig(true)` has already refused to return without it; this narrows
  // the optional type and states the invariant where it is relied on.
  if (cfg.apiKey === undefined) {
    throw new Error("unreachable: stdio config without a credential");
  }
  const server = buildServer(new BrainBackend(cfg, cfg.apiKey));
  const transport = new StdioServerTransport();
  console.error(`brain-mcp on stdio → backend ${cfg.backendUrl}`);
  await server.connect(transport);
}

/**
 * Whether this module is the program, rather than an import.
 *
 * This used to be `import.meta.url === \`file://${process.argv[1]}\``, and that
 * comparison is false in the one way the package is actually installed. npm
 * puts a `bin` on PATH as a SYMLINK — `node_modules/.bin/brain-mcp` pointing
 * at `dist/index.js` — so `process.argv[1]` is the link while
 * `import.meta.url` is the target it resolves to. The strings differ, `main()`
 * never ran, and the process exited 0 having done nothing.
 *
 * Nothing about that looks like a failure from the outside. The client starts
 * the server, the server exits cleanly, and the client reports
 * `CONNECTION_CLOSED` — which reads as a crash, a bad key, or a network
 * problem, none of which it is. Every `npx -y @brain-db/mcp --stdio` config in
 * the README was affected, which is to say the documented way to install this
 * package could not work.
 *
 * Comparing resolved real paths fixes the symlink, and going through
 * `fileURLToPath` fixes the second latent bug in the old line: `file://` +
 * a raw path is not a valid URL once the path contains a space or any
 * non-ASCII character, so a checkout under `~/My Projects/` failed the same
 * way for a different reason.
 */
function isEntrypoint(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // A path that cannot be resolved is not this file.
    return false;
  }
}

// Only start a listener when run directly, not when imported by tests.
if (isEntrypoint()) {
  main().catch((err) => {
    // stderr, never stdout: on the stdio transport stdout carries protocol
    // frames and a stray line is a parse error at the client.
    console.error("brain-mcp: fatal:", err);
    process.exit(1);
  });
}
