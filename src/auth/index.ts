/**
 * OAuth 2.1 resource-server support (M2). The MCP server validates bearer access
 * tokens issued by an external authorization server (Arc auth or any OIDC IdP);
 * it never mints tokens. Token signatures are verified against the issuer's
 * JWKS, and a tenant claim on the token selects the Brain namespace.
 */

import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { type JWTPayload, createRemoteJWKSet, jwtVerify } from "jose";
import type { OAuthConfig } from "./config.js";

/** Scopes from a JWT: OAuth `scope` (space-delimited) or `scp`/`scopes` arrays. */
function parseScopes(payload: JWTPayload): string[] {
  const scope = payload.scope;
  if (typeof scope === "string") return scope.split(/\s+/).filter(Boolean);
  for (const key of ["scp", "scopes"] as const) {
    const v = payload[key];
    if (Array.isArray(v)) return v.filter((s): s is string => typeof s === "string");
  }
  return [];
}

/** Verifies JWT access tokens against an issuer's JWKS (RS/ES signatures). */
export class JwtTokenVerifier implements OAuthTokenVerifier {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly oauth: OAuthConfig) {
    this.jwks = createRemoteJWKSet(new URL(oauth.jwksUri));
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, {
        issuer: this.oauth.issuer,
        audience: this.oauth.audience,
      }));
    } catch (err) {
      throw new InvalidTokenError(err instanceof Error ? err.message : "invalid token");
    }

    let resource: URL | undefined;
    try {
      resource = new URL(this.oauth.audience);
    } catch {
      resource = undefined;
    }

    return {
      token,
      clientId: String(payload.azp ?? payload.client_id ?? payload.sub ?? ""),
      scopes: parseScopes(payload),
      expiresAt: payload.exp,
      resource,
      extra: payload as Record<string, unknown>,
    };
  }
}

/**
 * RFC 9728 Protected Resource Metadata: tells MCP clients which authorization
 * server(s) to use and which scopes this resource understands.
 */
export function protectedResourceMetadata(oauth: OAuthConfig): Record<string, unknown> {
  return {
    resource: oauth.audience,
    authorization_servers: [oauth.issuer],
    scopes_supported: oauth.requiredScopes,
    bearer_methods_supported: ["header"],
    resource_name: "brain-mcp",
  };
}

/**
 * The Brain namespace a request runs against: the token's tenant claim when
 * present, otherwise the server's configured default.
 */
export function namespaceFrom(
  auth: AuthInfo | undefined,
  claim: string,
  fallback: string,
): string {
  const value = auth?.extra?.[claim];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}
