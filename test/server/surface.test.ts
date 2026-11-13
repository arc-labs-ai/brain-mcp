import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { BackendError, BrainBackend } from "../../src/backend/index.js";
import type { Config } from "../../src/config/index.js";
import { buildServer } from "../../src/server/index.js";

const testConfig: Config = {
  backendUrl: "http://127.0.0.1:9",
  port: 0,
  host: "127.0.0.1",
  requestTimeoutMs: 1000,
};

async function connectedClient(): Promise<Client> {
  const backend = new BrainBackend(testConfig, "test-key");
  const server = buildServer(backend, { readsLocalEnvironment: true });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  return client;
}

describe("brain-mcp server", () => {
  /**
   * `serverInfo.version` is what a client reports as the server it is talking
   * to, and it is hand-written in src/server/index.ts because the published
   * layout puts package.json outside dist/. It silently drifted once already:
   * 0.1.1 shipped announcing 0.1.0. release-please stamps it through the
   * `x-release-please-version` annotation; this fails if that ever stops
   * happening, rather than leaving a client to believe the wrong version.
   */
  it("announces the version in package.json", async () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    const client = await connectedClient();
    expect(client.getServerVersion()).toEqual({
      name: "brain-mcp",
      version: pkg.version,
    });
    await client.close();
  });

  /**
   * The surface is stated, not counted. A route added to the edge without a
   * tool here, or a tool added without being considered, shows up as a diff on
   * this list rather than passing silently.
   */
  it("exposes the whole tenant surface, named explicitly", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "capabilities",
        "create_entity",
        "create_relation",
        "create_session",
        "create_space",
        "create_statement",
        "delete_entity",
        "delete_llm_credential",
        "delete_relation",
        "delete_session",
        "delete_statement",
        "drop_schema_type",
        "encode_vector",
        "entity_relations",
        "explain_query",
        "forget",
        "get_entity",
        "get_relation",
        "get_schema",
        "get_statement",
        "graph",
        "inspect_memory",
        "link",
        "list_entities",
        "list_entity_types",
        "list_extractors",
        "list_memories",
        "list_schema_versions",
        "list_sessions",
        "list_spaces",
        "list_statements",
        "llm_credential_status",
        "materialize_directives",
        "merge_entities",
        "plan",
        "put_llm_credential",
        "reason",
        "recall",
        "remember",
        "rename_entity",
        "replace_schema",
        "resolve_entity",
        "retract_statement",
        "statement_history",
        "subscribe_events",
        "supersede_relation",
        "supersede_statement",
        "test_llm_credential",
        "trace_query",
        "traverse_entity",
        "unlink",
        "unmerge_entity",
        "update_entity",
        "upload_schema",
        "validate_schema",
        "verify_llm_credential",
        "whoami",
      ].sort(),
    );
    await client.close();
  });

  /**
   * The security boundary, asserted rather than trusted to a comment.
   *
   * The line is not "is it a write". Entity merges, statement supersessions
   * and `drop_schema_type` are all writes and all tools, because each is
   * recoverable, scoped to one record, or both. What matters is whether a
   * confused or steered agent could leak a secret or lose something
   * unrecoverably — so the checks below are on those two properties, not on
   * a list of endpoint names.
   *
   * The risk is that someone relaxes one later for convenience. These make
   * that a deliberate act rather than a three-line one.
   */
  it("no tool anywhere accepts a raw provider key", async () => {
    // The invariant that makes the key tools safe to expose at all: they
    // take an environment variable's NAME, and the handler reads it. A live
    // key passed as an argument is written into the model's context and into
    // every transcript and log of the session, and it stays valid there.
    //
    // Checked across EVERY tool rather than the three credential ones,
    // because the next tool to want a key is the one nobody thinks to check.
    const client = await connectedClient();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const props = Object.keys(
        (tool.inputSchema.properties ?? {}) as Record<string, unknown>,
      );
      for (const banned of ["api_key", "provider_key", "secret", "token"]) {
        expect(props, `${tool.name} must not take a raw ${banned}`).not.toContain(banned);
      }
    }
    await client.close();
  });

  /**
   * `DELETE /v1/spaces` takes no path parameter — every space verb acts on
   * the caller's OWN space — so it is "erase this workspace" from a single
   * call, with no id that could fail to match and nothing to undo.
   * `create_space` is a tool; this one stays out.
   */
  it("does not expose space deletion", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    for (const forbidden of ["delete_space", "erase_space", "drop_space"]) {
      expect(names.has(forbidden), `${forbidden} must not be a tool`).toBe(false);
    }
    await client.close();
  });

  /**
   * The key tools read an env var out of THIS process. Over HTTP that
   * process belongs to whoever runs the deployment, not to the caller, so
   * the same argument would read an operator's secret on a caller's behalf.
   * They are registered on stdio only, and this keeps it that way.
   */
  it("withholds the key tools when the environment is not the caller's", async () => {
    const server = buildServer(new BrainBackend(testConfig, "test-key"), {
      readsLocalEnvironment: false,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    for (const gated of [
      "put_llm_credential",
      "test_llm_credential",
      "delete_llm_credential",
    ]) {
      expect(names.has(gated), `${gated} must be stdio-only`).toBe(false);
    }
    // The gate is on the key tools, not on the surface as a whole.
    expect(names.has("remember")).toBe(true);
    expect(names.has("llm_credential_status")).toBe(true);
    await client.close();
  });

  /**
   * `replace_schema` can drop declarations and the rows bound to them, so
   * the destructive choice must be made explicitly rather than by leaving a
   * field out. `force_drop_existing` is REQUIRED and has no default.
   */
  it("makes the destructive schema choice explicit", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const replace = tools.find((t) => t.name === "replace_schema");
    expect(replace, "replace_schema should be registered").toBeDefined();
    const required = ((replace as { inputSchema: { required?: string[] } }).inputSchema
      .required ?? []) as string[];
    expect(required).toContain("force_drop_existing");
    await client.close();
  });

  it("declares no customer_id input on any tool", async () => {
    // The identity is the caller's credential, resolved server-side. A
    // customer_id argument would be a scoping knob the agent can set and the
    // backend ignores — which reads as isolation and is not, and invites the
    // model to invent a value when it has none.
    const client = await connectedClient();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const props = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
      expect(Object.keys(props), `${tool.name} still takes customer_id`).not.toContain(
        "customer_id",
      );
    }
    await client.close();
  });

  /**
   * The README's tool tables are what an operator reads before wiring this up,
   * and what a model may be shown instead of the schemas. A tool added without
   * a row is undocumented; a row left behind describes something that is gone.
   * Neither is visible from the code, so it is asserted here.
   */
  it("documents every registered tool in the README, and nothing it does not have", async () => {
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    // Table rows look like:  | `tool_name` | args | what it does |
    const documented = new Set(
      [...readme.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1] as string),
    );
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const registered = new Set(tools.map((t) => t.name));

    const undocumented = [...registered].filter((n) => !documented.has(n)).sort();
    expect(undocumented, "tools with no README row").toEqual([]);

    const stale = [...documented].filter((n) => !registered.has(n)).sort();
    expect(stale, "README rows for tools that do not exist").toEqual([]);
    await client.close();
  });

  /**
   * The npm page's description is the first thing most people read, and it is
   * the one claim about this surface that nothing checked. It said "25 MCP
   * tools" while 49 were registered — stale since the commit that widened the
   * surface to the whole tenant API, and published that way. The README's
   * count is right because the test above keeps it right; this does the same
   * for the text npm actually shows.
   */
  it("states the registered tool count in the package description", async () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { description: string };
    const client = await connectedClient();
    const { tools } = await client.listTools();
    await client.close();

    const claimed = /(\d+) MCP tools/.exec(pkg.description);
    expect(
      claimed,
      "package.json description must state an 'N MCP tools' count",
    ).not.toBeNull();
    expect(
      Number((claimed as RegExpExecArray)[1]),
      "package.json description disagrees with the registered tool count",
    ).toBe(tools.length);
  });

  it("surfaces a backend failure as an isError result, not a throw", async () => {
    // backendUrl points at a closed port, so remember() fails fast — the tool
    // must return isError content rather than crashing the server.
    const client = await connectedClient();
    const res = await client.callTool({
      name: "recall",
      arguments: { query: "anything" },
    });
    expect(res.isError).toBe(true);
    await client.close();
  });
});
