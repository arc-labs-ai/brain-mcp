import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { BrainBackend } from "../../src/backend/index.js";
import type { Config } from "../../src/config/index.js";
import { buildServer } from "../../src/server/index.js";

const testConfig: Config = {
  backendUrl: "http://127.0.0.1:9",
  port: 0,
  host: "127.0.0.1",
  requestTimeoutMs: 1000,
};

/** The tool list is served from the registrations; no backend is reached. */
async function listTools() {
  const server = buildServer(new BrainBackend(testConfig, "test-key"), {
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

/**
 * What every tool promises a model, checked against the live server.
 *
 * A client hands the model ALL of these descriptions on every turn — that is
 * what the surface costs. So the descriptions are not documentation sitting
 * beside the product; they ARE the interface the model reasons over, and an
 * ambiguous one is a wrong tool call rather than a missing docs page.
 *
 * Annotations are the other half. `readOnlyHint` tells a model which tools are
 * safe to call just to find out; `destructiveHint` tells it which remove
 * something a person would miss. Without them every tool looks equally risky,
 * and a model that cannot tell `recall` from `retract_statement` by anything
 * but the name will be cautious about both or careless about both.
 */
describe("the tool contract", () => {
  it("annotates every tool", async () => {
    const tools = await listTools();

    const unannotated = tools
      .filter((t) => t.annotations?.readOnlyHint === undefined)
      .map((t) => t.name);
    expect(unannotated, "tools with no readOnlyHint").toEqual([]);

    for (const tool of tools) {
      const a = tool.annotations ?? {};
      expect(typeof a.readOnlyHint, tool.name).toBe("boolean");
      expect(typeof a.destructiveHint, tool.name).toBe("boolean");
      expect(typeof a.idempotentHint, tool.name).toBe("boolean");
      // A read cannot also destroy. Getting this pair wrong is worse than
      // omitting both: it tells a model a removal is safe to try.
      if (a.readOnlyHint === true) {
        expect(a.destructiveHint, `${tool.name} is read-only AND destructive`).toBe(
          false,
        );
      }
    }
  });

  it("gives every tool a description a model can act on", async () => {
    const tools = await listTools();

    for (const tool of tools) {
      const text = tool.description ?? "";
      expect(text.length, `${tool.name} has no description`).toBeGreaterThan(40);
      // Long enough to disambiguate, short enough that 49 of them fit.
      expect(text.length, `${tool.name}'s description is very long`).toBeLessThan(900);
    }
  });

  /**
   * The clusters a model actually confuses. Each of these is a pair that reads
   * alike and does something different, and the only thing standing between
   * them is whether the description says so.
   */
  it("disambiguates the tools that read alike", async () => {
    const tools = await listTools();

    const describedAs = new Map(tools.map((t) => [t.name, t.description ?? ""]));
    const mustMention: Array<[string, string]> = [
      // Browsing is not asking.
      ["list_memories", "recall"],
      ["recall", "list_memories"],
      // Correcting is not deleting — the most costly confusion here.
      ["forget", "remember"],
      ["delete_statement", "supersede_statement"],
      ["retract_statement", "supersede_statement"],
      // Replacing wholesale is not renaming.
      ["update_entity", "rename_entity"],
      ["rename_entity", "update_entity"],
      // Creating something that exists is an error.
      ["create_entity", "resolve_entity"],
      // One executes, the other does not.
      ["explain_query", "trace_query"],
      ["trace_query", "explain_query"],
    ];

    for (const [tool, neighbour] of mustMention) {
      expect(
        describedAs.get(tool),
        `${tool} must name ${neighbour}, or a model has no way to tell them apart`,
      ).toContain(neighbour);
    }
  });

  /** A destructive tool should say so in words, not only in a hint. */
  it("says in the text when something is destroyed", async () => {
    const tools = await listTools();

    for (const tool of tools) {
      if (tool.annotations?.destructiveHint !== true) continue;
      const text = (tool.description ?? "").toLowerCase();
      expect(
        // The vocabulary of removal, as these descriptions actually use it.
        // `eras` covers erase/erases/erased; `retire` on its own is too soft
        // to count, which is why `delete_session` has to say "erases" as well.
        /delete|remove|destroy|eras|retract|tombstone|drop|fold|replace|discard/.test(
          text,
        ),
        `${tool.name} is marked destructive but its description does not say so`,
      ).toBe(true);
    }
  });
});
