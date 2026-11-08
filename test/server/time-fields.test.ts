/**
 * The bi-temporal fields, and the cap that made every one of them useless.
 *
 * `event_at_unix_nanos`, `valid_from_unix_nanos` and `valid_to_unix_nanos`
 * were declared `z.number().int()`. In zod 4 that means a SAFE integer, so the
 * emitted JSON Schema carried `maximum: 9007199254740991` and the validator
 * enforced it. 2^53-1 nanoseconds after the epoch is **15 April 1970**, which
 * means every date anyone would ever pass was 100-200x over the limit:
 *
 *     Too big: expected int to be <=9007199254740991 at valid_from_unix_nanos
 *
 * Nothing caught it, because every test that exercised these tools omitted the
 * optional time fields. The tools worked perfectly for callers who did not use
 * the feature they exist for.
 *
 * So these tests pass REAL dates. A test that only checks `0` and `1000` would
 * have passed against the broken schema too.
 */

import { type Server, createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrainBackend } from "../../src/backend/index.js";
import type { Config } from "../../src/config/index.js";
import { buildServer } from "../../src/server/index.js";

let server: Server;
let baseUrl: string;
/** The body the backend last received, so the wire value can be asserted. */
let lastBody: Record<string, unknown> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        lastBody = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        lastBody = {};
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, relation_id: "r-1", statement_id: "s-1" }));
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

async function client(): Promise<Client> {
  const cfg: Config = { backendUrl: baseUrl, requestTimeoutMs: 5000 } as Config;
  const mcp = buildServer(new BrainBackend(cfg, "brain_test_key"));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  const c = new Client({ name: "test", version: "0" });
  await c.connect(clientTransport);
  return c;
}

/** 1 March 2026, 00:00 UTC — 197x the old cap. */
const MARCH_2026_NANOS = 1_772_323_200_000_000_000;
const MARCH_2026_ISO = "2026-03-01T00:00:00Z";

const RELATION = {
  relation_type: "acme:works_at",
  from_entity: "11111111-1111-1111-1111-111111111111",
  to_entity: "22222222-2222-2222-2222-222222222222",
};

const STATEMENT = {
  kind: "fact",
  subject: "11111111-1111-1111-1111-111111111111",
  predicate: "acme:prefers",
  object: { kind: "value", value: { type: "text", value: "dark roast" } },
};

async function call(name: string, args: Record<string, unknown>) {
  const c = await client();
  const res = await c.callTool({ name, arguments: args });
  await c.close();
  const text = (res.content as Array<{ text?: string }>)[0]?.text ?? "";
  return { isError: Boolean(res.isError), text };
}

describe("a real date reaches the backend", () => {
  for (const [field, tool, base] of [
    ["valid_from_unix_nanos", "create_relation", RELATION],
    ["valid_to_unix_nanos", "create_relation", RELATION],
    ["event_at_unix_nanos", "create_statement", STATEMENT],
    ["valid_from_unix_nanos", "create_statement", STATEMENT],
    ["valid_to_unix_nanos", "create_statement", STATEMENT],
  ] as const) {
    it(`${tool}.${field} accepts 1 March 2026 as nanoseconds`, async () => {
      const res = await call(tool, { ...base, [field]: MARCH_2026_NANOS });
      expect(res.isError, res.text).toBe(false);
      expect(lastBody[field]).toBe(MARCH_2026_NANOS);
    });
  }
});

describe("ISO-8601, which is the form a model gets right", () => {
  it("is converted to unix nanoseconds on the wire", async () => {
    const res = await call("create_relation", {
      ...RELATION,
      valid_from_unix_nanos: MARCH_2026_ISO,
    });
    expect(res.isError, res.text).toBe(false);
    expect(lastBody.valid_from_unix_nanos).toBe(MARCH_2026_NANOS);
  });

  it("takes an offset, not only Z", async () => {
    const res = await call("create_statement", {
      ...STATEMENT,
      event_at_unix_nanos: "2026-03-01T05:30:00+05:30",
    });
    expect(res.isError, res.text).toBe(false);
    expect(lastBody.event_at_unix_nanos).toBe(MARCH_2026_NANOS);
  });

  it("refuses something that is neither a date nor a number", async () => {
    const res = await call("create_relation", {
      ...RELATION,
      valid_from_unix_nanos: "last tuesday",
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/ISO-8601/);
  });
});

describe("precision, where a JSON number stops being able to hold the value", () => {
  /**
   * A nanosecond-precise instant above 2^53 has no exact double. Storing it
   * would silently record a DIFFERENT instant, so it is refused — and the
   * message says what to do instead, which is the whole difference between a
   * bug and a constraint.
   */
  it("refuses a value a double would round, and says how to fix it", async () => {
    const res = await call("create_relation", {
      ...RELATION,
      valid_from_unix_nanos: "1772323200123456789",
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/cannot be represented exactly/);
    expect(res.text).toMatch(/milliseconds|ISO-8601/);
  });

  it("accepts the same instant rounded to whole milliseconds", async () => {
    const res = await call("create_relation", {
      ...RELATION,
      valid_from_unix_nanos: "1772323200123000000",
    });
    expect(res.isError, res.text).toBe(false);
    expect(lastBody.valid_from_unix_nanos).toBe(1_772_323_200_123_000_000);
  });

  it("still refuses a negative or fractional number", async () => {
    expect(
      (await call("create_relation", { ...RELATION, valid_from_unix_nanos: -1 })).isError,
    ).toBe(true);
    expect(
      (await call("create_relation", { ...RELATION, valid_from_unix_nanos: 1.5 }))
        .isError,
    ).toBe(true);
  });
});

describe("the schema an agent reads", () => {
  /**
   * The cap was visible in `tools/list` the whole time. A client that honours
   * the schema would have refused the call before it was ever sent, so this
   * asserts on what is published, not only on what the server accepts.
   */
  it("publishes no 2^53 ceiling on a time field", async () => {
    const c = await client();
    const { tools } = await c.listTools();
    await c.close();
    for (const tool of tools) {
      const props = ((tool.inputSchema as { properties?: Record<string, unknown> })
        .properties ?? {}) as Record<string, { maximum?: number }>;
      for (const [name, schema] of Object.entries(props)) {
        if (!name.endsWith("_unix_nanos")) continue;
        expect(
          schema.maximum,
          `${tool.name}.${name} publishes a maximum that excludes every real date`,
        ).toBeUndefined();
      }
    }
  });
});
