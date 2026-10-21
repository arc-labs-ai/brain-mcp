/**
 * What the client does when the backend misbehaves at the transport level —
 * as opposed to answering cleanly with an error status.
 *
 * These are the cases that produce confusing agent behaviour if handled
 * loosely: a hang that never resolves, a body that is not JSON, a 204 with no
 * body at all. Each should become a `BackendError` the tool layer can render,
 * never an unhandled throw and never a silent `undefined`.
 */

import { type Server, createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { BackendError, BrainBackend } from "../../src/backend/index.js";
import type { Config } from "../../src/config/index.js";

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

/** Start a server with the given handler and return a backend pointed at it. */
async function withBackend(
  handler: Parameters<typeof createServer>[1],
  timeoutMs = 5000,
): Promise<BrainBackend> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const addr = server?.address();
  if (addr === null || addr === undefined || typeof addr === "string")
    throw new Error("no port");
  const cfg: Config = {
    backendUrl: `http://127.0.0.1:${addr.port}`,
    apiKey: "brain_test_key",
    namespace: "acme",
    namespaceHeader: "x-brain-namespace",
    scopeHeader: "x-brain-customer",
    requestTimeoutMs: timeoutMs,
  } as Config;
  return new BrainBackend(cfg);
}

describe("brain-mcp backend failure modes", () => {
  it("a hanging backend becomes a 504, not a hang", async () => {
    // No response is ever written. Without the abort timer the tool call would
    // never resolve and the agent would wait forever with nothing to report.
    const backend = await withBackend(() => {
      /* deliberately never responds */
    }, 300);

    await expect(backend.recall("cust-1", "anything")).rejects.toMatchObject({
      name: "BackendError",
      status: 504,
    });
  });

  it("an unreachable backend becomes a 502, not a raw fetch error", async () => {
    const cfg: Config = {
      backendUrl: "http://127.0.0.1:9", // discard port: refuses immediately
      apiKey: "k",
      namespace: "acme",
      namespaceHeader: "x-brain-namespace",
      scopeHeader: "x-brain-customer",
      requestTimeoutMs: 2000,
    } as Config;
    await expect(new BrainBackend(cfg).whoami("cust-1")).rejects.toMatchObject({
      name: "BackendError",
      status: 502,
    });
  });

  it("a 2xx with a non-JSON body surfaces rather than corrupting the result", async () => {
    // An HTML error page from a proxy in front of the backend is the real
    // shape of this. Parsing it must not yield a half-populated object.
    const backend = await withBackend((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end("<html>503 from the load balancer</html>");
    });
    await expect(backend.getSchema("cust-1")).rejects.toThrow();
  });

  it("an empty 2xx body is an empty object, not undefined", async () => {
    // DELETE commonly answers 204. Returning `undefined` here would surface to
    // the agent as `null` with no explanation.
    const backend = await withBackend((_req, res) => {
      res.statusCode = 204;
      res.end();
    });
    await expect(backend.forget("cust-1", "m-1", false)).resolves.toEqual({});
  });

  it("whoami falls back to configured scope on 404, but not on 500", async () => {
    // The fallback exists because not every backend serves /v1/whoami. It must
    // be narrow: a 500 is a real failure and must not be papered over with a
    // confident-looking identity.
    const notFound = await withBackend((_req, res) => {
      res.statusCode = 404;
      res.end("{}");
    });
    const fallback = await notFound.whoami("cust-1");
    expect(fallback.namespace).toBe("acme");
    expect(String(fallback.note)).toContain("no /v1/whoami");
    await new Promise<void>((resolve) => server?.close(() => resolve()));

    const broken = await withBackend((_req, res) => {
      res.statusCode = 500;
      res.end("{}");
    });
    await expect(broken.whoami("cust-1")).rejects.toMatchObject({ status: 500 });
  });

  it("a BackendError carries the status and a truncated body", async () => {
    const backend = await withBackend((_req, res) => {
      res.statusCode = 422;
      res.end(JSON.stringify({ code: "validation.failed", detail: "x".repeat(2000) }));
    });
    await expect(backend.remember("cust-1", "text")).rejects.toSatisfy((e: unknown) => {
      if (!(e instanceof BackendError)) return false;
      // Bounded, so a huge body cannot flood the agent's context.
      return e.status === 422 && e.message.length < 700;
    });
  });
});
