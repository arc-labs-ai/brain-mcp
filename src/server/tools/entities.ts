/**
 * Creating, finding and walking out from entities.
 *
 * Registered onto a server built in `../index.ts`; see that file for why the
 * surface is shaped this way and which operations are deliberately absent.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BrainBackend } from "../../backend/index.js";
import { customerId, fail, ok } from "../result.js";

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
        customer_id: customerId,
        entity_type_id: z.number().int().min(1).describe("Declared entity type id."),
        canonical_name: z.string().min(1).describe("Canonical name for the entity."),
      },
    },
    async ({ customer_id, entity_type_id, canonical_name }) => {
      try {
        return ok(
          await backend.createEntity(customer_id, entity_type_id, canonical_name),
        );
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
        customer_id: customerId,
        entity_type_id: z.number().int().min(1).describe("Entity type to list."),
        limit: z.number().int().min(1).max(200).optional().describe("Page size."),
        cursor: z.string().optional().describe("Opaque cursor from a previous page."),
      },
    },
    async ({ customer_id, entity_type_id, limit, cursor }) => {
      try {
        return ok(
          await backend.listEntities(customer_id, entity_type_id, { limit, cursor }),
        );
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
        customer_id: customerId,
        candidate_name: z.string().min(1).describe("The name or mention to resolve."),
      },
    },
    async ({ customer_id, candidate_name }) => {
      try {
        return ok(await backend.resolveEntity(customer_id, candidate_name));
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
        customer_id: customerId,
        entity_id: z.string().min(1).describe("The entity id."),
      },
    },
    async ({ customer_id, entity_id }) => {
      try {
        return ok(await backend.getEntity(customer_id, entity_id));
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
        customer_id: customerId,
        entity_id: z.string().min(1).describe("Entity to start from."),
        depth: z.number().int().min(1).max(5).optional().describe("Hops to walk."),
        limit: z.number().int().min(1).max(200).optional().describe("Cap on results."),
      },
    },
    async ({ customer_id, entity_id, depth, limit }) => {
      try {
        return ok(await backend.traverseEntity(customer_id, entity_id, { depth, limit }));
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
        customer_id: customerId,
        entity_id: z.string().min(1).describe("The entity id."),
        limit: z.number().int().min(1).max(200).optional().describe("Page size."),
        cursor: z.string().optional().describe("Opaque cursor from a previous page."),
      },
    },
    async ({ customer_id, entity_id, limit, cursor }) => {
      try {
        return ok(
          await backend.entityRelations(customer_id, entity_id, { limit, cursor }),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );
}
