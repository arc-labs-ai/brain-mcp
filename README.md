# brain-mcp

A **managed MCP server** for the [Brain](https://github.com/arc-labs-ai) memory
database. It exposes a deliberately tiny tool surface — `remember`, `recall`,
`forget`, `whoami` — over **remote Streamable HTTP**, so any MCP client (Claude,
ChatGPT, Cursor, Copilot, …) can give its agent durable, current-truth memory in
one connection.

It is a thin, stateless front for Brain's REST surface (`/v1/*`): point it at the
hosted **gateway** or a self-hosted **brain-edge** — the JSON contract is the
same. Every tool is scoped to a `customer_id`, so one deployment serves many
isolated end customers.

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
| `BRAIN_MCP_SCOPE_HEADER` | no | `x-brain-agent` | Per-customer scope header. |
| `BRAIN_MCP_PORT` | no | `3333` | Listen port. |
| `BRAIN_MCP_HOST` | no | `0.0.0.0` | Bind interface. |
| `BRAIN_MCP_REQUEST_TIMEOUT_MS` | no | `30000` | Per-request backend timeout. |

## Auth

**M1 (current):** the server holds one bearer API key for the backend; the MCP
endpoint itself is unauthenticated, so run it behind your own gateway/network
boundary. Per-customer isolation rides the scope headers.

**M2 (planned):** OAuth 2.1 (PKCE + authorization-server metadata + dynamic
client registration) on the MCP endpoint, so an MCP client authorizes directly
and its token maps to a tenant — the enterprise-review differentiator.

## License

Apache-2.0.
