/**
 * Where the credential is allowed to come from, per transport.
 *
 * The rule these tests pin down: stdio reads the environment (the client owns
 * the process and holds the key), HTTP does not (every request brings its
 * own). The asymmetry is the whole security model, so it is asserted rather
 * than left to the reader of `loadConfig`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config/index.js";

const TOUCHED = [
  "BRAIN_MCP_BACKEND_URL",
  "BRAIN_MCP_API_KEY",
  "BRAIN_MCP_OAUTH_ENABLED",
  "BRAIN_MCP_PORT",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
  for (const k of TOUCHED) delete process.env[k];
  process.env.BRAIN_MCP_BACKEND_URL = "https://api.example/";
});

afterEach(() => {
  for (const k of TOUCHED) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("credential source", () => {
  it("HTTP mode needs no credential at all", () => {
    const cfg = loadConfig(false);
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.backendUrl).toBe("https://api.example"); // trailing slash stripped
  });

  it("HTTP mode ignores BRAIN_MCP_API_KEY even when it is set", () => {
    process.env.BRAIN_MCP_API_KEY = "brain_should_be_ignored";
    expect(loadConfig(false).apiKey).toBeUndefined();
  });

  it("stdio mode requires BRAIN_MCP_API_KEY", () => {
    expect(() => loadConfig(true)).toThrow(ConfigError);
  });

  it("stdio mode takes the credential from the environment", () => {
    process.env.BRAIN_MCP_API_KEY = "brain_local";
    expect(loadConfig(true).apiKey).toBe("brain_local");
  });

  it("refuses to start when the removed OAuth mode is still configured", () => {
    // A deployment that sets this believes it is isolating tenants. It was
    // not: the namespace claim it selected is ignored by the gateway for key
    // callers, so every tenant landed in the service key's own workspace.
    // Failing at startup is the only way that belief gets corrected here
    // rather than by a tenant seeing someone else's memories.
    process.env.BRAIN_MCP_OAUTH_ENABLED = "true";
    expect(() => loadConfig(false)).toThrow(/no longer has an OAuth mode/);
  });
});
