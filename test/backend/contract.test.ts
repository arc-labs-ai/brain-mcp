/**
 * End-to-end contract test: a real MCP client drives all four tools through the
 * server, against a real (local) HTTP backend that records every request. This
 * asserts the exact wire contract the MCP server emits to Brain's /v1/* surface
 * — method, path, credential, and body — which is the real integration risk.
 * It needs no Brain: the backend is a controlled stand-in returning the real
 * DTO shapes.
 */

import { type IncomingMessage, type Server, createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrainBackend } from "../../src/backend/index.js";
import type { Config } from "../../src/config/index.js";
import { buildServer } from "../../src/server/index.js";

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
      // Permissive 200 for the route-table sweep below. The four cases above
      // keep their exact DTOs because those tests assert on the mapped result;
      // the sweep asserts only on the request, so the response just has to be
      // rich enough that result mapping does not throw and mask a route match.
      res.end(
        JSON.stringify({
          memory_id: "42",
          entity_id: "e",
          statement_id: "st",
          relation_id: "r",
          session_id: "sess",
          namespace: "acme",
          space_id: "s",
          answer_kind: "none",
          memories: [],
          items: [],
          entities: [],
          statements: [],
          relations: [],
          sessions: [],
          spaces: [],
          versions: [],
          extractors: [],
          directives: [],
          history: [],
          nodes: [],
          edges: [],
          steps: [],
          permissions: {},
          capabilities: {},
          schema: {},
          plan: {},
          trace: {},
          valid: true,
          present: false,
          forgotten: true,
        }),
      );
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
    port: 0,
    host: "127.0.0.1",
    requestTimeoutMs: 2000,
  };
}

async function client(credential = "brain_test_key"): Promise<Client> {
  const srv = buildServer(new BrainBackend(makeConfig(), credential));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await srv.connect(st);
  const c = new Client({ name: "e2e", version: "0" });
  await c.connect(ct);
  return c;
}

describe("brain-mcp → /v1/* contract", () => {
  it("remember → POST /v1/memories as the caller's credential + {text}", async () => {
    captured.length = 0;
    const c = await client();
    const res = await c.callTool({
      name: "remember",
      arguments: { content: "Ada likes dark roast" },
    });
    expect(res.isError).toBeFalsy();
    const req = captured.at(-1);
    expect(req?.method).toBe("POST");
    expect(req?.url).toBe("/v1/memories");
    expect(req?.headers.authorization).toBe("Bearer brain_test_key");
    // The scope headers are deliberately NOT sent. The gateway reads them only
    // for console JWTs and ignores them for API keys, so sending them alongside
    // a key was a no-op that read like isolation. Asserted so a well-meaning
    // re-add has to come past this test.
    expect(req?.headers["x-brain-namespace"]).toBeUndefined();
    expect(req?.headers["x-brain-space"]).toBeUndefined();
    expect(req?.body).toEqual({ text: "Ada likes dark roast" });
    await c.close();
  });

  it("recall → POST /v1/recall with {query, max_results} and returns hits", async () => {
    captured.length = 0;
    const c = await client();
    const res = await c.callTool({
      name: "recall",
      arguments: { query: "coffee?", max_results: 5 },
    });
    const req = captured.at(-1);
    expect(req?.method).toBe("POST");
    expect(req?.url).toBe("/v1/recall");
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
      arguments: { memory_id: "42", hard: true },
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
    await c.callTool({ name: "whoami", arguments: {} });
    const req = captured.at(-1);
    expect(req?.method).toBe("GET");
    expect(req?.url).toBe("/v1/whoami");
    await c.close();
  });

  it("each caller's own credential reaches the backend, not a shared one", async () => {
    captured.length = 0;
    const alice = await client("brain_alice");
    const bob = await client("brain_bob");
    await alice.callTool({ name: "remember", arguments: { content: "alice's" } });
    await bob.callTool({ name: "remember", arguments: { content: "bob's" } });
    expect(captured.map((c) => c.headers.authorization)).toEqual([
      "Bearer brain_alice",
      "Bearer brain_bob",
    ]);
    await alice.close();
    await bob.close();
  });
});

