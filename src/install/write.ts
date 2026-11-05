/**
 * Putting a server definition into a client's config without damaging it.
 *
 * These files belong to the user. They hold other people's MCP servers, and
 * for Claude Desktop and Cursor they are the only copy. So every write here is
 * a read-merge-write that preserves what it did not come to change, and a file
 * that cannot be parsed is REFUSED rather than replaced — a config with a
 * trailing comma is a config someone is editing, not a config to overwrite.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { ClientTarget, ServerSpec } from "./clients.js";

export class InstallError extends Error {}

/** What happened to one client. */
export interface Outcome {
  client: ClientTarget;
  status: "written" | "skipped" | "failed";
  /** Where it landed, or why it did not. */
  detail: string;
}

/** Whether the client appears to be installed on this machine. */
export function detect(target: ClientTarget): boolean {
  if (target.writer.kind === "cli") return onPath(target.writer.bin);
  return target.evidence.some((p) => existsSync(p)) || existsSync(target.writer.path);
}

function onPath(bin: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(probe, [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Register `spec` with `target`.
 *
 * `dryRun` runs every check and every merge and stops before the write, so
 * `--dry-run` reports the same successes and the same failures a real run
 * would — a rehearsal that skipped the parse would not be one.
 */
export function install(
  target: ClientTarget,
  spec: ServerSpec,
  dryRun: boolean,
): Outcome {
  try {
    if (target.writer.kind === "cli") {
      return viaCli(target, spec, dryRun);
    }
    return viaJson(target, spec, dryRun);
  } catch (err) {
    return {
      client: target,
      status: "failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function viaCli(target: ClientTarget, spec: ServerSpec, dryRun: boolean): Outcome {
  if (target.writer.kind !== "cli") throw new Error("unreachable");
  const { bin, args } = target.writer;
  const argv = args(spec);
  if (dryRun) {
    return { client: target, status: "written", detail: `${bin} ${argv[0]} …` };
  }
  try {
    execFileSync(bin, argv, { stdio: "pipe" });
  } catch (err) {
    // The CLI's own stderr says more than the exit code — a name already
    // taken, an unsupported flag on an older build — so it is what the user
    // sees rather than "command failed".
    const e = err as { stderr?: Buffer; message?: string };
    const said = e.stderr?.toString().trim();
    throw new InstallError(said && said.length > 0 ? said : (e.message ?? "failed"));
  }
  return { client: target, status: "written", detail: `via \`${bin} mcp add\`` };
}

interface McpFile {
  mcpServers?: Record<string, unknown>;
  [k: string]: unknown;
}

function viaJson(target: ClientTarget, spec: ServerSpec, dryRun: boolean): Outcome {
  if (target.writer.kind !== "json") throw new Error("unreachable");
  const path = target.writer.path;

  let doc: McpFile = {};
  const existed = existsSync(path);
  if (existed) {
    const raw = readFileSync(path, "utf8");
    if (raw.trim().length > 0) {
      try {
        doc = JSON.parse(raw) as McpFile;
      } catch {
        // Not ours to fix, and not ours to clobber.
        throw new InstallError(
          `${path} is not valid JSON. Fix or move it and run init again — refusing to overwrite a file someone may be editing.`,
        );
      }
      if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
        throw new InstallError(`${path} is not a JSON object.`);
      }
    }
  }

  const servers = (doc.mcpServers ?? {}) as Record<string, unknown>;
  servers[spec.name] = {
    command: spec.command,
    args: spec.args,
    env: spec.env,
  };
  doc.mcpServers = servers;

  if (dryRun) {
    return {
      client: target,
      status: "written",
      detail: `${path} (${existed ? "merge" : "create"})`,
    };
  }

  mkdirSync(dirname(path), { recursive: true });
  // A copy before the first edit, so a bad merge is recoverable by someone who
  // did not think to make one.
  if (existed) copyFileSync(path, `${path}.brain-backup`);
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  // The file now holds an API key. `writeFileSync`'s mode applies only when it
  // CREATES the file, so an existing one keeps whatever it had — usually 644.
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort: a config on a filesystem without POSIX modes is still a
    // working config, and failing the install over it would help nobody.
  }
  return { client: target, status: "written", detail: path };
}
