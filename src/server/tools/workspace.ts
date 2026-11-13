/**
 * Sessions and spaces — the containers the memories sit in.
 *
 * None of `POST`/`GET`/`DELETE /v1/spaces` takes a path parameter, because
 * all three act on the CALLER'S OWN space, which Brain resolves from the
 * credential. A delete is therefore not "remove a space" but "erase this
 * workspace", and the request carries no id that could fail to match.
 *
 * `delete_space` supplies that missing id itself: the caller has to name the
 * space it believes it is erasing, and the name is checked against the one
 * the credential actually resolves to before anything is deleted. A caller
 * that is in a different workspace than it thinks gets a refusal instead of
 * an erasure.
 *
 * Registered onto a server built in `../index.ts`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BrainBackend } from "../../backend/index.js";
import { fail, ok, refuse } from "../result.js";

export function registerWorkspaceTools(server: McpServer, backend: BrainBackend): void {
  server.registerTool(
    "create_session",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
      title: "Create session",
      description:
        "Provision a session to attribute later writes to, so one " +
        "conversation's memories can be told apart from another's. The id is " +
        "yours to choose — use the conversation id you already have rather " +
        "than keeping a mapping — and the call is idempotent on it, so " +
        "calling it again at the start of a resumed conversation is safe.",
      inputSchema: {
        session_id: z
          .number()
          .int()
          .nonnegative()
          .describe("The session id to provision. Yours to choose; reuse is idempotent."),
        title: z.string().optional().describe("A human label."),
      },
    },
    async ({ session_id, title }) => {
      try {
        return ok(await backend.createSession(session_id, title));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "list_sessions",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      title: "List sessions",
      description:
        "The sessions in this SPACE, newest activity first. A session groups memories inside a space; it is not an isolation boundary, and a recall spans every session unless it filters. Note that everything `remember` writes lands in session 0, the default — so these are the sessions a client created explicitly, not a record of your own writes.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe("Page size."),
      },
    },
    async ({ limit }) => {
      try {
        return ok(await backend.listSessions(limit));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "delete_session",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
      title: "Delete session",
      description:
        "Retire a session. Soft by default, which leaves its memories in " +
        "place and only stops the session being listed. `hard` erases it, and " +
        "has to be asked for by name.",
      inputSchema: {
        session_id: z.number().int().nonnegative().describe("The session to retire."),
        hard: z
          .boolean()
          .optional()
          .describe("Erase rather than tombstone. Defaults to false."),
      },
    },
    async ({ session_id, hard }) => {
      try {
        return ok(await backend.deleteSession(session_id, hard));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "list_spaces",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      title: "List spaces",
      description:
        "The spaces this credential can see, with when each was last active. " +
        "Use whoami to find out which one you are writing to.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe("Page size."),
      },
    },
    async ({ limit }) => {
      try {
        return ok(await backend.listSpaces(limit));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "create_space",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
      title: "Provision this space",
      description:
        "Make sure THIS caller's space exists, and report its stats. It " +
        "takes no name and creates no other space: which space you are in is " +
        "decided by the key you connect with, so this provisions the one " +
        "`whoami` already reports and nothing else. Idempotent — calling it " +
        "for a space that exists succeeds with `created: false`, which is " +
        "the field that tells you which happened. Useful on first run, and " +
        "to read `memory_count` / `session_count` for the current space. To " +
        "get a DIFFERENT space you need a key bound to it; that is issued " +
        "outside this server. A space is an isolation boundary — memories in " +
        "one are not recalled from another — which makes it the right split " +
        "for separate tenants or environments and the wrong one for grouping " +
        "a conversation's writes, where `create_session` is what you want.",
      inputSchema: {
        metadata: z
          .string()
          .optional()
          .describe(
            "Opaque labels or quota hints to store with the space. " +
              "WRITE-ONLY — Brain stores it, and no read returns it, not " +
              "even `list_spaces`. Keep anything you need to read again " +
              "somewhere else.",
          ),
      },
    },
    async ({ metadata }) => {
      try {
        return ok(await backend.createSpace(metadata));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "delete_space",
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
      title: "Erase this workspace",
      description:
        "Erase THIS caller's whole workspace: every memory in it, and the " +
        "entities, statements and relations derived from them. There is no " +
        "soft mode and nothing restores it. It takes no name and cannot " +
        "reach another space — which space you are in is decided by the key " +
        "you connect with, the one `whoami` reports. `confirm_space_id` is " +
        "REQUIRED and must equal that space's id: read it with `whoami` " +
        "immediately before calling this, and pass it through unchanged. A " +
        "value that does not match is refused and deletes nothing, which is " +
        "what protects a caller who believes it is somewhere else. To clear " +
        "one conversation rather than the workspace use `delete_session`; " +
        "to drop a single memory use `forget`.",
      inputSchema: {
        confirm_space_id: z
          .string()
          .min(1)
          .describe(
            "The `space_id` from `whoami`, repeated here as the confirmation. " +
              "It is required with no default, because erasing a workspace " +
              "must be something the caller stated rather than something it " +
              "left out, and because the request itself carries no id — this " +
              "is the only thing standing between a wrong assumption about " +
              "which space you are in and an unrecoverable delete.",
          ),
      },
    },
    async ({ confirm_space_id }) => {
      try {
        // The confirmation is checked against the space the CREDENTIAL
        // resolves to, not against anything the caller supplied twice, so it
        // catches the case the id exists for: a caller acting on the wrong
        // workspace. This is the one tool that reads before it writes.
        const identity = await backend.whoami();
        const actual = typeof identity.space_id === "string" ? identity.space_id : "";
        if (actual === "") {
          return refuse(
            "this backend did not report a space_id for the current credential, so the confirmation cannot be checked and nothing was deleted",
            "call whoami and check what it returns; a credential with no space is not one this tool can erase",
          );
        }
        if (confirm_space_id.trim() !== actual) {
          return refuse(
            `confirm_space_id does not name this workspace: the credential resolves to ${actual}. Nothing was deleted`,
            "call whoami, pass the space_id it reports, and make sure that is the workspace you meant to erase",
          );
        }
        return ok(await backend.deleteSpace());
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "subscribe_events",
    {
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
      },
      title: "Drain change events",
      description:
        "Read what has changed in this workspace since a point in the feed. " +
        "RETURNS A BOUNDED SLICE AND CLOSES — it does not stream and does " +
        "not stay open. Each call returns the events it collected plus " +
        "`last_lsn`; pass that back as `from_lsn` next time to continue " +
        "without gaps or repeats, so following the feed is a loop you drive. " +
        "An empty result is normal and means nothing happened in the window, " +
        "not that the call failed. Use it to notice writes made by another " +
        "client or by the extractor; use `list_memories` to see what is " +
        "stored, which this does not report.",
      inputSchema: {
        from_lsn: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "Resume after this log sequence number — the `last_lsn` from " +
              "your previous call. Omitted starts at the live edge of the " +
              "feed, so events already written are NOT returned unless you " +
              "also set `include_history`.",
          ),
        include_history: z
          .boolean()
          .optional()
          .describe(
            "Replay what is already in the log before following the live " +
              "edge. Default false.",
          ),
        max_events: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Stop after this many events. Default 50."),
        wait_ms: z
          .number()
          .int()
          .min(100)
          .max(30_000)
          .optional()
          .describe(
            "Give up waiting after this long and return what arrived. " +
              "Default 5000. A quiet feed will use the whole budget, so keep " +
              "it short unless you are deliberately waiting for something.",
          ),
        sessions: z
          .array(z.number().int().nonnegative())
          .optional()
          .describe("Only events from these sessions."),
        memories: z
          .array(z.string().min(1))
          .optional()
          .describe("Only events for these memory ids (decimal strings)."),
      },
    },
    async ({ from_lsn, include_history, max_events, wait_ms, sessions, memories }) => {
      try {
        return ok(
          await backend.drainEvents(
            {
              from_lsn,
              include_history,
              sessions: sessions?.join(","),
              memories: memories?.join(","),
            },
            max_events ?? 50,
            wait_ms ?? 5000,
          ),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );
}