// ---------------------------------------------------------------------------
// Every tool, not four of them.
//
// The four tests above assert request *bodies* precisely, which is worth doing
// for the core loop. But they covered 4 of 49 tools, so the method and path
// of the other 45 — the thing this file calls "the real integration risk" —
// were unverified. A tool pointed at a route the edge does not serve would
// have passed every test in this repo and failed on first contact.
//
// Each row was produced by driving the tool and recording what it emitted,
// then checking that route against brain-sdk's `contract/http-routes.json` —
// the manifest generated from brain-edge's own source. All 49 matched a route
// the edge actually serves, so this table is pinned truth rather than pinned
// behaviour. Re-run that cross-check when the edge's surface moves.
// ---------------------------------------------------------------------------

interface RouteCase {
  tool: string;
  args: Record<string, unknown>;
  method: string;
  path: string;
}

const ROUTES: RouteCase[] = [
  { tool: "capabilities", args: {}, method: "GET", path: "/v1/capabilities" },
  {
    tool: "create_entity",
    args: { entity_type_id: 1, canonical_name: "x" },
    method: "POST",
    path: "/v1/entities",
  },
  {
    tool: "create_relation",
    args: { relation_type: "acme:prefers", from_entity: "x", to_entity: "x" },
    method: "POST",
    path: "/v1/relations",
  },
  {
    tool: "create_session",
    args: { session_id: 0 },
    method: "POST",
    path: "/v1/sessions",
  },
  {
    tool: "create_statement",
    args: {
      kind: "fact",
      subject: "x",
      predicate: "acme:prefers",
      object: { kind: "entity", id: "e1" },
    },
    method: "POST",
    path: "/v1/statements",
  },
  {
    tool: "delete_entity",
    args: { entity_id: "x" },
    method: "DELETE",
    path: "/v1/entities/x",
  },
  {
    tool: "delete_relation",
    args: { relation_id: "x" },
    method: "DELETE",
    path: "/v1/relations/x",
  },
  {
    tool: "delete_session",
    args: { session_id: 0 },
    method: "DELETE",
    path: "/v1/sessions/0",
  },
  {
    tool: "delete_statement",
    args: { statement_id: "x" },
    method: "DELETE",
    path: "/v1/statements/x",
  },
  {
    tool: "drop_schema_type",
    args: { kind: "predicate", name: "x" },
    method: "DELETE",
    path: "/v1/schema/predicate/x",
  },
  {
    tool: "entity_relations",
    args: { entity_id: "x" },
    method: "GET",
    path: "/v1/entities/x/relations",
  },
  {
    tool: "explain_query",
    args: { text: "x" },
    method: "POST",
    path: "/v1/query/explain",
  },
  { tool: "forget", args: { memory_id: "x" }, method: "DELETE", path: "/v1/memories" },
  { tool: "get_entity", args: { entity_id: "x" }, method: "GET", path: "/v1/entities/x" },
  {
    tool: "get_relation",
    args: { relation_id: "x" },
    method: "GET",
    path: "/v1/relations/x",
  },
  { tool: "get_schema", args: {}, method: "GET", path: "/v1/schema" },
  {
    tool: "get_statement",
    args: { statement_id: "x" },
    method: "GET",
    path: "/v1/statements/x",
  },
  { tool: "graph", args: {}, method: "GET", path: "/v1/graph" },
  {
    tool: "inspect_memory",
    args: { memory_id: "x" },
    method: "GET",
    path: "/v1/memories/x/inspect",
  },
  {
    tool: "link",
    args: { source: "x", target: "x", kind: "caused" },
    method: "POST",
    path: "/v1/links",
  },
  {
    tool: "list_entities",
    args: { entity_type_id: 1 },
    method: "GET",
    path: "/v1/entities",
  },
  { tool: "list_extractors", args: {}, method: "GET", path: "/v1/extractors" },
  { tool: "list_memories", args: {}, method: "GET", path: "/v1/memories" },
  { tool: "list_schema_versions", args: {}, method: "GET", path: "/v1/schemas" },
  { tool: "list_sessions", args: {}, method: "GET", path: "/v1/sessions" },
  { tool: "list_spaces", args: {}, method: "GET", path: "/v1/spaces" },
  { tool: "list_statements", args: {}, method: "GET", path: "/v1/statements" },
  { tool: "llm_credential_status", args: {}, method: "GET", path: "/v1/llm-credential" },
  {
    tool: "materialize_directives",
    args: {},
    method: "POST",
    path: "/v1/procedural/materialize",
  },
  {
    tool: "merge_entities",
    args: { survivor_entity_id: "x", merged_entity_id: "x" },
    method: "POST",
    path: "/v1/entities/x/merge",
  },
  { tool: "plan", args: { start: "x", goal: "x" }, method: "POST", path: "/v1/plan" },
  { tool: "reason", args: { observation: "x" }, method: "POST", path: "/v1/reason" },
  { tool: "recall", args: { query: "x" }, method: "POST", path: "/v1/recall" },
  { tool: "remember", args: { content: "x" }, method: "POST", path: "/v1/memories" },
  {
    tool: "rename_entity",
    args: { entity_id: "x", new_canonical_name: "x" },
    method: "POST",
    path: "/v1/entities/x/rename",
  },
  {
    tool: "resolve_entity",
    args: { candidate_name: "x" },
    method: "POST",
    path: "/v1/entities/resolve",
  },
  {
    tool: "retract_statement",
    args: { statement_id: "x" },
    method: "POST",
    path: "/v1/statements/x/retract",
  },
  {
    tool: "statement_history",
    args: { statement_id: "x" },
    method: "GET",
    path: "/v1/statements/x/history",
  },
  {
    tool: "supersede_relation",
    args: {
      relation_id: "x",
      relation_type: "acme:prefers",
      from_entity: "x",
      to_entity: "x",
    },
    method: "POST",
    path: "/v1/relations/x/supersede",
  },
  {
    tool: "supersede_statement",
    args: {
      statement_id: "x",
      kind: "fact",
      subject: "x",
      predicate: "acme:prefers",
      object: { kind: "entity", id: "e1" },
    },
    method: "POST",
    path: "/v1/statements/x/supersede",
  },
  { tool: "trace_query", args: { text: "x" }, method: "POST", path: "/v1/query/trace" },
  {
    tool: "traverse_entity",
    args: { entity_id: "x" },
    method: "POST",
    path: "/v1/entities/x/traverse",
  },
  {
    tool: "unlink",
    args: { source: "x", target: "x", kind: "caused" },
    method: "DELETE",
    path: "/v1/links",
  },
  {
    tool: "unmerge_entity",
    args: { entity_id: "x" },
    method: "POST",
    path: "/v1/entities/x/unmerge",
  },
  {
    tool: "update_entity",
    args: { entity_id: "x", canonical_name: "x" },
    method: "PUT",
    path: "/v1/entities/x",
  },
  {
    tool: "upload_schema",
    args: { schema_document: "x" },
    method: "POST",
    path: "/v1/schema",
  },
  {
    tool: "validate_schema",
    args: { schema_document: "x" },
    method: "POST",
    path: "/v1/schema/validate",
  },
  {
    tool: "verify_llm_credential",
    args: {},
    method: "POST",
    path: "/v1/llm-credential/verify",
  },
  { tool: "whoami", args: {}, method: "GET", path: "/v1/whoami" },
];

