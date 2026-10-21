import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { BrainBackend } from "../src/backend.js";
import type { Config } from "../src/config.js";
import { buildServer } from "../src/server.js";

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
  it("exposes exactly the four core tools", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["forget", "recall", "remember", "whoami"]);
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
