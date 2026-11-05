/**
 * `npx @brain-db/mcp init` — connect this machine's MCP clients to a Brain.
 *
 * The flow it replaces: find the package, learn that `--stdio` exists, learn
 * which env vars it reads, find a backend URL documented in neither the client
 * nor the package, locate a config file whose path differs per client and per
 * OS, hand-merge JSON (or TOML, for Codex) without breaking the servers
 * already in it, restart, and discover only inside an agent turn whether the
 * key was right.
 *
 * Ordering is the design. Nothing is written until the credential has been
 * proved against the backend, because a half-configured machine is worse than
 * an unconfigured one: the failure arrives later, somewhere else, as a broken
 * tool rather than a wrong key.
 */

import { createInterface } from "node:readline/promises";
import { DEFAULT_BACKEND_URL } from "../config/index.js";
import { type ClientTarget, type ServerSpec, targets } from "./clients.js";
import { VerifyError, verify } from "./verify.js";
import { type Outcome, detect, install } from "./write.js";

/**
 * The npm spec written into every client config.
 *
 * Unpinned, so `npx` resolves the current release on each cold start and a
 * published fix reaches installed machines without anyone re-running `init`.
 * That is the right trade while this package is young and the thing most
 * likely to need fixing is this package; it stops being the right trade once
 * enough people depend on it that an upstream break would hit them all at
 * once. Pin a major here when that changes.
 */
const PACKAGE_SPEC = "@brain-db/mcp";

export interface InitOptions {
  apiKey?: string;
  backendUrl?: string;
  /** Restrict to these client ids. Empty means every detected client. */
  clients: string[];
  dryRun: boolean;
  /** Never prompt. Fails instead of asking. */
  yes: boolean;
  serverName: string;
}

export function parseInitArgs(argv: string[]): InitOptions {
  const opts: InitOptions = {
    clients: [],
    dryRun: false,
    yes: false,
    serverName: "brain",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case "--key":
        opts.apiKey = next();
        break;
      case "--backend":
        opts.backendUrl = next();
        break;
      case "--client":
        opts.clients.push(next());
        break;
      case "--name":
        opts.serverName = next();
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "-y":
      case "--yes":
        opts.yes = true;
        break;
      default:
        throw new Error(`unknown option ${a}`);
    }
  }
  return opts;
}

/** Everything goes to stderr. stdout stays clean so `init --dry-run` can be
 *  piped without protocol-shaped noise, and so this file obeys the same rule
 *  the stdio transport does. */
function say(line = ""): void {
  console.error(line);
}

async function ask(question: string, mask: boolean): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    if (!mask) return (await rl.question(question)).trim();
    // Node has no built-in masked prompt. Muting the echo entirely is better
    // than printing a key into a terminal someone is screen-sharing; a visible
    // prompt plus no echo is the convention `sudo` set.
    const out = process.stderr as NodeJS.WriteStream & { muted?: boolean };
    const written = out.write.bind(out);
    out.write = ((chunk: string | Uint8Array, ...rest: unknown[]) =>
      out.muted === true
        ? true
        : written(chunk as string, ...(rest as []))) as typeof out.write;
    const p = rl.question(question);
    out.muted = true;
    try {
      return (await p).trim();
    } finally {
      out.muted = false;
      out.write = written;
      written("\n");
    }
  } finally {
    rl.close();
  }
}

