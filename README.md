# brain-mcp

A **managed MCP server** for the [Brain](https://github.com/arc-labs-ai) memory
database. It exposes a deliberately tiny tool surface — `remember`, `recall`,
`forget`, `whoami` — over **remote Streamable HTTP**, so any MCP client (Claude,
ChatGPT, Cursor, Copilot, …) can give its agent durable, current-truth memory in
one connection.

It is a thin, stateless front for Brain's REST surface (`/v1/*`): point it at the
hosted **gateway** or a self-hosted **brain-edge** — the JSON contract is the
same. Every tool takes a `customer_id` for per-customer isolation (see
[Scoping](#scoping) for how that behaves on each backend).

## Tools

| Tool | Args | What it does |
|---|---|---|
| `remember` | `customer_id`, `content` | Store a fact/event/turn; Brain extracts typed facts and supersedes stale ones. Returns the memory id. |
| `recall` | `customer_id`, `query`, `max_results?` | Current, consistent truth with evidence + confidence (single / many / none). |
| `forget` | `customer_id`, `memory_id`, `hard?` | Soft tombstone (default) or hard zero; cascades to dependents. |
| `whoami` | `customer_id` | The effective identity (namespace + customer scope) a request runs as. |

The surface is intentionally small — tool-definition bloat is the top reason
agents uninstall a server. Richer typed-graph queries live behind the SDK/REST.

## Run

```bash
npm install
cp .env.example .env      # set BRAIN_MCP_BACKEND_URL / _API_KEY / _NAMESPACE
npm run build
npm start                 # listens on :3333, MCP endpoint at POST /mcp
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
| `BRAIN_MCP_PORT` | no | `3333` | Listen port. |
| `BRAIN_MCP_HOST` | no | `0.0.0.0` | Bind interface. |
| `BRAIN_MCP_REQUEST_TIMEOUT_MS` | no | `30000` | Per-request backend timeout. |

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

## License

Apache-2.0.
