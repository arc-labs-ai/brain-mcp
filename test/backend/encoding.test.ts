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
const bodies: string[] = [];
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    seen.push(req.url ?? "");
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
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
    requestTimeoutMs: 5000,
  } as Config;
  return new BrainBackend(cfg, "brain_test_key");
}

/** The most recent URL the server actually received. */
function lastUrl(): string {
  const u = seen.at(-1);
  if (u === undefined) throw new Error("no request recorded");
  return u;
}

/**
 * The most recent request BODY the server received, parsed.
 *
 * A field the edge does not define is dropped silently, so asserting on the
 * body is the only way to catch an option that never arrives — which is what
 * `depth`/`limit` on traverse did.
 */
function lastBody(): Record<string, unknown> {
  const b = bodies.at(-1);
  if (b === undefined) throw new Error("no request recorded");
  return b === "" ? {} : (JSON.parse(b) as Record<string, unknown>);
}

describe("brain-mcp URL construction", () => {
  it("an entity id cannot escape its path segment", async () => {
    // A raw `..%2f` style id concatenated unescaped would retarget the request
    // at a different endpoint entirely.
    await backend().getEntity("../../v1/schema");
    const url = lastUrl();

    expect(url.startsWith("/v1/entities/")).toBe(true);
    expect(url).not.toContain("/v1/schema");
    // The separators must survive as data, not as path structure.
    expect(url).toContain("%2F");
  });

  it("an entity id containing a query delimiter stays in the path", async () => {
    await backend().getEntity("abc?admin=true");
    const url = lastUrl();

    // One `?` only — the one `withQuery` would add, and here there is none.
    expect(url.split("?").length).toBe(1);
    expect(url).toContain("%3F");
  });

  it("a cursor cannot inject extra query parameters", async () => {
    // `&limit=9999` appended raw would silently widen the page size.
    await backend().listMemories({ cursor: "abc&limit=9999", limit: 10 });
    const url = lastUrl();
    const qs = new URLSearchParams(url.split("?")[1] ?? "");

    expect(qs.get("limit")).toBe("10");
    expect(qs.get("cursor")).toBe("abc&limit=9999");
    expect(qs.getAll("limit")).toHaveLength(1);
  });

  it("omits optional params entirely rather than sending empty ones", async () => {
    // `?limit=&cursor=` is not the same request as `?` — an empty string is a
    // value, and a backend is entitled to reject or misread it.
    await backend().listMemories({});
    expect(lastUrl()).toBe("/v1/memories");

    await backend().listMemories({ limit: 5 });
    expect(lastUrl()).toBe("/v1/memories?limit=5");
  });

  it("builds the nested entity paths the edge actually serves", async () => {
    const b = backend();
    await b.entityRelations("e-1");
    expect(lastUrl()).toBe("/v1/entities/e-1/relations");

    await b.traverseEntity("e-1", { depth: 2 });
    expect(lastUrl()).toBe("/v1/entities/e-1/traverse");

    await b.inspectMemory("m-1");
    expect(lastUrl()).toBe("/v1/memories/m-1/inspect");
  });

  /*
   * The query field is `type_id`, and this test asserted `entity_type_id`.
   *
   * `entity_type_id` is the WIRE field's name, not the query parameter's, so
   * the edge never saw the filter: an unknown query key is dropped, the type
   * defaulted to 0, and Brain refuses 0 with "entity_type_id filter is
   * required in v1.0 ENTITY_LIST". Every list_entities call failed, and this
   * test passed throughout, because it checked the name the caller used
   * rather than the one the route reads.
   */
  it("list_entities sends the type filter under the query field the edge reads", async () => {
    await backend().listEntities(7, { limit: 25 });
    const qs = new URLSearchParams(lastUrl().split("?")[1] ?? "");
    expect(qs.get("type_id")).toBe("7");
    expect(qs.get("entity_type_id")).toBeNull();
    expect(qs.get("limit")).toBe("25");
  });

  it("traverse_entity sends the body fields the edge reads", async () => {
    // Same class of defect: the body carried `depth`/`limit`, which
    // TraverseBody does not define, so both were dropped and every traversal
    // silently ran at the server defaults.
    const b = backend();
    await b.traverseEntity("e-1", { max_depth: 2, max_nodes: 50, direction: "both" });
    expect(lastBody()).toMatchObject({
      max_depth: 2,
      max_nodes: 50,
      direction: "both",
    });
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
