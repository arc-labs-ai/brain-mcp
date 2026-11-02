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

    requestTimeoutMs: timeoutMs,
  } as Config;
  return new BrainBackend(cfg, "brain_test_key");
}

describe("brain-mcp backend failure modes", () => {
  it("a hanging backend becomes a 504, not a hang", async () => {
    // No response is ever written. Without the abort timer the tool call would
    // never resolve and the agent would wait forever with nothing to report.
    const backend = await withBackend(() => {
      /* deliberately never responds */
    }, 300);

    await expect(backend.recall("anything")).rejects.toMatchObject({
      name: "BackendError",
      status: 504,
    });
  });

  it("an unreachable backend becomes a 502, not a raw fetch error", async () => {
    const cfg: Config = {
      backendUrl: "http://127.0.0.1:9", // discard port: refuses immediately

      requestTimeoutMs: 2000,
    } as Config;
    await expect(new BrainBackend(cfg, "k").whoami()).rejects.toMatchObject({
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
    await expect(backend.getSchema()).rejects.toThrow();
  });

  it("an empty 2xx body is an empty object, not undefined", async () => {
    // DELETE commonly answers 204. Returning `undefined` here would surface to
    // the agent as `null` with no explanation.
    const backend = await withBackend((_req, res) => {
      res.statusCode = 204;
      res.end();
    });
    await expect(backend.forget("m-1", false)).resolves.toEqual({});
  });

  it("whoami surfaces a failure rather than synthesising an identity", async () => {
    // There used to be a 404 fallback that reported the locally-configured
    // scope. With per-caller credentials there is no local scope to report,
    // and whoami is precisely the call a user makes to check WHICH identity
    // they are connected as — the one answer that must never be invented.
    const notFound = await withBackend((_req, res) => {
      res.statusCode = 404;
      res.end("{}");
    });
    await expect(notFound.whoami()).rejects.toMatchObject({ status: 404 });
    await new Promise<void>((resolve) => server?.close(() => resolve()));

    const broken = await withBackend((_req, res) => {
      res.statusCode = 500;
      res.end("{}");
    });
    await expect(broken.whoami()).rejects.toMatchObject({ status: 500 });
  });

  it("a BackendError carries the status and a truncated body", async () => {
    const backend = await withBackend((_req, res) => {
      res.statusCode = 422;
      res.end(JSON.stringify({ code: "validation.failed", detail: "x".repeat(2000) }));
    });
    await expect(backend.remember("text")).rejects.toSatisfy((e: unknown) => {
      if (!(e instanceof BackendError)) return false;
      // Bounded, so a huge body cannot flood the agent's context.
      return e.status === 422 && e.message.length < 700;
    });
  });
});
