/**
 * Every option a tool accepts must reach the wire, under the name the route
 * actually reads.
 *
 * This is the one defect class the rest of the suite could not see. An option
 * is forwarded as a field name, and a field the edge does not define is
 * dropped in silence — no error, no warning, the call just behaves as though
 * the caller had not passed it. Three shipped that way:
 *
 *   * `list_entities` sent `entity_type_id`; the query field is `type_id`,
 *     so the filter never arrived and Brain refused the call outright.
 *   * `traverse_entity` sent `depth`/`limit`; the body fields are
 *     `max_depth`/`max_nodes`, so every traversal ran at the defaults.
 *   * `entity_relations` had no type filter at all, and the field it would
 *     need is spelled `type`, not `relation_type`.
 *
 * Asserting on the request the server RECEIVED is what separates "the client
 * meant to send this" from "the route will read it".
 */

import { type IncomingMessage, type Server, createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrainBackend } from "../../src/backend/index.js";
import type { Config } from "../../src/config/index.js";

const urls: string[] = [];
const bodies: string[] = [];
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    urls.push(req.url ?? "");
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
  return new BrainBackend(
    { backendUrl: baseUrl, requestTimeoutMs: 5000 } as Config,
    "brain_test_key",
  );
}

/** Query parameters of the most recent request. */
function query(): URLSearchParams {
  return new URLSearchParams((urls.at(-1) ?? "").split("?")[1] ?? "");
}

/** Parsed body of the most recent request. */
function body(): Record<string, unknown> {
  const b = bodies.at(-1) ?? "";
  return b === "" ? {} : (JSON.parse(b) as Record<string, unknown>);
}

describe("options reach the wire — bodies", () => {
  it("remember carries session and event time", async () => {
    await backend().remember("x", {
      session: 4,
      occurred_at_unix_nanos: 1_700_000_000_000,
    });
    expect(body()).toMatchObject({
      text: "x",
      session: 4,
      occurred_at_unix_nanos: 1_700_000_000_000,
    });
  });

  it("recall carries every read option", async () => {
    await backend().recall("q", {
      max_results: 5,
      subject: "s-1",
      scope: "namespace",
      include_graph: true,
      include_trace: true,
    });
    expect(body()).toMatchObject({
      query: "q",
      max_results: 5,
      subject: "s-1",
      scope: "namespace",
      include_graph: true,
      include_trace: true,
    });
  });

  it("an omitted option is ABSENT, not null", async () => {
    // The edge's optional fields are `#[serde(default)]` over an Option; an
    // explicit null is a deserialization error on the ones that are not
    // themselves nullable, so omission has to mean omission.
    await backend().recall("q");
    expect(body()).toEqual({ query: "q" });
    expect("max_results" in body()).toBe(false);
  });

  it("traverse carries the wire's own field names", async () => {
    await backend().traverseEntity("e-1", {
      direction: "both",
      relation_types: ["acme:owns"],
      max_depth: 4,
      max_nodes: 250,
      include_superseded: true,
    });
    expect(body()).toMatchObject({
      direction: "both",
      relation_types: ["acme:owns"],
      max_depth: 4,
      max_nodes: 250,
      include_superseded: true,
    });
  });

  it("resolve_entity carries context, hint and create", async () => {
    await backend().resolveEntity("Priya", {
      resolution_context: "billing team",
      type_hint: 3,
      allow_create: true,
    });
    expect(body()).toMatchObject({
      candidate_name: "Priya",
      resolution_context: "billing team",
      type_hint: 3,
      allow_create: true,
    });
  });

  it("create_entity carries aliases", async () => {
    await backend().createEntity(2, "Acme Corp", ["Acme", "ACME Inc"]);
    expect(body()).toMatchObject({
      entity_type_id: 2,
      canonical_name: "Acme Corp",
      aliases: ["Acme", "ACME Inc"],
    });
  });

  it("link carries weight, including a negative one", async () => {
    // `contradicts` takes -1..1, so the sign has to survive the trip.
    await backend().link("m-1", "m-2", "contradicts", -0.8);
    expect(body()).toMatchObject({ kind: "contradicts", weight: -0.8 });
  });

  it("plan and reason carry their budgets", async () => {
    const b = backend();
    await b.plan("here", "there", {
      max_steps: 4,
      max_branches: 3,
      max_wall_time_ms: 2000,
      strategy: "astar",
      include_trace: true,
    });
    expect(body()).toMatchObject({
      max_steps: 4,
      max_branches: 3,
      max_wall_time_ms: 2000,
      strategy: "astar",
      include_trace: true,
    });

    await b.reason("obs", {
      depth: 2,
      confidence_threshold: 0.4,
      max_inferences: 10,
      budget_wall_time_ms: 1500,
      include_trace: true,
    });
    expect(body()).toMatchObject({
      depth: 2,
      confidence_threshold: 0.4,
      max_inferences: 10,
      budget_wall_time_ms: 1500,
      include_trace: true,
    });
  });

  it("explain and trace carry the full query shape", async () => {
    const opts = {
      entity_anchor: "e-9",
      kinds: ["episodic"],
      predicates: ["acme:owns"],
      sessions: [1, 2],
      time_range: { from_unix_ms: 1, to_unix_ms: 2 },
      confidence_min: 0.3,
      include_superseded: true,
      limit: 25,
      retrievers: ["semantic"],
      fusion: { k: 20, semantic_weight: 2 },
    };
    const b = backend();
    await b.explainQuery("why", opts);
    expect(body()).toMatchObject({ text: "why", ...opts });
    await b.traceQuery("why", opts);
    expect(body()).toMatchObject({ text: "why", ...opts });
  });

  it("upload_schema carries dry_run, allow_breaking and scope", async () => {
    await backend().uploadSchema("namespace acme", {
      dry_run: true,
      allow_breaking: true,
      scope: "space",
    });
    expect(body()).toMatchObject({
      schema_document: "namespace acme",
      dry_run: true,
      allow_breaking: true,
      scope: "space",
    });
  });

  it("materialize carries the session filter", async () => {
    await backend().materialiseDirectives({ sessions: [7], top_k: 3 });
    expect(body()).toMatchObject({ sessions: [7], top_k: 3 });
  });
});

