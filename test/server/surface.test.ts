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
  const server = buildServer(backend);
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
        "create_statement",
        "delete_entity",
        "delete_relation",
        "delete_session",
        "delete_statement",
        "drop_schema_type",
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
        "reason",
        "recall",
        "remember",
        "rename_entity",
        "resolve_entity",
        "retract_statement",
        "statement_history",
        "supersede_relation",
        "supersede_statement",
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
   * recoverable, scoped to one record, or both. What stays out is the handful
   * that a confused or steered agent could use to leak a secret or lose
   * something unrecoverably:
   *
   *   - writing or testing a provider key — both take a RAW key in the body,
   *     and a secret in a tool call lands in transcripts and logs. Deleting
   *     one stops every write in the workspace. `verify_llm_credential`
   *     re-probes the stored key and carries nothing, so it IS a tool.
   *   - replacing the whole schema document, which discards declarations and
   *     the rows bound to them. `drop_schema_type` removes exactly one named
   *     declaration and is a different operation, not a smaller dose.
   *   - creating or deleting a space. No space verb takes a path parameter —
   *     all three act on the caller's own space — so a delete is "erase this
   *     workspace" with no id to get wrong.
   *
   * The risk is that someone adds one later for convenience. This test makes
   * that a deliberate act rather than a three-line one.
   */
  it("does not expose credential writes, schema replace, or space deletion", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));

    for (const forbidden of [
      "put_llm_credential",
      "set_llm_credential",
      "delete_llm_credential",
      "test_llm_credential",
      "replace_schema",
      "create_space",
      "delete_space",
      "encode_vector",
      "subscribe",
    ]) {
      expect(names.has(forbidden), `${forbidden} must not be a tool`).toBe(false);
    }

    // And nothing may accept a raw provider key, whatever it is called.
    for (const tool of tools) {
      const props = Object.keys(
        (tool.inputSchema.properties ?? {}) as Record<string, unknown>,
      );
      expect(props).not.toContain("api_key");
      expect(props).not.toContain("provider_key");
    }
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
