/**
 * End-to-end contract test: a real MCP client drives all four tools through the
 * server, against a real (local) HTTP backend that records every request. This
 * asserts the exact wire contract the MCP server emits to Brain's /v1/* surface
 * — method, path, scope headers, and body — which is the real integration risk.
 * It needs no Brain: the backend is a controlled stand-in returning the real
 * DTO shapes.
 */

import { type IncomingMessage, type Server, createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrainBackend } from "../src/backend.js";
import type { Config } from "../src/config.js";
import { buildServer } from "../src/server.js";

interface Captured {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

const captured: Captured[] = [];
let server: Server;
let baseUrl: string;

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = await readBody(req);
    captured.push({
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
      body,
    });
    res.setHeader("content-type", "application/json");
    const path = (req.url ?? "").split("?")[0];
    if (path === "/v1/memories" && req.method === "POST") {
      res.end(JSON.stringify({ memory_id: "42", was_deduplicated: false }));
    } else if (path === "/v1/recall") {
      res.end(
        JSON.stringify({
          answer_kind: "single",
          memories: [{ memory_id: "42", text: "Ada likes dark roast" }],
        }),
      );
    } else if (path === "/v1/memories" && req.method === "DELETE") {
      res.end(JSON.stringify({ forgotten: true }));
    } else if (path === "/v1/whoami") {
      res.end(JSON.stringify({ namespace: "acme", bound: true }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeConfig(): Config {
  return {
    backendUrl: baseUrl,
    apiKey: "brain_test_key",
    namespace: "acme",
    namespaceHeader: "x-brain-namespace",
    scopeHeader: "x-brain-agent",
    port: 0,
    host: "127.0.0.1",
    requestTimeoutMs: 2000,
  };
}

async function client(): Promise<Client> {
  const srv = buildServer(new BrainBackend(makeConfig()));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await srv.connect(st);
  const c = new Client({ name: "e2e", version: "0" });
  await c.connect(ct);
  return c;
}

describe("brain-mcp → /v1/* contract", () => {
  it("remember → POST /v1/memories with scope headers + {text}", async () => {
    captured.length = 0;
    const c = await client();
    const res = await c.callTool({
      name: "remember",
      arguments: { customer_id: "cust-1", content: "Ada likes dark roast" },
    });
    expect(res.isError).toBeFalsy();
    const req = captured.at(-1);
    expect(req?.method).toBe("POST");
    expect(req?.url).toBe("/v1/memories");
    expect(req?.headers.authorization).toBe("Bearer brain_test_key");
    expect(req?.headers["x-brain-namespace"]).toBe("acme");
    expect(req?.headers["x-brain-agent"]).toBe("cust-1");
    expect(req?.body).toEqual({ text: "Ada likes dark roast" });
    await c.close();
  });

  it("recall → POST /v1/recall with {query, max_results} and returns hits", async () => {
    captured.length = 0;
    const c = await client();
    const res = await c.callTool({
      name: "recall",
      arguments: { customer_id: "cust-1", query: "coffee?", max_results: 5 },
    });
    const req = captured.at(-1);
    expect(req?.method).toBe("POST");
    expect(req?.url).toBe("/v1/recall");
    expect(req?.headers["x-brain-agent"]).toBe("cust-1");
    expect(req?.body).toEqual({ query: "coffee?", max_results: 5 });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(text).toContain("dark roast");
    await c.close();
  });

  it("forget → DELETE /v1/memories with {memory_id, hard}", async () => {
    captured.length = 0;
    const c = await client();
    await c.callTool({
      name: "forget",
      arguments: { customer_id: "cust-1", memory_id: "42", hard: true },
    });
    const req = captured.at(-1);
    expect(req?.method).toBe("DELETE");
    expect(req?.url).toBe("/v1/memories");
    expect(req?.body).toEqual({ memory_id: "42", hard: true });
    await c.close();
  });

  it("whoami → GET /v1/whoami", async () => {
    captured.length = 0;
    const c = await client();
    await c.callTool({ name: "whoami", arguments: { customer_id: "cust-1" } });
    const req = captured.at(-1);
    expect(req?.method).toBe("GET");
    expect(req?.url).toBe("/v1/whoami");
    expect(req?.headers["x-brain-agent"]).toBe("cust-1");
    await c.close();
  });
});
