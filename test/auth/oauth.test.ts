/**
 * OAuth 2.1 resource-server tests (M2). A local JWKS + jose-signed tokens stand
 * in for the authorization server, so the full gate is exercised end-to-end:
 * protected-resource metadata, 401 on missing/invalid tokens, and — for a valid
 * token — a real MCP tool call whose tenant namespace comes from the token claim.
 */

import { type Server, createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type JWK, SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { buildApp } from "../src/index.js";

const ISSUER = "https://auth.test.example";
const AUDIENCE = "https://mcp.test.example";
const KID = "test-key";

let privateKey: CryptoKey;
let jwksServer: Server;
let backendServer: Server;
let appServer: Server;
let mcpUrl: string;
let backendRequests: Array<{ url: string; headers: Record<string, unknown> }> = [];

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") throw new Error("no port");
      resolve(addr.port);
    });
  });
}

async function signToken(
  claims: Record<string, unknown>,
  expSeconds = 300,
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${expSeconds}s`)
    .sign(privateKey);
}

beforeAll(async () => {
  const kp = await generateKeyPair("ES256");
  privateKey = kp.privateKey;
  const jwk: JWK = {
    ...(await exportJWK(kp.publicKey)),
    kid: KID,
    alg: "ES256",
    use: "sig",
  };

  jwksServer = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  const jwksPort = await listen(jwksServer);

  backendServer = createServer((req, res) => {
    backendRequests.push({ url: req.url ?? "", headers: req.headers });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ answer_kind: "none", memories: [] }));
  });
  const backendPort = await listen(backendServer);

  const cfg: Config = {
    backendUrl: `http://127.0.0.1:${backendPort}`,
    apiKey: "brain_service_key",
    namespace: "default-ns",
    namespaceHeader: "x-brain-namespace",
    scopeHeader: "x-brain-space",
    port: 0,
    host: "127.0.0.1",
    requestTimeoutMs: 2000,
    oauth: {
      issuer: ISSUER,
      jwksUri: `http://127.0.0.1:${jwksPort}/jwks`,
      audience: AUDIENCE,
      publicUrl: AUDIENCE,
      requiredScopes: [],
      namespaceClaim: "namespace",
    },
  };
  appServer = buildApp(cfg).listen(0, "127.0.0.1");
  const port = await listen(appServer);
  mcpUrl = `http://127.0.0.1:${port}/mcp`;
});

afterAll(async () => {
  for (const s of [appServer, backendServer, jwksServer]) {
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

describe("brain-mcp OAuth resource server", () => {
  it("serves RFC 9728 protected-resource metadata", async () => {
    const base = mcpUrl.replace(/\/mcp$/, "");
    const res = await fetch(`${base}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc.resource).toBe(AUDIENCE);
    expect(doc.authorization_servers).toEqual([ISSUER]);
  });

  it("rejects a request with no token (401 + WWW-Authenticate)", async () => {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata");
  });

  it("rejects a token from the wrong issuer (401)", async () => {
    const bad = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: KID })
      .setIssuer("https://evil.example")
      .setAudience(AUDIENCE)
      .setExpirationTime("300s")
      .sign(privateKey);
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${bad}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(401);
  });

  it("accepts a valid token and routes to the token's tenant namespace", async () => {
    backendRequests = [];
    const token = await signToken({ namespace: "tenant-x", scope: "" });
    const client = new Client({ name: "oauth-e2e", version: "0" });
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    const res = await client.callTool({
      name: "recall",
      arguments: { customer_id: "cust-42", query: "anything" },
    });
    expect(res.isError).toBeFalsy();
    await client.close();

    const recall = backendRequests.find((r) => r.url === "/v1/recall");
    expect(recall).toBeDefined();
    // The namespace came from the token claim, not the server default.
    expect(recall?.headers["x-brain-namespace"]).toBe("tenant-x");
    expect(recall?.headers["x-brain-space"]).toBe("cust-42");
  });
});