describe("options reach the wire — query strings", () => {
  it("list_memories carries dir and include_tombstoned", async () => {
    await backend().listMemories({ limit: 10, dir: "asc", include_tombstoned: true });
    expect(query().get("dir")).toBe("asc");
    expect(query().get("include_tombstoned")).toBe("true");
  });

  it("list_entities sends the type under `type_id`", async () => {
    await backend().listEntities(7, {
      prefix: "Ac",
      mention_count_min: 2,
      include_merged: true,
      include_tombstoned: true,
    });
    const q = query();
    expect(q.get("type_id")).toBe("7");
    expect(q.get("entity_type_id")).toBeNull();
    expect(q.get("prefix")).toBe("Ac");
    expect(q.get("mention_count_min")).toBe("2");
    expect(q.get("include_merged")).toBe("true");
  });

  it("entity_relations sends the type filter under `type`", async () => {
    await backend().entityRelations("e-1", {
      direction: "to",
      relation_type: "acme:owns",
      include_superseded: true,
    });
    const q = query();
    expect(q.get("type")).toBe("acme:owns");
    expect(q.get("relation_type")).toBeNull();
    expect(q.get("direction")).toBe("to");
    expect(q.get("include_superseded")).toBe("true");
  });

  it("list_statements carries every filter", async () => {
    await backend().listStatements({
      subject: "e-1",
      predicate: "acme:owns",
      kind: "fact",
      min_confidence: 0.5,
      only_current: false,
      include_tombstoned: true,
    });
    const q = query();
    expect(q.get("subject")).toBe("e-1");
    expect(q.get("predicate")).toBe("acme:owns");
    expect(q.get("kind")).toBe("fact");
    expect(q.get("min_confidence")).toBe("0.5");
    expect(q.get("only_current")).toBe("false");
    expect(q.get("include_tombstoned")).toBe("true");
  });

  it("statement_history pages", async () => {
    await backend().statementHistory("s-1", {
      limit: 5,
      cursor: "ab",
      include_tombstoned: true,
    });
    const q = query();
    expect(q.get("limit")).toBe("5");
    expect(q.get("cursor")).toBe("ab");
  });

  it("get_statement and get_relation carry follow_supersession", async () => {
    const b = backend();
    await b.getStatement("s-1", true);
    expect(query().get("follow_supersession")).toBe("true");
    await b.getRelation("r-1", false);
    expect(query().get("follow_supersession")).toBe("false");
  });

  it("delete_relation sends a NUMERIC reason", async () => {
    // The route takes Brain's closed audit set as a u8. A free-text reason is
    // "invalid digit found in string" — a 400 on every call that gave one.
    await backend().deleteRelation("r-1", { reason: 2, message: "obsolete" });
    const q = query();
    expect(q.get("reason")).toBe("2");
    expect(q.get("message")).toBe("obsolete");
  });

  it("graph carries its layer toggles", async () => {
    await backend().graph({
      include_statements: true,
      include_memories: true,
      include_memory_edges: true,
    });
    const q = query();
    expect(q.get("include_statements")).toBe("true");
    expect(q.get("include_memories")).toBe("true");
    expect(q.get("include_memory_edges")).toBe("true");
  });

  it("get_schema carries namespace and version", async () => {
    await backend().getSchema({ namespace: "acme", version: 3 });
    const q = query();
    expect(q.get("namespace")).toBe("acme");
    expect(q.get("version")).toBe("3");
  });

  it("drop_schema_type carries force and scope", async () => {
    await backend().dropSchemaType("predicate", "acme:x", {
      force: true,
      scope: "space",
    });
    const q = query();
    expect(q.get("force")).toBe("true");
    expect(q.get("scope")).toBe("space");
  });
});
