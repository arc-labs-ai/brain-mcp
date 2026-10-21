/**
 * Path and query construction, which is where a thin HTTP client gets it
 * wrong.
 *
 * Several of these methods interpolate caller-supplied values into the URL —
 * entity ids into the path, cursors into the query. An id or cursor is opaque
 * to us: it comes back from the server and goes out again unexamined. If it is
 * concatenated raw, a value containing `/`, `?`, `&` or `=` stops being data
 * and starts being structure, and the request that leaves is not the one the
 * caller asked for.
 *
 * These drive a real local server and assert on the raw `req.url` it received,
 * so they check what actually went over the wire rather than what the client
 * intended.
 */

import { type IncomingMessage, type Server, createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrainBackend } from "../../src/backend/index.js";
import type { Config } from "../../src/config/index.js";

const seen: string[] = [];
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    seen.push(req.url ?? "");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function backend(): BrainBackend {
  const cfg: Config = {
    backendUrl: baseUrl,
    apiKey: "brain_test_key",
    namespace: "acme",
    namespaceHeader: "x-brain-namespace",
    scopeHeader: "x-brain-customer",
    requestTimeoutMs: 5000,
  } as Config;
  return new BrainBackend(cfg);
}

/** The most recent URL the server actually received. */
function lastUrl(): string {
  const u = seen.at(-1);
  if (u === undefined) throw new Error("no request recorded");
  return u;
}

describe("brain-mcp URL construction", () => {
  it("an entity id cannot escape its path segment", async () => {
    // A raw `..%2f` style id concatenated unescaped would retarget the request
    // at a different endpoint entirely.
    await backend().getEntity("cust-1", "../../v1/schema");
    const url = lastUrl();

    expect(url.startsWith("/v1/entities/")).toBe(true);
    expect(url).not.toContain("/v1/schema");
    // The separators must survive as data, not as path structure.
    expect(url).toContain("%2F");
  });

  it("an entity id containing a query delimiter stays in the path", async () => {
    await backend().getEntity("cust-1", "abc?admin=true");
    const url = lastUrl();

    // One `?` only — the one `withQuery` would add, and here there is none.
    expect(url.split("?").length).toBe(1);
    expect(url).toContain("%3F");
  });

  it("a cursor cannot inject extra query parameters", async () => {
    // `&limit=9999` appended raw would silently widen the page size.
    await backend().listMemories("cust-1", { cursor: "abc&limit=9999", limit: 10 });
    const url = lastUrl();
    const qs = new URLSearchParams(url.split("?")[1] ?? "");

    expect(qs.get("limit")).toBe("10");
    expect(qs.get("cursor")).toBe("abc&limit=9999");
    expect(qs.getAll("limit")).toHaveLength(1);
  });

  it("omits optional params entirely rather than sending empty ones", async () => {
    // `?limit=&cursor=` is not the same request as `?` — an empty string is a
    // value, and a backend is entitled to reject or misread it.
    await backend().listMemories("cust-1", {});
    expect(lastUrl()).toBe("/v1/memories");

    await backend().listMemories("cust-1", { limit: 5 });
    expect(lastUrl()).toBe("/v1/memories?limit=5");
  });

  it("builds the nested entity paths the edge actually serves", async () => {
    const b = backend();
    await b.entityRelations("cust-1", "e-1");
    expect(lastUrl()).toBe("/v1/entities/e-1/relations");

    await b.traverseEntity("cust-1", "e-1", { depth: 2 });
    expect(lastUrl()).toBe("/v1/entities/e-1/traverse");

    await b.inspectMemory("cust-1", "m-1");
    expect(lastUrl()).toBe("/v1/memories/m-1/inspect");
  });

  it("list_entities sends the required entity_type_id alongside paging", async () => {
    await backend().listEntities("cust-1", 7, { limit: 25 });
    const qs = new URLSearchParams(lastUrl().split("?")[1] ?? "");
    expect(qs.get("entity_type_id")).toBe("7");
    expect(qs.get("limit")).toBe("25");
  });
});

describe("response hygiene", () => {
  it("summarises the embedding instead of spending the agent's context on it", async () => {
    // Measured live: artifact.vector was 4,716 of 8,701 characters — 54% of
    // the response — and 384 raw floats are not actionable for an agent.
    const vector = Array.from({ length: 384 }, () => 0.05);
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          found: true,
          memory_id: "42",
          text: "Ada likes dark roast",
          artifact: { vector, record: { kind: 0 }, graph: { nodes: [], edges: [] } },
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("no port");
    const backend = new BrainBackend({
      backendUrl: `http://127.0.0.1:${addr.port}`,
      apiKey: "brain_test_key",
      namespace: "acme",
      namespaceHeader: "x-brain-namespace",
      scopeHeader: "x-brain-customer",
      requestTimeoutMs: 5000,
    } as Config);

    const out = await backend.inspectMemory("c1", "42");
    const artifact = out.artifact as Record<string, unknown>;
    const summary = artifact.vector as Record<string, unknown>;

    expect(Array.isArray(summary)).toBe(false);
    expect(summary.dimensions).toBe(384);
    // sqrt(384 * 0.05^2) = 0.9798
    expect(summary.magnitude).toBeCloseTo(0.9798, 3);
    // Everything else survives untouched.
    expect(out.text).toBe("Ada likes dark roast");
    expect(artifact.graph).toEqual({ nodes: [], edges: [] });
    // And the response is no longer dominated by numbers.
    expect(JSON.stringify(out).length).toBeLessThan(400);

    await new Promise<void>((r) => server.close(() => r()));
  });
});
