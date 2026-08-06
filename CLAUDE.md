# CLAUDE.md

This file provides guidance for Claude Code when working with this repository.

## Project Overview

This is the Notion MCP Server - an [MCP (Model Context Protocol)](https://spec.modelcontextprotocol.io/) server that exposes the [Notion API](https://developers.notion.com/reference/intro) as MCP tools. It auto-generates tools from an OpenAPI specification.

## Architecture

```
scripts/notion-openapi.json    # OpenAPI spec (source of truth for all tools)
        ↓
src/init-server.ts             # Loads & validates spec, creates MCPProxy
        ↓
src/openapi-mcp-server/
├── openapi/parser.ts          # Converts OpenAPI → MCP tools
├── mcp/proxy.ts               # Registers tools with MCP server
└── client/http-client.ts      # Executes API calls
```

## Key Patterns

### Adding New Endpoints

Only modify `scripts/notion-openapi.json`. Tools are auto-generated from the spec - no code changes needed elsewhere.

### Fork patches to the bundled spec (re-apply after any upstream bump)

This fork adds capabilities to `scripts/notion-openapi.json` that upstream's
bundled spec does not expose. **A spec refresh from upstream silently reverts
all of them** - re-apply after every bump:

- **File uploads:** `API-create-a-file-upload`, `API-send-a-file-upload`,
  `API-retrieve-a-file-upload`, plus `imageBlockRequest` / `fileBlockRequest`
  accepting both `external` and `file_upload` sources.
- **Comment attachments:** `attachments` on `create-a-comment` (`POST
  /v1/comments`) - up to 3 entries of `{ file_upload_id, type: "file_upload" }`,
  so a comment can carry a screenshot instead of only text.
- **Correcting a comment:** `API-update-a-comment` (`PATCH
  /v1/comments/{comment_id}`), which Notion has always accepted but the bundled
  description never listed - without it a typo could only be deleted and
  reposted, losing the comment's place in the thread. The new `rich_text`
  replaces the old text entirely.
- **The 2000-character limit, stated:** both comment tools now say that Notion
  caps `text.content` at 2000 characters and the `rich_text` array at 100 runs.
  The cap is **per run, not per comment** (verified against the live API: two
  runs totalling ~2016 characters are accepted), so long text is split across
  runs rather than shortened. Unstated, it surfaced only as a bare 400.
- **The Views API:** `list-views`, `create-a-view`, `retrieve-a-view`,
  `update-a-view`, `delete-a-view`, `create-a-view-query`,
  `get-view-query-results`, `delete-a-view-query`. Notion shipped these in GA and
  the bundled spec predates them, so without the patch a database's *layout* -
  which views exist, how they group, sort and filter, which properties show and
  in what order, card size and compact layout - was unreachable while the
  *schema* was fully manageable. `viewConfigurationRequest` is a union
  discriminated on `type` covering all ten view types; the settings most often
  wanted are `configuration.group_by.hide_empty_groups` (Notion resets it to
  `true` whenever grouping is re-applied, which hides an empty status column such
  as `Open` and makes it undraggable) and board/gallery `card_layout: "compact"` +
  `cover_size`. Guarded by `src/openapi-mcp-server/openapi/__tests__/views-api.test.ts`
  and `client/__tests__/http-client.views.test.ts`.

**Views pin their own API version.** They need `2026-03-11`, while the rest of
the server stays on `2025-09-03`. That is a per-operation `Notion-Version` header
parameter in the spec - the same mechanism the page-markdown endpoints already
use - so it cannot shift the version of any other operation. Notion documents the
Views API as "2025-09-03 or later"; `2026-03-11` is what its own examples use and
so what the field shapes here were read from. Do not "simplify" this by bumping
the spec-wide default: that would move all 29 other operations onto an API
version they were never checked against.

Code-side fork fixes are marked with a `Fork fix`/`Fork guard` comment in
`src/openapi-mcp-server/client/http-client.ts` (remote-source `prepareFileUpload`,
content-type preservation, truncated-upload guard, incomplete-payload guard) and
in `src/openapi-mcp-server/openapi/parser.ts` (tool descriptions carry both
`summary` and `description`; `$defs` pruning, below).

### `$defs` carries only what a tool can reach

`convertOperationToMCPMethod` used to set every tool's `$defs` to the spec's
*entire* component collection, and `extractResponseType` did the same for
`returnSchema`. A shared schema therefore cost its own size once per operation
whether or not anything referenced it - the bill was components x operations.
Measured on the real spec: 119 KB of a 147 KB `tools/list` payload was `$defs`,
and adding the Views API's request schemas took the payload to **813 KB**. This
is a silent cost: nothing errors, every client just pays it on every connection.

`reachableDefs()` walks `$ref`s from the root instead, so the same 29 tools need
5 KB and the branch that adds eight view tools *lowers* the payload to 77 KB. The
walk runs over the already-converted schema (refs rewritten to `#/$defs/...`) and
records a ref before queueing its target, which is what terminates the recursive
schemas - a view filter can nest filters. `parser-defs-pruning.test.ts` pins the
behaviour, including that pruning never leaves a dangling `$ref`.

Watch for this when writing spec tests: an operation with no parameters and no
request body now gets `$defs: {}`, not the whole component collection.

**Both spec fields reach the agent.** Upstream built a tool's description from
`summary || description`, and every Notion operation has a `summary` - so every
word written in `description` was dropped before any agent saw it, including the
file-upload guidance above. The fork joins the two. Write guidance in either
field; neither is dead text. Cost of showing both: the `tools/list` payload grew
149,166 -> 150,874 bytes (+1.1%), the whole list being dominated by parameter
schemas rather than prose.

Two different truncations are guarded, and both were seen in the wild: Notion
storing fewer bytes than we sent (compared against the response's
`content_length`), and the *caller* handing us a payload that was already cut
short. The second one no numeric comparison can catch - the byte counts agree
because the fragment is all there ever was - so the decoded bytes are checked
against the file format's own end-of-file marker (PNG `IEND`, JPEG `FFD9`, GIF
`3B`, PDF `%%EOF`) and against base64 shapes that cannot be complete. Formats
without a self-declared end are uploaded unchecked.

