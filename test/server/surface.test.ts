import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { BackendError, BrainBackend } from "../../src/backend/index.js";
import type { Config } from "../../src/config/index.js";
import { buildServer } from "../../src/server/index.js";

const testConfig: Config = {
  backendUrl: "http://127.0.0.1:9",
  apiKey: "test-key",
  namespace: "test",
  namespaceHeader: "x-brain-namespace",
  scopeHeader: "x-brain-space",
  port: 0,
  host: "127.0.0.1",
  requestTimeoutMs: 1000,
};

async function connectedClient(): Promise<Client> {
  const backend = new BrainBackend(testConfig);
  const server = buildServer(backend);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  return client;
}

describe("brain-mcp server", () => {
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
        "entity_relations",
        "forget",
        "get_entity",
        "get_relation",
        "get_schema",
        "get_statement",
        "graph",
        "inspect_memory",
        "link",
        "list_entities",
        "list_memories",
        "list_statements",
        "llm_credential_status",
        "plan",
        "reason",
        "recall",
        "remember",
        "resolve_entity",
        "traverse_entity",
        "unlink",
        "upload_schema",
        "validate_schema",
        "whoami",
      ].sort(),
    );
    await client.close();
  });

  /**
   * The security boundary, asserted rather than trusted to a comment.
   *
   * Three backend operations are deliberately not tools: writing a provider
   * key (a tool taking secrets is a prompt-injection target), deleting one
   * (stops every write in the workspace), and replacing a schema with
   * `force_drop_existing` (discards declarations and the rows bound to them).
   *
   * The risk is that someone adds one later for convenience — plumbing exists
   * on `BrainBackend`, so it is a three-line change. This test makes that a
   * deliberate act.
   */
  it("does not expose credential writes or destructive schema replace", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));

    for (const forbidden of [
      "put_llm_credential",
      "set_llm_credential",
      "delete_llm_credential",
      "replace_schema",
      "drop_schema",
    ]) {
      expect(names.has(forbidden)).toBe(false);
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

  it("declares the customer_id input on every tool", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const props = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
      expect(Object.keys(props)).toContain("customer_id");
    }
    await client.close();
  });

  it("surfaces a backend failure as an isError result, not a throw", async () => {
    // backendUrl points at a closed port, so remember() fails fast — the tool
    // must return isError content rather than crashing the server.
    const client = await connectedClient();
    const res = await client.callTool({
      name: "recall",
      arguments: { customer_id: "c1", query: "anything" },
    });
    expect(res.isError).toBe(true);
    await client.close();
  });
});
