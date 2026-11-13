/**
 * Who a request runs as, what the deployment supports, and whether a provider key is installed.
 *
 * Registered onto a server built in `../index.ts`; see that file for why the
 * surface is shaped this way and which operations are deliberately absent.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BrainBackend } from "../../backend/index.js";
import { fail, ok, refuse } from "../result.js";

/**
 * Read a provider key out of this process's environment.
 *
 * The agent names the variable; the VALUE never appears in a tool argument,
 * a tool result, or an error message. That is the whole point: a live
 * provider key passed as an argument is written into the model's context and
 * into every transcript and log of the session, and it stays valid there.
 *
 * Only meaningful on stdio, where the client started this process and its
 * environment is the user's own. On HTTP the environment belongs to whoever
 * runs the deployment, so reading it would hand one tenant another's secret
 * — which is why the tools below are not registered there at all.
 */
type EnvLookup = { ok: true; key: string } | { ok: false; problem: string; fix: string };

function keyFromEnv(name: string): EnvLookup {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return {
      ok: false,
      problem: `\`${name}\` is not a valid environment variable name`,
      fix:
        "this argument is the NAME of the variable holding the key, such as " +
        "OPENAI_API_KEY — not the key. If you were about to paste a key " +
        "here, do not: set it in the MCP client config that launches this " +
        "server and pass the variable's name instead.",
    };
  }
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    return {
      ok: false,
      problem: `environment variable \`${name}\` is not set in this server's process`,
      fix:
        "set it in the MCP client config that launches brain-mcp — the same " +
        "place BRAIN_MCP_API_KEY is set — and restart the client. Passing " +
        "the key as an argument instead is not an alternative: it would be " +
        "written into this conversation and every log of it.",
    };
  }
  return { ok: true, key: value.trim() };
}

/** The provider names the edge routes, and the argument shape both key
 *  tools share. */
const credentialFields = {
  provider: z
    .enum(["openai", "anthropic"])
    .describe("Which provider the key belongs to."),
  model: z
    .string()
    .min(1)
    .describe(
      "The model Brain should use for extraction and HyPE on every write, " +
        "e.g. `gpt-4o-mini` or `claude-haiku-4-5`. Pick a cheap, fast model: " +
        "it runs twice per memory stored.",
    ),
  api_key_env: z
    .string()
    .min(1)
    .describe(
      "The NAME of an environment variable holding the provider key — for " +
        "example `OPENAI_API_KEY`. NOT the key itself. This server reads the " +
        "variable out of its own process, so the secret never passes through " +
        "a tool argument, where it would be written into the conversation " +
        "and into every log of it. If the variable is not set, set it in the " +
        "MCP client config that launches this server rather than pasting the " +
        "key here.",
    ),
};

export function registerIdentityTools(
  server: McpServer,
  backend: BrainBackend,
  /** True when this process's environment is the user's own — stdio. The
   *  key tools are registered only then; see {@link keyFromEnv}. */
  readsLocalEnvironment: boolean,
): void {
  server.registerTool(
    "whoami",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      title: "Who am I",
      description:
        "Report the identity this connection runs as — the namespace and space " +
        "your API key resolves to on the server. Call it first when anything " +
        "looks like it is reading the wrong workspace.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await backend.whoami());
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "capabilities",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      title: "Capabilities",
      description:
        "What this deployment supports — limits, enabled extractor tiers, " +
        "protocol version. Use to check a limit before hitting it.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await backend.capabilities());
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "llm_credential_status",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      title: "LLM provider key status",
      description:
        "Whether this workspace has an LLM provider key, and which provider and " +
        "model it is for. Returns a display fingerprint, never the key. Use to " +
        "confirm the cause when a write is refused for a missing key.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await backend.getLlmCredential());
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "verify_llm_credential",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      title: "Verify LLM credential",
      description:
        "Re-check the provider key this workspace already has, by asking the " +
        "provider. Takes nothing and sends no secret anywhere. A key that " +
        "worked when it was registered can be revoked later, and without this " +
        "the first sign is an opaque upstream failure on a write — so run it " +
        "when extraction or reasoning starts failing for no visible reason.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await backend.verifyLlmCredential());
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- BYOK provider key -------------------------------------------------
  //
  // Registered only on stdio. On HTTP the process environment belongs to the
  // operator, not the caller, so `api_key_env` would read a secret the caller
  // does not own — and there is no safe argument to replace it with.
  if (!readsLocalEnvironment) return;

  server.registerTool(
    "put_llm_credential",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      title: "Register provider key",
      description:
        "Install this workspace's LLM provider key, so writes can be " +
        "extracted into typed facts. Brain calls a provider on EVERY " +
        "`remember` — once to extract statements and entities, once for the " +
        "retrieval questions — so without a key a write is refused rather " +
        "than stored ungrounded. Replaces any key already registered. The " +
        "key is verified with the provider before it is stored, so a typo " +
        "fails here rather than on every later write. Takes the NAME of an " +
        "environment variable, never the key: run " +
        "`llm_credential_status` first to see whether one is already " +
        "installed.",
      inputSchema: credentialFields,
    },
    async ({ provider, model, api_key_env }) => {
      const found = keyFromEnv(api_key_env);
      if (!found.ok) return refuse(found.problem, found.fix);
      try {
        return ok(await backend.putLlmCredential(provider, model, found.key));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "test_llm_credential",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      title: "Test a provider key",
      description:
        "Check a provider key against the provider WITHOUT storing it and " +
        "without touching the one already registered. Use before " +
        "`put_llm_credential` when you are not sure a key is live. To " +
        "re-check the key that IS registered, use `verify_llm_credential` " +
        "instead — it needs no argument.",
      inputSchema: credentialFields,
    },
    async ({ provider, model, api_key_env }) => {
      const found = keyFromEnv(api_key_env);
      if (!found.ok) return refuse(found.problem, found.fix);
      try {
        return ok(await backend.testLlmCredential(provider, model, found.key));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "delete_llm_credential",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
      title: "Revoke the provider key",
      description:
        "Remove this workspace's provider key. EVERY SUBSEQUENT WRITE WILL " +
        "BE REFUSED until a key is registered again — Brain will not store " +
        "text it cannot ground. This is incident response (a leaked key), " +
        "not cleanup. Reports whether a key was actually removed, so " +
        '"revoked" and "there was nothing there" stay distinguishable. ' +
        "Reads are unaffected.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await backend.deleteLlmCredential());
      } catch (err) {
        return fail(err);
      }
    },
  );
}
