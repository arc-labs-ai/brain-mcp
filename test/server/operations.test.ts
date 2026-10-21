/**
 * Every tool, on both paths.
 *
 * A tool that works when the backend answers 200 and throws when it answers
 * 500 is a broken tool: the MCP transport turns a thrown error into a protocol
 * failure, and the agent sees a dead connection rather than something it can
 * read and act on. The contract is that EVERY tool renders a backend failure
 * as `isError: true` with a message in it.
 *
 * So each tool is driven twice against a switchable backend — once answering
 * 200, once 500 — and the table is the full tool list, so a tool added without
 * error handling fails here rather than in front of an agent.
 */

import { type Server, createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrainBackend } from "../../src/backend/index.js";
import type { Config } from "../../src/config/index.js";
import { buildServer } from "../../src/server/index.js";

/** Flipped per-test to make the same backend succeed or fail. */
let mode: "ok" | "fail" = "ok";
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    if (mode === "fail") {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "backend exploded" }));
      return;
    }
    res.end(
      JSON.stringify({ ok: true, memory_id: "42", answer_kind: "none", memories: [] }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function connectedClient(): Promise<Client> {
  const cfg: Config = {
    backendUrl: baseUrl,
    apiKey: "brain_test_key",
    namespace: "acme",
    namespaceHeader: "x-brain-namespace",
    scopeHeader: "x-brain-customer",
    requestTimeoutMs: 5000,
  } as Config;
  const mcp = buildServer(new BrainBackend(cfg));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  return client;
}

const C = { customer_id: "cust-1" };

/** Minimal valid arguments for every registered tool. */
const CALLS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ["remember", { ...C, content: "Ada likes dark roast" }],
  ["recall", { ...C, query: "what does Ada like?" }],
  ["forget", { ...C, memory_id: "m-1" }],
  ["list_memories", { ...C }],
  ["inspect_memory", { ...C, memory_id: "m-1" }],
  ["plan", { ...C, start: "here", goal: "there" }],
  ["reason", { ...C, observation: "the invoice bounced" }],
  ["link", { ...C, source: "m-1", target: "m-2", kind: "caused" }],
  ["unlink", { ...C, source: "m-1", target: "m-2", kind: "caused" }],
  ["graph", { ...C }],
  ["create_entity", { ...C, entity_type_id: 1, canonical_name: "Acme" }],
  ["list_entities", { ...C, entity_type_id: 1 }],
  ["resolve_entity", { ...C, candidate_name: "the Acme account" }],
  ["get_entity", { ...C, entity_id: "e-1" }],
  ["traverse_entity", { ...C, entity_id: "e-1" }],
  ["entity_relations", { ...C, entity_id: "e-1" }],
  ["list_statements", { ...C }],
  ["get_statement", { ...C, statement_id: "s-1" }],
  ["get_relation", { ...C, relation_id: "r-1" }],
  ["get_schema", { ...C }],
  ["validate_schema", { ...C, schema_document: "entity P {}" }],
  ["upload_schema", { ...C, schema_document: "entity P {}" }],
  ["whoami", { ...C }],
  ["capabilities", { ...C }],
  ["llm_credential_status", { ...C }],
];

describe("brain-mcp every operation", () => {
  it("the table covers every registered tool", async () => {
    // Guards the two tests below from silently skipping a new tool.
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const registered = tools.map((t) => t.name).sort();
    const covered = CALLS.map(([n]) => n).sort();
    expect(covered).toEqual(registered);
    await client.close();
  });

  it("every tool succeeds against a healthy backend", async () => {
    mode = "ok";
    const client = await connectedClient();
    for (const [name, args] of CALLS) {
      const res = await client.callTool({ name, arguments: args });
      expect(res.isError, `${name} should succeed`).toBeFalsy();
      const content = res.content as Array<{ type: string; text?: string }>;
      expect(content.length, `${name} returned no content`).toBeGreaterThan(0);
      expect(content[0]?.type).toBe("text");
    }
    await client.close();
  });

  it("every tool renders a backend failure instead of throwing", async () => {
    mode = "fail";
    const client = await connectedClient();
    for (const [name, args] of CALLS) {
      // callTool must RESOLVE. A rejection here means the tool let the error
      // escape and the agent sees a transport fault, not a readable message.
      const res = await client.callTool({ name, arguments: args });
      expect(res.isError, `${name} should report isError on a 500`).toBe(true);
      const text = (res.content as Array<{ text?: string }>)[0]?.text ?? "";
      expect(text, `${name} gave an empty error`).not.toBe("");
      expect(text, `${name} should name the status`).toContain("500");
    }
    await client.close();
    mode = "ok";
  });

  it("rejects a call that omits customer_id, before reaching the backend", async () => {
    mode = "fail"; // would 500 if the call got through
    const client = await connectedClient();
    const res = await client.callTool({ name: "recall", arguments: { query: "x" } });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ text?: string }>)[0]?.text ?? "";
    // Schema validation, not a backend error: the 500 never happened.
    expect(text).not.toContain("500");
    await client.close();
    mode = "ok";
  });
});
