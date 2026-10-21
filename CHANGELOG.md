# Changelog

## 0.1.0 (2026-10-21)


### ⚠ BREAKING CHANGES

* **mcp:** failed tool calls no longer render as a single `error: brain backend returned <status>: <body>` line. A client scraping that text must read the `code:` and `retry:` lines instead.

### Features

* brain-mcp M1 — managed MCP server over Streamable HTTP ([e77aa74](https://github.com/arc-labs-ai/brain-mcp/commit/e77aa74275014ae7eb0d9f04930e90d251e380f5))
* **mcp:** default scope header to x-brain-space ([85b3b58](https://github.com/arc-labs-ai/brain-mcp/commit/85b3b584c1360bf73ac9dd9e24cfffce293f7582))
* **mcp:** full tenant surface, modular layout, and a real error contract ([cfd0b82](https://github.com/arc-labs-ai/brain-mcp/commit/cfd0b827a158952a92b9a72d224f2ac2749f09ed))
* **mcp:** M2 — OAuth 2.1 resource server with per-tenant token routing ([6c429ec](https://github.com/arc-labs-ai/brain-mcp/commit/6c429ec76f9e697e0bc4264b017f1ae6848be57b))


### Tests and verification

* **mcp:** end-to-end /v1/* contract coverage + self-host scoping note ([d8246d0](https://github.com/arc-labs-ai/brain-mcp/commit/d8246d0b2c4bd9575bbe15cfb22a22b6868690bb))


### Build and tooling

* add CI and release wiring for npm publishing ([afab4ff](https://github.com/arc-labs-ai/brain-mcp/commit/afab4ffab5fe5aeb63d879cf7d38b315ddcb9074))


### Chores

* **release:** pin the first npm release to 0.1.0 ([5899996](https://github.com/arc-labs-ai/brain-mcp/commit/589999625eedfda283c9feb88f95795a5a498de7))
