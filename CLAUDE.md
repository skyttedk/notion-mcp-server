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

Code-side fork fixes are marked with a `Fork fix`/`Fork guard` comment in
`src/openapi-mcp-server/client/http-client.ts` (remote-source `prepareFileUpload`,
content-type preservation, truncated-upload guard, incomplete-payload guard) and
in `src/openapi-mcp-server/openapi/parser.ts` (tool descriptions carry both
`summary` and `description`).

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
