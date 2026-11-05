/**
 * The installer edits files it did not write and does not own.
 *
 * A client's `mcp.json` holds other people's servers, and for Cursor and
 * Claude Desktop it is the only copy. So the properties worth pinning are not
 * "does the entry appear" but everything AROUND the entry: what survives, what
 * is refused, and what the permissions end up as once a credential is in the
 * file.
 */

import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ClientTarget, ServerSpec } from "../../src/install/clients.js";
import { install } from "../../src/install/write.js";

const spec: ServerSpec = {
  name: "brain",
  command: "npx",
  args: ["-y", "@brain-db/mcp", "--stdio"],
  env: { BRAIN_MCP_BACKEND_URL: "https://api.example", BRAIN_MCP_API_KEY: "brain_k" },
};

function targetIn(dir: string, file = "mcp.json"): ClientTarget {
  return {
    id: "test",
    label: "Test",
    writer: { kind: "json", path: join(dir, file) },
    evidence: [],
    docs: "https://example.invalid",
  };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "brain-mcp-install-"));
}

describe("json client config", () => {
  it("creates the file and the directory when neither exists", () => {
    const t = targetIn(join(tmp(), "nested", "deeper"));
    const out = install(t, spec, false);
    expect(out.status).toBe("written");
    const doc = JSON.parse(readFileSync((t.writer as { path: string }).path, "utf8"));
    expect(doc.mcpServers.brain.args).toEqual(["-y", "@brain-db/mcp", "--stdio"]);
  });

  it("keeps every other server and every other top-level key", () => {
    const dir = tmp();
    const path = join(dir, "mcp.json");
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: { postgres: { command: "pg-mcp", args: [] } },
        theme: "dark",
      }),
    );
    install(targetIn(dir), spec, false);
    const doc = JSON.parse(readFileSync(path, "utf8"));
    expect(doc.mcpServers.postgres).toEqual({ command: "pg-mcp", args: [] });
    expect(doc.theme).toBe("dark");
    expect(doc.mcpServers.brain).toBeDefined();
  });

  it("refuses a file it cannot parse instead of replacing it", () => {
    const dir = tmp();
    const path = join(dir, "mcp.json");
    const original = '{ "mcpServers": { "a": {} },, }';
    writeFileSync(path, original);
    const out = install(targetIn(dir), spec, false);
    expect(out.status).toBe("failed");
    // The point of refusing: the half-edited file is still there.
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("leaves a backup of what it replaced", () => {
    const dir = tmp();
    const path = join(dir, "mcp.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { a: { command: "x" } } }));
    install(targetIn(dir), spec, false);
    const backup = JSON.parse(readFileSync(`${path}.brain-backup`, "utf8"));
    expect(backup.mcpServers.brain).toBeUndefined();
    expect(backup.mcpServers.a).toEqual({ command: "x" });
  });

  it("narrows the permissions of an existing world-readable file", () => {
    const dir = tmp();
    const path = join(dir, "mcp.json");
    writeFileSync(path, "{}");
    chmodSync(path, 0o644);
    install(targetIn(dir), spec, false);
    // The file now holds an API key. `writeFileSync`'s mode applies only on
    // create, so without the explicit chmod this stays 644.
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("writes nothing on a dry run, but still reports what it would do", () => {
    const dir = tmp();
    const path = join(dir, "mcp.json");
    const out = install(targetIn(dir), spec, true);
    expect(out.status).toBe("written");
    expect(out.detail).toContain("create");
    expect(() => readFileSync(path, "utf8")).toThrow();
  });

  it("rehearses the parse failure too, so --dry-run is a real rehearsal", () => {
    const dir = tmp();
    writeFileSync(join(dir, "mcp.json"), "not json at all");
    expect(install(targetIn(dir), spec, true).status).toBe("failed");
  });

  it("replaces its own entry on a re-run rather than duplicating it", () => {
    const dir = tmp();
    const path = join(dir, "mcp.json");
    install(targetIn(dir), spec, false);
    install(
      targetIn(dir),
      { ...spec, env: { ...spec.env, BRAIN_MCP_API_KEY: "brain_new" } },
      false,
    );
    const doc = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys(doc.mcpServers)).toEqual(["brain"]);
    expect(doc.mcpServers.brain.env.BRAIN_MCP_API_KEY).toBe("brain_new");
  });
});
