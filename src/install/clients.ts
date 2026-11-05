/**
 * Where each MCP client keeps its server list, and how to put one there.
 *
 * Two kinds of client, and the difference is not cosmetic:
 *
 *  - Some ship a CLI that owns the file (`claude mcp add`, `codex mcp add`).
 *    Those get the CLI. It knows the file's real location on this machine and
 *    this version, it merges correctly, and — for Codex — it writes TOML, which
 *    is the difference between this installer having a TOML parser and not.
 *    Hand-writing a file a CLI owns is how you corrupt someone's config.
 *
 *  - The rest read a JSON file with the same `mcpServers` shape. Those get a
 *    read-merge-write that preserves every other server in the file.
 *
 * A client that is not installed is SKIPPED, not configured. Writing a config
 * file for an absent client creates the directory a later install would have
 * created itself, and leaves a credential on disk for a program the user does
 * not run.
 */

import { homedir, platform } from "node:os";
import { join } from "node:path";

/** How a server definition reaches the client. */
export type Writer =
  | { kind: "json"; path: string }
  | { kind: "cli"; bin: string; args: (s: ServerSpec) => string[] };

/** What to register, independent of where it is going. */
export interface ServerSpec {
  /** The name the server appears under in the client. */
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ClientTarget {
  /** Stable id used by `--client`. */
  id: string;
  /** What the user calls it. */
  label: string;
  writer: Writer;
  /**
   * Paths whose existence means this client is installed. A CLI client is
   * detected by its binary being on PATH instead; see `detect()`.
   */
  evidence: string[];
  /** Docs for the config this client reads, for the manual fallback. */
  docs: string;
}

function appSupport(): string {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Application Support");
    case "win32":
      return process.env.APPDATA ?? join(home, "AppData", "Roaming");
    default:
      return process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  }
}

/**
 * The clients this installer can configure.
 *
 * Ordered by how likely the reader is to be sitting in one. Adding a client
 * that reads the `mcpServers` shape is one entry; nothing else changes.
 */
export function targets(): ClientTarget[] {
  const home = homedir();
  const support = appSupport();

  return [
    {
      id: "claude-code",
      label: "Claude Code",
      // `-s user` puts it in the user-level config rather than this directory,
      // which is what "I installed Brain" means to someone running `init`.
      writer: {
        kind: "cli",
        bin: "claude",
        args: (s) => [
          "mcp",
          "add",
          s.name,
          "--scope",
          "user",
          ...Object.entries(s.env).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
          "--",
          s.command,
          ...s.args,
        ],
      },
      evidence: [],
      docs: "https://code.claude.com/docs/en/mcp",
    },
    {
      id: "codex",
      label: "Codex CLI",
      // TOML, and `[mcp_servers.<name>.env]` is a sub-table — the one format
      // here that is not JSON. `codex mcp add` writes it correctly; this
      // installer does not need to learn TOML to support it.
      writer: {
        kind: "cli",
        bin: "codex",
        args: (s) => [
          "mcp",
          "add",
          s.name,
          ...Object.entries(s.env).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
          "--",
          s.command,
          ...s.args,
        ],
      },
      evidence: [],
      docs: "https://developers.openai.com/codex/mcp",
    },
    {
      id: "cursor",
      label: "Cursor",
      writer: { kind: "json", path: join(home, ".cursor", "mcp.json") },
      evidence: [join(home, ".cursor")],
      docs: "https://docs.cursor.com/context/model-context-protocol",
    },
    {
      id: "claude-desktop",
      label: "Claude Desktop",
      writer: {
        kind: "json",
        path: join(support, "Claude", "claude_desktop_config.json"),
      },
      evidence: [join(support, "Claude")],
      docs: "https://modelcontextprotocol.io/quickstart/user",
    },
    {
      id: "windsurf",
      label: "Windsurf",
      writer: {
        kind: "json",
        path: join(home, ".codeium", "windsurf", "mcp_config.json"),
      },
      evidence: [join(home, ".codeium", "windsurf")],
      docs: "https://docs.windsurf.com/windsurf/cascade/mcp",
    },
  ];
}