The guard tests live in `src/openapi-mcp-server/client/__tests__/comment-attachments.test.ts`,
`update-comment.test.ts`,
`http-client-upload.test.ts`, `http-client.upload-integrity.test.ts` and the tool-surface snapshot in
`src/openapi-mcp-server/openapi/__tests__/notion-spec.snapshot.test.ts` - if a
bump drops a patch, those fail rather than the capability disappearing quietly.

### The lockfile trap: optional platform packages with their own dependencies

npm prunes the dependencies of optional platform-specific packages it did not
install, but its strict install (`npm ci`) still expects them - so rewriting an
existing lockfile produces one that `npm ci` rejects, and the symptom is a
missing-package error naming something nobody added. That is why adding any
dependency once broke the clean install; regenerating `package-lock.json` from
scratch (2026-08-05) cleared it, because the versions the current ranges resolve
to no longer ship such a build. **npm's bug is not fixed** - any future
dependency that ships an optional platform-specific package carrying its own
dependencies brings the wall straight back, and the fix is the same: delete
`package-lock.json` and regenerate rather than hunting the named package.

### Tool Generation Flow

1. `OpenAPIToMCPConverter.convertToMCPTools()` iterates all paths/operations
2. Each operation becomes an MCP tool (name = `operationId`)
3. Parameters + requestBody → `inputSchema`
4. Response schema → `returnSchema`
5. `MCPProxy.setupHandlers()` registers tools with the MCP SDK

### Naming Conventions

- Tool names come from OpenAPI `operationId` (e.g., `retrieve-a-database`)
- Names are truncated to 64 chars and converted to title case for display

## Common Commands

```bash
npm run build      # TypeScript compilation + CLI bundling
npm test           # Run vitest tests
npm run dev        # Start dev server with hot reload
```

## File Structure

- `scripts/notion-openapi.json` - OpenAPI 3.1.0 spec defining all Notion API endpoints
- `scripts/start-server.ts` - Entry point
- `src/init-server.ts` - Server initialization
- `src/openapi-mcp-server/` - Core MCP server implementation
  - `openapi/parser.ts` - OpenAPI to MCP conversion (529 lines)
  - `mcp/proxy.ts` - MCP tool registration and execution (209 lines)
  - `client/http-client.ts` - HTTP request execution (198 lines)

## Testing

Tests are in `__tests__` directories adjacent to source files. Run with `npm test`.

## API Version

Uses Notion API version `2025-09-03` (Data Source Edition). The spec includes both:
- `/v1/databases/{database_id}` - Traditional database endpoints
- `/v1/data_sources/{data_source_id}` - New data source endpoints

Two groups of endpoints pin a newer version per operation instead: the
page-markdown endpoints and `/v1/views*`, both on `2026-03-11`. `HttpClient`
reads the header from each operation's own spec default, so these stay isolated
from the rest of the API.