export async function runInit(opts: InitOptions): Promise<number> {
  const backendUrl = (
    opts.backendUrl ??
    process.env.BRAIN_MCP_BACKEND_URL ??
    DEFAULT_BACKEND_URL
  ).replace(/\/+$/, "");

  say();
  say("  brain-mcp init");
  say(`  backend   ${backendUrl}`);

  /*
   * Argument errors first, before the key is asked for or checked.
   *
   * `--client nvim` is a typo, and a typo should not cost a round trip to the
   * backend to discover — nor should the answer be an unrelated complaint
   * about the credential, which is what the reader got when this ran after
   * verification.
   */
  const all = targets();
  const wanted = opts.clients.length > 0 ? opts.clients : undefined;
  if (wanted) {
    const known = new Set(all.map((t) => t.id));
    const bad = wanted.filter((c) => !known.has(c));
    if (bad.length > 0) {
      say();
      say(`  ✗ unknown client: ${bad.join(", ")}`);
      say(`    known: ${all.map((t) => t.id).join(", ")}`);
      return 1;
    }
  }

  let apiKey = opts.apiKey ?? process.env.BRAIN_MCP_API_KEY;
  if (apiKey === undefined || apiKey.trim() === "") {
    if (opts.yes || !process.stdin.isTTY) {
      say();
      say("  No API key. Pass --key, or set BRAIN_MCP_API_KEY.");
      say("  Create one in the dashboard under API Keys.");
      return 1;
    }
    apiKey = await ask("  Brain API key: ", true);
  }
  apiKey = apiKey.trim();
  if (apiKey === "") {
    say("  No key given, nothing written.");
    return 1;
  }

  // ── Prove it, then write. Never the other way round. ─────────────────────
  try {
    const who = await verify(backendUrl, apiKey);
    const where = [who.namespace, who.space].filter(Boolean).join(" / ");
    say(`  key       valid${where ? ` — ${where}` : ""}`);
    if (who.missing.length > 0) {
      // Not fatal. The key works, some of the tools it reaches will not, and
      // saying so here is the difference between a puzzling tool error later
      // and a known limitation now.
      say(
        `  ⚠ this key cannot ${who.missing.join(" or ")} — those tools will fail. Mint one with full scope if that is not intended.`,
      );
    }
  } catch (err) {
    if (err instanceof VerifyError) {
      say();
      say(`  ✗ ${err.message}`);
      if (err.hint) say(`    ${err.hint}`);
      say();
      say("  Nothing was written.");
      return 1;
    }
    throw err;
  }

  const spec: ServerSpec = {
    name: opts.serverName,
    command: "npx",
    args: ["-y", PACKAGE_SPEC, "--stdio"],
    env: { BRAIN_MCP_BACKEND_URL: backendUrl, BRAIN_MCP_API_KEY: apiKey },
  };

  const chosen = all.filter((t) => (wanted ? wanted.includes(t.id) : true));
  // `--client` is an instruction, not a filter: naming a client that this
  // machine does not appear to have should still configure it, because the
  // user knows something the detector does not.
  const present = chosen.filter((t) => (wanted ? true : detect(t)));

  say();
  if (present.length === 0) {
    say("  No supported MCP client found on this machine.");
    say("  Install one, or name it: --client claude-code|codex|cursor|…");
    say();
    manual(spec, all);
    return 1;
  }

  const outcomes: Outcome[] = present.map((t) => install(t, spec, opts.dryRun));
  for (const o of outcomes) {
    const mark = o.status === "written" ? "✓" : o.status === "skipped" ? "–" : "✗";
    say(`  ${mark} ${o.client.label.padEnd(16)} ${o.detail}`);
  }

  const failed = outcomes.filter((o) => o.status === "failed");
  const ok = outcomes.filter((o) => o.status === "written");

  say();
  if (opts.dryRun) {
    say("  --dry-run: nothing was written.");
    return failed.length > 0 ? 1 : 0;
  }
  if (ok.length > 0) {
    say("  Restart the client, then try:");
    say('    "remember that I prefer pnpm over npm"');
    say('    "what do you remember about my tooling?"');
  }
  if (failed.length > 0) {
    say();
    say(`  ${failed.length} client could not be configured. Do those by hand:`);
    say();
    manual(
      spec,
      failed.map((f) => f.client),
    );
    return 1;
  }
  return 0;
}

/** The snippet to paste, for a client this installer could not write to. */
function manual(spec: ServerSpec, clients: ClientTarget[]): void {
  const json = JSON.stringify(
    {
      mcpServers: {
        [spec.name]: {
          command: spec.command,
          args: spec.args,
          env: { ...spec.env, BRAIN_MCP_API_KEY: "brain_…" },
        },
      },
    },
    null,
    2,
  );
  for (const c of clients) {
    say(`  ${c.label}: ${c.writer.kind === "json" ? c.writer.path : c.docs}`);
  }
  say();
  for (const line of json.split("\n")) say(`    ${line}`);
  say();
  say("  The key is masked above — put your own in place of brain_….");
}
