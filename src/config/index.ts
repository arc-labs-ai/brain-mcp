/**
 * Runtime configuration, read once from the environment at startup.
 *
 * The MCP server is a thin, stateless front for the Brain REST surface
 * (`/v1/*`) — hosted (the gateway) or self-hosted (brain-edge), which share the
 * same JSON contract.
 *
 * It holds NO credential of its own on the HTTP path. The caller's bearer is
 * the credential, forwarded to the backend verbatim, so one deployment serves
 * every user at their own identity and the backend's existing per-key scoping
 * is what keeps them apart. On stdio there is no request to carry a bearer —
 * the client owns the process — so the credential comes from the environment.
 *
 * The rule, in one line: the credential comes from the transport.
 */

/**
 * The Brain the server talks to when nothing says otherwise.
 *
 * This used to be `required()`, and that one decision was most of the distance
 * between "install it" and "using it". A first-time user had to supply a URL
 * that appeared in no client config they were copying and nowhere in the
 * product — so the common first run was a server that exited 1 before the
 * client had finished starting it, which clients report as "server failed to
 * start" with the actual reason buried in stderr.
 *
 * It is the STAGING gateway, deliberately and visibly, because that is the
 * Brain that is publicly reachable today: `api.arc-labs.ai` has no DNS record.
 * Naming it here makes the dependency legible to anyone reading the config
 * rather than implicit in a URL they were handed. When a production gateway
 * exists, this constant is the one place that changes.
 */
export const DEFAULT_BACKEND_URL = "https://api.stg.arc-labs.ai";

/** A fatal misconfiguration surfaced at startup rather than per request. */
export class ConfigError extends Error {}

export interface Config {
  /** Base URL of the Brain REST backend — the hosted gateway, or
   *  `http://localhost:8080` for a self-hosted brain-edge. No trailing slash.
   *  Defaults to {@link DEFAULT_BACKEND_URL}. */
  backendUrl: string;
  /** The credential used on the STDIO path only, from `BRAIN_MCP_API_KEY`.
   *
   *  Undefined in HTTP mode, and deliberately not consulted there: a
   *  server-held fallback is ambient authority. With one, a request that
   *  forgot its bearer would quietly succeed as whoever the server is — the
   *  single worst failure this design exists to prevent, because it looks
   *  exactly like success. */
  apiKey?: string;
  /** Port the Streamable HTTP transport listens on. */
  port: number;
  /** Host/interface to bind. */
  host: string;
  /** Per-request timeout to the backend, milliseconds. */
  requestTimeoutMs: number;
}

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") {
    throw new ConfigError(`missing required env var ${name}`);
  }
  return v.trim();
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? fallback : v.trim();
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Load and validate config from the environment. Throws {@link ConfigError}.
 *
 * `stdio` selects which credential rule applies, so it is a parameter rather
 * than a second read of `process.argv` — the caller already knows which
 * transport it is about to start.
 */
export function loadConfig(stdio = false): Config {
  const portRaw = optional("BRAIN_MCP_PORT", "3333");
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`BRAIN_MCP_PORT must be a valid port, got ${portRaw}`);
  }

  const timeoutRaw = optional("BRAIN_MCP_REQUEST_TIMEOUT_MS", "30000");
  const requestTimeoutMs = Number.parseInt(timeoutRaw, 10);
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw new ConfigError(
      `BRAIN_MCP_REQUEST_TIMEOUT_MS must be a positive integer, got ${timeoutRaw}`,
    );
  }

  rejectOAuth();

  return {
    backendUrl: stripTrailingSlash(
      optional("BRAIN_MCP_BACKEND_URL", DEFAULT_BACKEND_URL),
    ),
    // stdio: the client owns the process and holds the key, so the env is the
    // only place it can come from. HTTP: every request brings its own.
    apiKey: stdio ? required("BRAIN_MCP_API_KEY") : undefined,
    port,
    host: optional("BRAIN_MCP_HOST", "0.0.0.0"),
    requestTimeoutMs,
  };
}

function isTruthy(v: string | undefined): boolean {
  return v !== undefined && ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

/**
 * Refuse to start when the removed OAuth mode is still configured.
 *
 * OAuth and credential pass-through are not two settings — they are two
 * answers to "what is in the `Authorization` header", and there is one header.
 * Pass-through puts the caller's Brain credential there; OAuth put a JWT
 * there and called the backend with a server-held service key, selecting a
 * namespace from a token claim.
 *
 * That selection never worked against the gateway, which ignores the namespace
 * header for key callers, so every OAuth tenant landed in the service key's
 * own workspace. An OAuth mode that authenticates the caller and then serves
 * them someone else's data is worse than none, which is why this is a startup
 * failure and not a warning: a deployment that sets the flag believes it is
 * isolating tenants, and it has to find out here rather than from a tenant.
 */
function rejectOAuth(): void {
  if (!isTruthy(process.env.BRAIN_MCP_OAUTH_ENABLED)) return;
  throw new ConfigError(
    "BRAIN_MCP_OAUTH_ENABLED is set, but this server no longer has an OAuth " +
      "mode. The Authorization header now carries the caller's own Brain API " +
      "key, which the backend resolves to that caller's namespace and space — " +
      "so each user connects to one shared deployment as themselves, which is " +
      "what the OAuth mode was reaching for and did not achieve. Unset the " +
      "flag (and BRAIN_MCP_OAUTH_*) to start.",
  );
}