describe("every tool's route", () => {
  it("covers every registered tool", async () => {
    // The coverage gate. A tool added without a row here is a tool whose
    // route nothing checks, which is exactly the hole this suite was in.
    const c = await client();
    const { tools } = await c.listTools();
    await c.close();
    const registered = new Set(tools.map((t) => t.name));
    const tabled = new Set(ROUTES.map((r) => r.tool));

    const missing = [...registered].filter((n) => !tabled.has(n)).sort();
    expect(missing, "tools with no route-table row").toEqual([]);

    const stale = [...tabled].filter((n) => !registered.has(n)).sort();
    expect(stale, "route-table rows for tools that do not exist").toEqual([]);
  });

  it.each(ROUTES)("$tool → $method $path", async ({ tool, args, method, path }) => {
    captured.length = 0;
    const c = await client();
    await c.callTool({ name: tool, arguments: args });
    const req = captured.at(-1);
    expect(req, `${tool} sent no request at all`).toBeDefined();
    expect(req?.method, `${tool} method`).toBe(method);
    expect((req?.url ?? "").split("?")[0], `${tool} path`).toBe(path);
    // Pass-through holds for every tool, not just the ones with their own test.
    expect(req?.headers.authorization, `${tool} credential`).toBe(
      "Bearer brain_test_key",
    );
    // And no tool reintroduces the scope headers the gateway ignores for keys.
    expect(req?.headers["x-brain-namespace"], `${tool} namespace header`).toBeUndefined();
    expect(req?.headers["x-brain-space"], `${tool} space header`).toBeUndefined();
    await c.close();
  });
});
