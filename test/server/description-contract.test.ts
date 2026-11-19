import { type Server, createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrainBackend } from "../../src/backend/index.js";
import type { Config } from "../../src/config/index.js";
import { buildServer } from "../../src/server/index.js";

const schemaConfig: Config = {
  backendUrl: "http://127.0.0.1:9",
  port: 0,
  host: "127.0.0.1",
  requestTimeoutMs: 1000,
};

async function listTools() {
  const server = buildServer(new BrainBackend(schemaConfig, "test-key"), {
    readsLocalEnvironment: true,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

describe("descriptions and defaults match the wire contract", () => {
  it("advertises supersession following as the default for both reads", async () => {
    const tools = await listTools();
    for (const [name, field] of [
      ["get_statement", "statement_id"],
      ["get_relation", "relation_id"],
    ] as const) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool, `${name} should be registered`).toBeDefined();
      const properties = (tool?.inputSchema.properties ?? {}) as Record<
        string,
        { default?: unknown }
      >;
      expect(properties[field]).toBeDefined();
      const follow = properties.follow_supersession;
      expect(follow?.default, `${name} should default to the current head`).toBe(true);
    }
  });

  it("describes recall's real answer_kind values", async () => {
    const tools = await listTools();
    const recall = tools.find((tool) => tool.name === "recall");
    const description = recall?.description ?? "";
    expect(description).toContain("answer_kind");
    expect(description).toContain("many");
    expect(description).not.toContain("multiple");
  });

  it("explains that resolve_entity creation requires type_hint", async () => {
    const tools = await listTools();
    const resolve = tools.find((tool) => tool.name === "resolve_entity");
    const allowCreate = (
      (resolve?.inputSchema.properties ?? {}) as Record<string, { description?: string }>
    ).allow_create;
    const description = allowCreate?.description ?? "";
    expect(description).toContain("type_hint");
    expect(description).toContain("required");
  });

  it("documents every resolve_entity outcome and ambiguity candidates", async () => {
    const tools = await listTools();
    const resolve = tools.find((tool) => tool.name === "resolve_entity");
    const description = resolve?.description ?? "";

    for (const outcome of ["resolved", "ambiguous", "not_found", "created"]) {
      expect(description).toContain(`\`${outcome}\``);
    }
    expect(description).toContain("candidate_ids");
    expect(description).toContain("type_hint");
    expect(description).toContain("do not treat it as a miss");
  });

  it("describes fusion as an all-or-nothing lane override", async () => {
    const tools = await listTools();

    for (const name of ["explain_query", "trace_query"]) {
      const tool = tools.find((candidate) => candidate.name === name);
      const fusion = (
        (tool?.inputSchema.properties ?? {}) as Record<
          string,
          { description?: string; properties?: Record<string, { description?: string }> }
        >
      ).fusion;
      expect(fusion?.description, `${name} fusion description`).toContain(
        "all-or-nothing",
      );
      expect(fusion?.description).toContain("partial object is refused");
      expect(fusion?.properties?.semantic_weight?.description).toContain("semantic");
      expect(fusion?.properties?.lexical_weight?.description).toContain("lexical");
      expect(fusion?.properties?.graph_weight?.description).toContain("graph");
    }
  });

  it("documents the schema DSL forms needed by all schema writers", async () => {
    const tools = await listTools();
    const descriptions = new Map(
      tools.map((tool) => [
        tool.name,
        ((tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>)
          .schema_document?.description ?? "",
      ]),
    );
    const shared = descriptions.get("validate_schema") ?? "";
    expect(shared).toContain("define relation_type");
    expect(shared).toContain("Value<");
    expect(shared).toContain("from:");
    expect(shared).toContain("to:");
    expect(shared).toContain("Preference");
    expect(shared).toContain("properties { }");
    expect(descriptions.get("upload_schema")).toBe(shared);
    expect(descriptions.get("replace_schema")).toContain(shared);
    expect(descriptions.get("replace_schema")).toContain("omits is a removal");
  });

  it("describes get_schema's document response and normal missing-schema state", async () => {
    const tools = await listTools();
    const getSchema = tools.find((tool) => tool.name === "get_schema");
    const description = getSchema?.description ?? "";

    expect(description).toContain("declared schema document and its version");
    expect(description).toContain("list_entity_types");
    expect(description).toContain("no schema has been declared yet");
    expect(description).toContain("normal working state");
    expect(description).toContain("upload_schema");
    expect(description).not.toContain("entity_type_id` comes from here");
  });

  it("documents encode_vector's normalization and fingerprint prerequisites", async () => {
    const tools = await listTools();
    const encode = tools.find((tool) => tool.name === "encode_vector");
    const properties = (encode?.inputSchema.properties ?? {}) as Record<
      string,
      { description?: string }
    >;
    expect(properties.vector?.description).toContain("[0.999000, 1.001000]");
    expect(properties.model_fingerprint?.description).toContain(
      "this surface does not report it",
    );
  });

  it("pins descriptions and bounds for measured wire behavior", async () => {
    const tools = await listTools();
    const property = (toolName: string, fieldName: string) =>
      (
        (tools.find((tool) => tool.name === toolName)?.inputSchema.properties ??
          {}) as Record<string, { description?: string; maximum?: number }>
      )[fieldName];

    expect(property("drop_schema_type", "name").description).toContain("BARE");
    expect(property("drop_schema_type", "name").description).toContain("dropped: false");
    expect(property("subscribe_events", "from_lsn").description).toContain("AT this");
    expect(property("subscribe_events", "from_lsn").description).not.toContain(
      "Resume after",
    );
    expect(property("graph", "limit").description).not.toContain("Page size");
    expect(property("traverse_entity", "include_superseded").description).toContain(
      "at most one path per target",
    );
    expect(property("recall", "include_trace").description).toContain('scope: "space"');
    expect(property("encode_vector", "kind").maximum).toBe(1);
    expect(property("encode_vector", "kind").description).toContain(
      "cannot be written here",
    );
    expect(property("materialize_directives", "top_k").maximum).toBe(100);
    expect(property("materialize_directives", "top_k").description).toContain("1 to 100");
    expect(property("create_statement", "event_at_unix_nanos").description).toContain(
      "Only set this when `kind` is `event`",
    );
    expect(property("supersede_statement", "event_at_unix_nanos").description).toContain(
      "Only set this when `kind` is `event`",
    );

    const listMemories =
      property("list_memories", "include_tombstoned").description ?? "";
    expect(listMemories).toContain("Does not reveal memories removed by `forget`");
    expect(property("forget", "hard").description).toContain(
      "Either mode removes the memory from every read path",
    );
  });
});

let backend: Server;
let backendUrl: string;
const requests: string[] = [];

beforeAll(async () => {
  backend = createServer((req, res) => {
    requests.push(req.url ?? "");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const address = backend.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  backendUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => backend.close(() => resolve()));
});

async function callRead(
  name: "get_statement" | "get_relation",
  args: Record<string, unknown>,
) {
  const config: Config = { backendUrl, requestTimeoutMs: 5000 } as Config;
  const server = buildServer(new BrainBackend(config, "test-key"), {
    readsLocalEnvironment: true,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  const result = await client.callTool({ name, arguments: args });
  await client.close();
  expect(result.isError).toBeFalsy();
}

function followSupersessionAt(index: number): string | null {
  return new URL(requests[index] ?? "", backendUrl).searchParams.get(
    "follow_supersession",
  );
}

describe("supersession defaults reach the backend", () => {
  it("forwards true when omitted and false when explicitly requested", async () => {
    requests.length = 0;
    await callRead("get_statement", { statement_id: "s-1" });
    await callRead("get_statement", { statement_id: "s-1", follow_supersession: false });
    await callRead("get_relation", { relation_id: "r-1" });
    await callRead("get_relation", { relation_id: "r-1", follow_supersession: false });

    expect(followSupersessionAt(0)).toBe("true");
    expect(followSupersessionAt(1)).toBe("false");
    expect(followSupersessionAt(2)).toBe("true");
    expect(followSupersessionAt(3)).toBe("false");
  });
});
