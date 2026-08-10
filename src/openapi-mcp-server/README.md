# openapi-mcp-server (vendored)

This directory converts Notion's OpenAPI spec into MCP tools and executes the
underlying API calls. It is a **vendored fork** of v1 of
[`snaggle-ai/openapi-mcp-server`](https://github.com/snaggle-ai/openapi-mcp-server)
(MIT). See [`LICENSE`](./LICENSE) for the upstream copyright notice.

## Why it's vendored (and why we keep it)

Upstream took a different direction in v2 — it became an API *discovery*
meta-tool and is no longer a one-tool-per-endpoint converter — so there is no
upgrade path. We own this code deliberately. It is small, has no external
runtime dependencies of its own beyond what the server already ships, and
encodes **Notion-specific behavior** that off-the-shelf OpenAPI→MCP libraries do
not reproduce:

- `"Notion | "` prefix on tool descriptions (`parser.ts`, `getDescription`).
- Tool descriptions carry **both** the operation's `summary` and its
  `description` (`parser.ts`, where `description` is built). Upstream showed
  only the first one present, and since every Notion operation has a `summary`,
  everything written in `description` was dropped before it reached the agent.
  Both fields are therefore live documentation — write guidance in either.
- Tolerance for clients that double-serialize nested JSON params: complex
  schemas are widened to `anyOf: [schema, string]` (`parser.ts`,
  `withStringFallback`) and decoded at call time (`proxy.ts`, `deserializeParams`).
  See issues [#176](https://github.com/makenotion/notion-mcp-server/issues/176)
  and [#208](https://github.com/makenotion/notion-mcp-server/issues/208).
- `readOnly` / `destructive` tool annotations derived from the HTTP method
  (`proxy.ts`).
- Multipart/file-upload operations mapped to local-file-path string params
  (`parser.ts` binary handling, `file-upload.ts`).
- 64-char tool-name truncation with a uniqueness suffix (`parser.ts`,
  `ensureUniqueName`). Note this bounds the *operation* name only; `proxy.ts`
  truncates again once the `API-` prefix is added (`truncateToolName`), so the
  name `tools/list` advertises can still differ from the full one. The proxy
  constructor therefore registers both spellings in `openApiLookup` and
  `inputSchemas` — drop the alias and any tool over 64 characters is listed but
  fails to be called with "Method not found".

## Changing it safely

`openapi/__tests__/notion-spec.snapshot.test.ts` snapshots the tools generated
from the real `scripts/notion-openapi.json` spec (names, descriptions, parameter
surface). If a change alters the public tool surface, that snapshot will fail —
review the diff and update with `vitest -u` only if the change is intentional.
