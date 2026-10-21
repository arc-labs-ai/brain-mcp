# brain-mcp

A **managed MCP server** for the [Brain](https://github.com/arc-labs-ai) memory
database. It exposes Brain's tenant surface as MCP tools over **remote
Streamable HTTP**, so any MCP client (Claude, ChatGPT, Cursor, Copilot, …) can
give its agent durable, current-truth memory in one connection.

It is a thin, stateless front for Brain's REST surface (`/v1/*`): point it at the
hosted **gateway** or a self-hosted **brain-edge** — the JSON contract is the
same. Every tool takes a `customer_id` for per-customer isolation (see
[Scoping](#scoping) for how that behaves on each backend).

## Quick start

```bash
npm install -g @brain-db/mcp
```

### Connect a client

brain-mcp speaks MCP two ways. Pick the one your client uses.

**stdio** — the client starts and owns the process. This is the usual local
setup for Claude Desktop and Cursor:

```json
{
  "mcpServers": {
    "brain": {
      "command": "npx",
      "args": ["-y", "@brain-db/mcp", "--stdio"],
      "env": {
        "BRAIN_MCP_BACKEND_URL": "https://api.arc-labs.ai",
        "BRAIN_MCP_API_KEY": "brain_…",
        "BRAIN_MCP_NAMESPACE": "your-namespace"
      }
    }
  }
}
```

**Remote HTTP** — you run the server, the client connects to it. Use this to
share one deployment across clients or machines:

```bash
brain-mcp            # listens on :3333, MCP endpoint at POST /mcp
```

```json
{
  "mcpServers": {
    "brain": { "url": "http://127.0.0.1:3333/mcp" }
  }
}
```

`--stdio` (or `BRAIN_MCP_STDIO=1`) selects stdio; otherwise an HTTP listener
starts. On stdio the client holds the credential in its own config and the
server writes only protocol frames to stdout — all logs go to stderr, which
clients show as server logs.

OAuth applies to the HTTP transport only: over stdio the client already owns
the process and sends no HTTP request, so `--stdio` with
`BRAIN_MCP_OAUTH_ENABLED` set exits rather than quietly serving unauthenticated.

## Run from source

```bash
npm install
cp .env.example .env      # set BRAIN_MCP_BACKEND_URL / _API_KEY / _NAMESPACE
npm run build
npm start                 # HTTP on :3333, MCP endpoint at POST /mcp
npm start -- --stdio      # or stdio, for a client that owns the process
```

Liveness: `curl -fsS localhost:3333/healthz`.

### Configuration

| Env var | Required | Default | Meaning |
|---|---|---|---|
| `BRAIN_MCP_BACKEND_URL` | yes | — | Brain REST base URL (gateway or brain-edge). |
| `BRAIN_MCP_API_KEY` | yes | — | Bearer key sent to the backend. |
| `BRAIN_MCP_NAMESPACE` | yes | — | Namespace slug scope. |
| `BRAIN_MCP_NAMESPACE_HEADER` | no | `x-brain-namespace` | Namespace scope header. |
| `BRAIN_MCP_SCOPE_HEADER` | no | `x-brain-space` | Per-customer scope header (gateway also accepts the legacy `x-brain-agent`). |
| `BRAIN_MCP_STDIO` | no | `false` | Serve MCP over stdin/stdout instead of HTTP (same as `--stdio`). The port/host settings are unused in that mode. |
| `BRAIN_MCP_PORT` | no | `3333` | Listen port (HTTP only). |
| `BRAIN_MCP_HOST` | no | `0.0.0.0` | Bind interface. |
| `BRAIN_MCP_REQUEST_TIMEOUT_MS` | no | `30000` | Per-request backend timeout. |

## Tools

25 tools over the tenant surface. Every one takes `customer_id`; `?` marks an
optional argument.

**Memory** — The core loop. Most agents only ever call the first three.

| Tool | Args | What it does |
|---|---|---|
| `remember` | `customer_id`, `content` | Store a fact, event, or conversation turn for a customer. Brain extracts typed facts and supersedes stale ones automatically. Returns the memory id. |
| `recall` | `customer_id`, `query`, `max_results?` | Retrieve the current, consistent truth for a customer against a query. Returns an answer shape (single / many / none) with evidence and confidence — stale and contradicted facts are already resolved server-side. |
| `forget` | `customer_id`, `memory_id`, `hard?` | Delete a specific memory for a customer. Soft by default (tombstone with a grace window); set hard=true to zero it immediately. Cascades to dependent facts. |
| `list_memories` | `customer_id`, `limit?`, `cursor?` | Page through what is stored for a customer, newest first. Use when you need to see what exists rather than answer a question — recall is for questions, this is for inventory. |
| `inspect_memory` | `customer_id`, `memory_id` | Everything behind one memory: the typed facts extracted from it, its provenance, and how it scored. Use when an answer looks wrong and you need to see why that memory was or was not used. |

**Reasoning** — Ask Brain to plan or answer over what it knows about this customer.

| Tool | Args | What it does |
|---|---|---|
| `plan` | `customer_id`, `start`, `goal`, `max_steps?` | Find a route from a start state to a goal across what is known about the customer. Use for 'how do we get from here to there' questions; it reasons over stored facts rather than inventing steps. |
| `reason` | `customer_id`, `observation` | Infer what follows from an observation, given what is already known about the customer. Use to check an implication before acting on it. |

**Entities** — The typed entity layer. `entity_type_id` comes from `get_schema`.

| Tool | Args | What it does |
|---|---|---|
| `create_entity` | `customer_id`, `entity_type_id`, `canonical_name` | Declare an entity of a known type. Creating one that already exists under the same name is a conflict, not a silent no-op — resolve_entity first if you are unsure. |
| `list_entities` | `customer_id`, `entity_type_id`, `limit?`, `cursor?` | Entities of one type. The type is required — listing across every type is refused rather than silently paged. |
| `resolve_entity` | `customer_id`, `candidate_name` | Map a surface form ('the Acme account', 'Priya') to the entity it refers to, or report no match. Use before creating, and before assuming two mentions are the same thing. |
| `get_entity` | `customer_id`, `entity_id` | One entity by id, with its canonical name, type and attributes. |
| `traverse_entity` | `customer_id`, `entity_id`, `depth?`, `limit?` | Walk outward from an entity along its relations. Use to answer 'what is connected to this, and how' without pulling the whole graph. |
| `entity_relations` | `customer_id`, `entity_id`, `limit?`, `cursor?` | The relations attached to one entity, without walking further out. |

**Graph** — Typed relations between entities.

| Tool | Args | What it does |
|---|---|---|
| `link` | `customer_id`, `source`, `target`, `kind` | Connect two memories with a typed edge (caused, followed_by, derived_from, similar_to, contradicts, supports, references, part_of). Use when the relationship is real but neither memory states it. |
| `unlink` | `customer_id`, `source`, `target`, `kind` | Remove a typed edge between two memories. Idempotent. |
| `graph` | `customer_id`, `limit?`, `cursor?` | A page of the customer's knowledge graph — entities and the relations between them. Use to see structure; use recall to answer a question. |

**Knowledge** — Read the statements and relations Brain extracted.

| Tool | Args | What it does |
|---|---|---|
| `list_statements` | `customer_id`, `limit?`, `cursor?` | Page through the subject–predicate–object facts extracted from this customer's memories. Use to audit what Brain believes, not to answer a question. |
| `get_statement` | `customer_id`, `statement_id` | One statement by id, with the memory it came from. |
| `get_relation` | `customer_id`, `relation_id` | One relation by id, with its endpoints and type. |

**Schema** — Declare the entity and relation types this namespace uses.

| Tool | Args | What it does |
|---|---|---|
| `get_schema` | `customer_id` | The entity and relation types declared for this customer. Read this before creating entities — `entity_type_id` comes from here. |
| `validate_schema` | `customer_id`, `schema_document` | Check a schema document without storing it. Use before upload_schema so a malformed document is caught before it changes anything. |
| `upload_schema` | `customer_id`, `schema_document` | Merge new declarations into the customer's schema. Additive: it cannot drop a declaration, and changing an existing one is a conflict. Replacing a schema destructively is not available here. |

**Identity** — What this request runs as, and what the deployment can do.

| Tool | Args | What it does |
|---|---|---|
| `whoami` | `customer_id` | Report the effective identity (namespace + customer scope) a request runs as. Useful to confirm the server is scoped to the intended customer. |
| `capabilities` | `customer_id` | What this deployment supports — limits, enabled extractor tiers, protocol version. Use to check a limit before hitting it. |
| `llm_credential_status` | `customer_id` | Whether this workspace has an LLM provider key, and which provider and model it is for. Returns a display fingerprint, never the key. Use to confirm the cause when a write is refused for a missing key. |
### Deliberately not exposed

Three tenant routes have no tool, because an agent holding them is a worse
deal than an agent without them:

- `PUT /v1/llm-credential` and `DELETE /v1/llm-credential` — registering or
  removing a provider key. A tool that accepts a raw provider key invites a
  model to put one in a tool call, where it lands in transcripts and logs.
  `llm_credential_status` covers the read side. Keys are managed in the
  dashboard.
- `force_drop_existing` on `PUT /v1/schema` — destructive schema replacement.
  `upload_schema` cannot set it, so the worst an agent can do is an additive
  change.

## Scoping

`customer_id` isolates each end customer's memories. How it takes effect depends
on the backend:

- **Hosted gateway** — the `customer_id` rides the `x-brain-space` scope header
  and the gateway runs the request as that customer (`act_as`). One service key
  (with `may_act`) serves **many isolated customers**. This is the intended mode.
- **Self-hosted brain-edge** — brain-edge scopes purely by the API key's bound
  identity and **ignores** the scope headers today. So a single edge key maps to
  a single customer: for multi-customer self-host, run one key per customer (or
  put the gateway in front). `customer_id` is still required by the tools for a
  consistent surface, but does not isolate on edge alone.

## Auth

The server holds one bearer API key for the **backend** (its own service
principal). How the **MCP endpoint** itself is protected depends on whether OAuth
is enabled:

**No-auth (default).** The MCP endpoint is unauthenticated — run it behind your
own gateway/network boundary. Set `BRAIN_MCP_NAMESPACE` for the namespace and
scope per customer via the tool `customer_id`.

**OAuth 2.1 (`BRAIN_MCP_OAUTH_ENABLED=true`).** The server becomes an OAuth 2.1
resource server (RFC 9728):

- It publishes `/.well-known/oauth-protected-resource` pointing MCP clients at
  your authorization server (`BRAIN_MCP_OAUTH_ISSUER`) — Arc auth or any OIDC IdP.
  The AS owns PKCE / dynamic client registration / consent; this server never
  mints tokens.
- Every request needs a valid bearer JWT (verified against the issuer's JWKS,
  matching `iss` + `aud`); missing/invalid → `401` with a `WWW-Authenticate`
  hint to the metadata.
- The token's tenant claim (`BRAIN_MCP_OAUTH_NAMESPACE_CLAIM`, default
  `namespace`) selects the Brain namespace, so one deployment serves many
  tenants. Brain is still called with the service key + `act_as` — the user token
  authorizes the *caller*, not the Brain connection.

| Env var | Required (OAuth) | Default | Meaning |
|---|---|---|---|
| `BRAIN_MCP_OAUTH_ENABLED` | — | `false` | Turn OAuth on. |
| `BRAIN_MCP_OAUTH_ISSUER` | yes | — | Authorization-server issuer URL (also required JWT `iss`). |
| `BRAIN_MCP_OAUTH_JWKS_URI` | yes | — | JWKS endpoint for token verification. |
| `BRAIN_MCP_OAUTH_AUDIENCE` | yes | — | Resource id tokens must target (JWT `aud`). |
| `BRAIN_MCP_PUBLIC_URL` | yes | — | This server's externally-reachable base URL. |
| `BRAIN_MCP_OAUTH_SCOPES` | no | (any) | Space/comma list of scopes a token must carry. |
| `BRAIN_MCP_OAUTH_NAMESPACE_CLAIM` | no | `namespace` | JWT claim → Brain namespace. |

## Errors

Every tool funnels failures through one renderer, so a condition reads the same
whichever tool hit it. A failed call comes back as an `isError` result (never a
thrown exception, which an MCP client reports as a transport fault) with four
labelled lines:

```
error: namespace acme has no LLM credential registered
code: llm_credential.missing http 409
retry: no — this call will fail identically until the cause below is fixed
fix: this workspace has no LLM provider key configured. Brain extracts typed
     facts … a workspace admin needs to add an OpenAI or Anthropic key in the
     Arc Labs dashboard under Settings → Providers.
```

The `retry:` line is the part that changes agent behaviour. Left to infer it, an
agent either retries a terminal failure until it gives up and tells the user
their data was lost, or abandons a transient one that would have succeeded a
second later. The two conditions that are easiest to confuse are kept
distinct on purpose: `llm_credential.missing` (409, terminal, needs an admin)
and `llm_credential.unavailable` (503, transient, needs nothing).

All twelve codes `brain-edge` can emit have their own guidance; a code it grows
later renders as `(unrecognised)` with a status-derived verdict rather than
being passed through silently. The mapping and its drift guard live in
`src/server/result.ts` and `test/server/errors.test.ts`.

## License

Apache-2.0.
