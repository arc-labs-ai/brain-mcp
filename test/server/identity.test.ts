/**
 * The HTTP identity path: who a request runs as, and what happens when it says
 * nothing about that.
 *
 * This is the test for the property the hosted deployment rests on — one URL,
 * many users, each at their own identity. The backend-level half (a backend
 * instance forwards the credential it was built with) lives in
 * `test/backend/contract.test.ts`; this covers the part only the real Express
 * app can show: extracting the credential from the request, refusing the
 * request that has none, and never substituting one of its own.
 */

import { type Server, createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../../src/config/index.js";
import { buildApp } from "../../src/index.js";

let backendServer: Server;
let appServer: Server;
let mcpUrl: string;
let backendRequests: Array<{ url: string; authorization?: string }> = [];

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") throw new Error("no port");
      resolve(addr.port);
    });
  });
}

/** A bare JSON-RPC POST, bypassing the MCP client so headers are fully ours. */
async function post(headers: Record<string, string>): Promise<Response> {
  return fetch(mcpUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
}

async function callRecallAs(credential: string): Promise<void> {
  const client = new Client({ name: "identity-e2e", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${credential}` } },
  });
  await client.connect(transport);
  await client.callTool({ name: "recall", arguments: { query: "anything" } });
  await client.close();
}

beforeAll(async () => {
  backendServer = createServer((req, res) => {
    backendRequests.push({
      url: req.url ?? "",
      authorization: req.headers.authorization,
    });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ answer_kind: "none", memories: [] }));
  });
  const backendPort = await listen(backendServer);

  // Deliberately set, and deliberately never honoured on the HTTP path: this
  // is the ambient-authority trap. A server that fell back to it would serve
  // an unauthenticated caller as this key's owner — and would look healthy
  // doing it.
  process.env.BRAIN_MCP_API_KEY = "brain_server_held_key";

  const cfg: Config = {
    backendUrl: `http://127.0.0.1:${backendPort}`,
    port: 0,
    host: "127.0.0.1",
    requestTimeoutMs: 2000,
  };
  appServer = buildApp(cfg).listen(0, "127.0.0.1");
  const port = await listen(appServer);
  mcpUrl = `http://127.0.0.1:${port}/mcp`;
});

afterAll(async () => {
  process.env.BRAIN_MCP_API_KEY = undefined;
  for (const s of [appServer, backendServer]) {
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

describe("brain-mcp caller identity", () => {
  it("refuses a request with no Authorization header", async () => {
    backendRequests = [];
    const res = await post({});
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    const body = (await res.json()) as { error?: { message?: string } };
    // The message has to name the fix: the likeliest reader is someone who
    // pasted a client config without the header.
    expect(body.error?.message).toContain("Authorization");
    // Nothing was forwarded. An unauthenticated request must not reach Brain
    // at all, let alone reach it as somebody.
    expect(backendRequests).toEqual([]);
  });

  it("refuses a non-Bearer Authorization header", async () => {
    backendRequests = [];
    const res = await post({ authorization: "Basic YWxpY2U6c2VjcmV0" });
    expect(res.status).toBe(401);
    expect(backendRequests).toEqual([]);
  });

  it("refuses an empty Bearer value", async () => {
    backendRequests = [];
    const res = await post({ authorization: "Bearer   " });
    expect(res.status).toBe(401);
    expect(backendRequests).toEqual([]);
  });

  it("never substitutes a server-held credential for a missing one", async () => {
    // BRAIN_MCP_API_KEY is set in this process (see beforeAll). If the HTTP
    // path ever reads it, this request succeeds as that key's owner instead of
    // failing — the exact failure that is invisible in production because it
    // looks like everything working.
    backendRequests = [];
    const res = await post({});
    expect(res.status).toBe(401);
    expect(backendRequests.map((r) => r.authorization)).not.toContain(
      "Bearer brain_server_held_key",
    );
  });

  it("forwards each caller's own credential, concurrently", async () => {
    backendRequests = [];
    // Interleaved on purpose: per-request construction is what keeps two
    // callers apart, so the test must not let them run one after the other.
    await Promise.all([
      callRecallAs("brain_alice"),
      callRecallAs("brain_bob"),
      callRecallAs("brain_carol"),
    ]);
    const seen = backendRequests
      .filter((r) => r.url === "/v1/recall")
      .map((r) => r.authorization)
      .sort();
    expect(seen).toEqual([
      "Bearer brain_alice",
      "Bearer brain_bob",
      "Bearer brain_carol",
    ]);
  });

  it("serves /healthz without a credential", async () => {
    // The ALB health check presents no bearer. If liveness required one, every
    // task would be killed as unhealthy in a loop that reads like a crash.
    const res = await fetch(mcpUrl.replace(/\/mcp$/, "/healthz"));
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ status: "ok" });
  });
});
