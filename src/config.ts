/**
 * Runtime configuration, read once from the environment at startup.
 *
 * The MCP server is a thin, stateless front for the Brain REST surface
 * (`/v1/*`) — hosted (the gateway) or self-hosted (brain-edge), which share the
 * same JSON contract. It authenticates to that backend with a single bearer API
 * key (M1); per-customer isolation rides the scope headers on every request.
 */

/** A fatal misconfiguration surfaced at startup rather than per request. */
export class ConfigError extends Error {}

export interface Config {
  /** Base URL of the Brain REST backend, e.g. `https://api.arc-labs.ai` (hosted
   *  gateway) or `http://localhost:8080` (self-hosted brain-edge). No trailing slash. */
  backendUrl: string;
  /** Bearer API key sent as `Authorization: Bearer <key>` to the backend. The
   *  key's principal must be permitted to act on behalf of the customer scopes
   *  the tools target (a `may_act` service principal for multi-customer use). */
  apiKey: string;
  /** Namespace slug sent as the namespace scope header on every request. */
  namespace: string;
  /** Header carrying the namespace slug (default `x-brain-namespace`). */
  namespaceHeader: string;
  /** Header carrying the per-customer space id (default `x-brain-agent`; renamed
   *  to `x-brain-space` once the gateway control-plane rename lands). */
  scopeHeader: string;
  /** Port the Streamable HTTP transport listens on. */
  port: number;
  /** Host/interface to bind. */
  host: string;
  /** Per-request timeout to the backend, milliseconds. */
  requestTimeoutMs: number;
  /** OAuth 2.1 resource-server config, or `undefined` when disabled (M1 mode:
   *  the MCP endpoint is unauthenticated and must sit behind a trust boundary). */
  oauth?: OAuthConfig;
}

/**
 * OAuth 2.1 resource-server settings. When present, every MCP request must carry
 * a valid bearer access token issued by {@link OAuthConfig.issuer}; the token's
 * tenant claim selects the Brain namespace. The MCP server never mints tokens —
 * it validates them (RFC 9728 resource server) and points clients at the issuer.
 */
export interface OAuthConfig {
  /** Authorization-server issuer URL clients are directed to (RFC 9728
   *  `authorization_servers`), and the required JWT `iss`. */
  issuer: string;
  /** JWKS endpoint used to verify token signatures. */
  jwksUri: string;
  /** Resource identifier (RFC 8707) this server accepts tokens for — the JWT
   *  `aud` must include it. Normally the server's public URL. */
  audience: string;
  /** Externally-reachable base URL of this MCP server, for the protected-resource
   *  metadata document and the `WWW-Authenticate` hint. */
  publicUrl: string;
  /** Scopes a token must carry (empty = any valid token). */
  requiredScopes: string[];
  /** JWT claim carrying the tenant namespace; falls back to {@link Config.namespace}
   *  when the claim is absent. */
  namespaceClaim: string;
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

/** Load and validate config from the environment. Throws {@link ConfigError}. */
export function loadConfig(): Config {
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

  return {
    backendUrl: stripTrailingSlash(required("BRAIN_MCP_BACKEND_URL")),
    apiKey: required("BRAIN_MCP_API_KEY"),
    namespace: required("BRAIN_MCP_NAMESPACE"),
    namespaceHeader: optional("BRAIN_MCP_NAMESPACE_HEADER", "x-brain-namespace"),
    scopeHeader: optional("BRAIN_MCP_SCOPE_HEADER", "x-brain-agent"),
    port,
    host: optional("BRAIN_MCP_HOST", "0.0.0.0"),
    requestTimeoutMs,
    oauth: loadOAuthConfig(),
  };
}

function isTruthy(v: string | undefined): boolean {
  return v !== undefined && ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

/** Load the OAuth block when `BRAIN_MCP_OAUTH_ENABLED` is set; else `undefined`. */
function loadOAuthConfig(): OAuthConfig | undefined {
  if (!isTruthy(process.env.BRAIN_MCP_OAUTH_ENABLED)) return undefined;
  const scopesRaw = optional("BRAIN_MCP_OAUTH_SCOPES", "");
  return {
    issuer: stripTrailingSlash(required("BRAIN_MCP_OAUTH_ISSUER")),
    jwksUri: required("BRAIN_MCP_OAUTH_JWKS_URI"),
    audience: required("BRAIN_MCP_OAUTH_AUDIENCE"),
    publicUrl: stripTrailingSlash(required("BRAIN_MCP_PUBLIC_URL")),
    requiredScopes: scopesRaw ? scopesRaw.split(/[,\s]+/).filter(Boolean) : [],
    namespaceClaim: optional("BRAIN_MCP_OAUTH_NAMESPACE_CLAIM", "namespace"),
  };
}
