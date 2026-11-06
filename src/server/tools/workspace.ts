/**
 * Sessions and spaces — the containers the memories sit in.
 *
 * Only the non-destructive half of the space verbs is here, and the reason is
 * in the shape of the API rather than in taste: none of `POST`/`GET`/`DELETE
 * /v1/spaces` takes a path parameter, because all three act on the CALLER'S
 * OWN space, which Brain resolves from the credential. `DELETE` is therefore
 * not "remove a space" but "erase this workspace" — one tool call, no id to
 * get wrong, and nothing that undoes it. It has no tool. `list_spaces` does,
 * because reading is not that.
 *
 * Registered onto a server built in `../index.ts`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BrainBackend } from "../../backend/index.js";
import { fail, ok } from "../result.js";

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
      description: "The sessions in this workspace, newest activity first.",
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
}
