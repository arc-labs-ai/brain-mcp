/**
 * Creating, finding and walking out from entities.
 *
 * Registered onto a server built in `../index.ts`; see that file for why the
 * surface is shaped this way and which operations are deliberately absent.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BrainBackend } from "../../backend/index.js";
import { fail, ok } from "../result.js";

export function registerEntitiesTools(server: McpServer, backend: BrainBackend): void {
  server.registerTool(
    "create_entity",
    {
      title: "Create entity",
      description:
        "Declare an entity of a known type. Creating one that already exists " +
        "under the same name is a conflict, not a silent no-op — resolve_entity " +
        "first if you are unsure.",
      inputSchema: {
        entity_type_id: z.number().int().min(1).describe("Declared entity type id."),
        canonical_name: z.string().min(1).describe("Canonical name for the entity."),
      },
    },
    async ({ entity_type_id, canonical_name }) => {
      try {
        return ok(await backend.createEntity(entity_type_id, canonical_name));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "list_entities",
    {
      title: "List entities",
      description:
        "Entities of one type. The type is required — listing across every type " +
        "is refused rather than silently paged.",
      inputSchema: {
        entity_type_id: z.number().int().min(1).describe("Entity type to list."),
        limit: z.number().int().min(1).max(200).optional().describe("Page size."),
        cursor: z.string().optional().describe("Opaque cursor from a previous page."),
      },
    },
    async ({ entity_type_id, limit, cursor }) => {
      try {
        return ok(await backend.listEntities(entity_type_id, { limit, cursor }));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "resolve_entity",
    {
      title: "Resolve entity",
      description:
        "Map a surface form ('the Acme account', 'Priya') to the entity it " +
        "refers to, or report no match. Use before creating, and before " +
        "assuming two mentions are the same thing.",
      inputSchema: {
        candidate_name: z.string().min(1).describe("The name or mention to resolve."),
      },
    },
    async ({ candidate_name }) => {
      try {
        return ok(await backend.resolveEntity(candidate_name));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "get_entity",
    {
      title: "Get entity",
      description: "One entity by id, with its canonical name, type and attributes.",
      inputSchema: {
        entity_id: z.string().min(1).describe("The entity id."),
      },
    },
    async ({ entity_id }) => {
      try {
        return ok(await backend.getEntity(entity_id));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "traverse_entity",
    {
      title: "Traverse from entity",
      description:
        "Walk outward from an entity along its relations. Use to answer 'what " +
        "is connected to this, and how' without pulling the whole graph.",
      inputSchema: {
        entity_id: z.string().min(1).describe("Entity to start from."),
        depth: z.number().int().min(1).max(5).optional().describe("Hops to walk."),
        limit: z.number().int().min(1).max(200).optional().describe("Cap on results."),
      },
    },
    async ({ entity_id, depth, limit }) => {
      try {
        return ok(await backend.traverseEntity(entity_id, { depth, limit }));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "entity_relations",
    {
      title: "Entity relations",
      description: "The relations attached to one entity, without walking further out.",
      inputSchema: {
        entity_id: z.string().min(1).describe("The entity id."),
        limit: z.number().int().min(1).max(200).optional().describe("Page size."),
        cursor: z.string().optional().describe("Opaque cursor from a previous page."),
      },
    },
    async ({ entity_id, limit, cursor }) => {
      try {
        return ok(await backend.entityRelations(entity_id, { limit, cursor }));
      } catch (err) {
        return fail(err);
      }
    },
  );
  // --- lifecycle ---------------------------------------------------------
  //
  // Extraction produces duplicates; a duplicate that cannot be folded in is a
  // permanent split in everything that traverses the graph. These are the
  // tools that let an agent clean up after itself.

  server.registerTool(
    "update_entity",
    {
      title: "Update entity",
      description:
        "Replace an entity's name, aliases and attributes WHOLESALE. This is a " +
        "replace, not a patch: omitting aliases CLEARS them. Call get_entity " +
        "first and send back the full list with your change applied. To change " +
        "only the name, use rename_entity instead — it keeps the old name as an " +
        "alias so older text still resolves.",
      inputSchema: {
        entity_id: z.string().min(1).describe("The entity to update."),
        canonical_name: z.string().min(1).describe("The new canonical display name."),
        aliases: z
          .array(z.string())
          .optional()
          .describe("The COMPLETE alias list. Omitting it clears every alias."),
        attributes: z
          .string()
          .optional()
          .describe("The complete attribute blob, lowercase hex. Omitting it clears it."),
      },
    },
    async ({ entity_id, canonical_name, aliases, attributes }) => {
      try {
        return ok(
          await backend.updateEntity(entity_id, canonical_name, { aliases, attributes }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "rename_entity",
    {
      title: "Rename entity",
      description:
        "Give an entity a new canonical name, keeping the old one as an alias. " +
        "Prefer this over update_entity for a name change: the name an entity " +
        "was known by is how a mention in older text still resolves to it, so " +
        "dropping it silently breaks resolution for everything written before " +
        "the rename.",
      inputSchema: {
        entity_id: z.string().min(1).describe("The entity to rename."),
        new_canonical_name: z.string().min(1).describe("The new canonical display name."),
        move_to_alias: z
          .boolean()
          .optional()
          .describe(
            "Keep the old name as an alias. Defaults to true; pass false only " +
              "when the old name was wrong rather than outdated.",
          ),
      },
    },
    async ({ entity_id, new_canonical_name, move_to_alias }) => {
      try {
        return ok(
          await backend.renameEntity(entity_id, new_canonical_name, move_to_alias),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "merge_entities",
    {
      title: "Merge entities",
      description:
        "Fold one entity into another when both describe the same thing. " +
        "survivor_entity_id is the one that REMAINS; merged_entity_id is " +
        "absorbed into it and stops appearing on its own. Check both with " +
        "get_entity before calling — the direction is not symmetric, and " +
        "unmerge_entity is the only way back.",
      inputSchema: {
        survivor_entity_id: z.string().min(1).describe("The entity that remains."),
        merged_entity_id: z.string().min(1).describe("The entity folded into it."),
        confidence: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("How sure you are these are the same thing, 0..1."),
        reason: z.string().optional().describe("Why. Kept in the merge audit record."),
      },
    },
    async ({ survivor_entity_id, merged_entity_id, confidence, reason }) => {
      try {
        return ok(
          await backend.mergeEntities(survivor_entity_id, merged_entity_id, {
            confidence,
            reason,
          }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "unmerge_entity",
    {
      title: "Unmerge entity",
      description:
        "Pull an entity back out of the survivor it was merged into — the " +
        "undo for merge_entities. Pass the id of the entity that was absorbed, " +
        "not the survivor.",
      inputSchema: {
        entity_id: z.string().min(1).describe("The entity that was merged away."),
      },
    },
    async ({ entity_id }) => {
      try {
        return ok(await backend.unmergeEntity(entity_id));
      } catch (err) {
        return fail(err);
      }
    },
  );
  server.registerTool(
    "delete_entity",
    {
      title: "Delete entity",
      description:
        "Tombstone an entity so it stops appearing in listings and traversals. " +
        "Soft: rows that referenced it still refer to something that exists. If " +
        "the entity is a duplicate rather than a mistake, merge_entities keeps " +
        "its mentions instead of stranding them.",
      inputSchema: {
        entity_id: z.string().min(1).describe("The entity to tombstone."),
        reason: z.string().optional().describe("Why. Kept on the tombstone record."),
      },
    },
    async ({ entity_id, reason }) => {
      try {
        return ok(await backend.deleteEntity(entity_id, reason));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
