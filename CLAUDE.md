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
- **Editing a block's text:** `API-update-a-block` (`PATCH
  /v1/blocks/{block_id}`) declared its whole body as one empty-`properties`
  object named `type`. `HttpClient` sends every declared body property verbatim
  at the top level, so the payload left as `{"type": {...}}` - one level too
  deep - and Notion rejected every call with a validation error naming each
  block type as undefined. Only `archived` ever worked, which left the tool able
  to delete and restore a block but never to edit one; correcting a typo meant
  appending a fixed copy and archiving the original, changing the block's id and
  leaving a tombstone in the page's trash. The block-type keys now sit at the
  top level beside `archived` - `paragraph`, `heading_1`..`heading_3`,
  `bulleted_list_item`, `numbered_list_item`, `toggle`, `quote`, `callout`,
  `code` via the new `blockTextUpdateRequest`, and `to_do` via
  `toDoBlockUpdateRequest`, which also carries `checked` and requires neither
  field so a box can be ticked without rewriting its text. Same nesting
  convention `API-patch-block-children` already used, and no client change was
  needed. Notion only updates text and `checked`: a key naming a different type
  than the block's own fails with a 400 "Block type mismatch", so a block cannot
  be converted this way. Verified against the live API 2026-08-09 (text
  corrected in one call, a to-do ticked with its wording intact, the mismatch
  400 observed). Guarded by
  `src/openapi-mcp-server/client/__tests__/update-block.test.ts`.
- **The shapes `API-patch-block-children` documents:** the spec named only four
  block types - `paragraph`, `bulleted_list_item`, `image`, `file`. Headings,
  to-dos, code blocks and quotes went through anyway, but only because
  `withStringFallback` widens every array item with a permissive
  `{object, additionalProperties: true}` branch, so nothing in the tool told a
  caller what shape those needed and getting one right was guesswork answered by
  a live 400. `heading_1`..`heading_3` (sharing `headingBlockContentRequest`),
  `to_do`, `code` and `quote` are now named schemas beside the original four,
  and the operation says how a block object is put together. Purely additive:
  the catch-all still carries `numbered_list_item`, `toggle`, `callout`,
  `divider` and anything Notion adds later. Note the deliberate difference from
  `API-update-a-block`: appending requires `rich_text` (a block with no text is
  an empty line), whereas an edit does not (a to-do's box can be ticked without
  rewriting its wording). Guarded by
  `src/openapi-mcp-server/client/__tests__/append-block-children.test.ts`.
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
- **Creating a database:** `API-create-a-database` (`POST /v1/databases`) and
  `API-update-a-database` (`PATCH /v1/databases/{database_id}`). The bundled spec
  had only the `get`, so the namespace could read a database and rewrite its
  schema but never make one - which blocked provisioning a new PM board through
  the gateway at all. The tool that looked like it should was
  `create-a-data-source`, whose bundled description read "Create a new data
  source (database)" and whose parent was a **page**; on API version 2025-09-03
  and later Notion rejects exactly that shape with *"Creating new databases with
  data sources is not supported in this endpoint. Use the Create Database API
  instead."* So it is retitled **"Add a data source to an existing database"**
  and now takes a **database** parent - verified against the live API 2026-08-19,
  a database parent is accepted and a second data source really is created. The
  create-a-database response is the existing `databaseObjectResponse`, which
  matters: the caller needs `id` **and** `data_sources[0].id`, they are different
  values, and `API-create-a-view` wants both. Guarded by
  `client/__tests__/capability-gaps.test.ts` section 4.
- **Native status properties are creatable through the API** - Notion's own
  documentation says they are not, and that is wrong. Verified against the live
  API 2026-08-19 on a throwaway database: `{"Stage": {"status": {}}}` in a
  property schema creates a real native status property carrying Notion's default
  options (Not started / In progress / Done) already sorted into the To-do /
  In progress / Complete groups, and custom `options` keep their names and
  colours. **Group membership is the part that does not work:** the three groups
  are always created, but every custom option lands in To-do, and
  `groups[].option_ids` is ignored - sent at creation *or* in a later
  `API-update-a-data-source` call it returns 200 and changes nothing. (Adding
  options to an already-existing status property does work, verified
  2026-08-06.) Converting an existing select into a status stays UI-only. All of
  this is stated in `create-a-database`'s own description, because the silence is
  what cost every caller the same experiment - keep it there.

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
`summary` and `description`; `$defs` pruning, below) and in
`src/openapi-mcp-server/mcp/proxy.ts` (schema-aware JSON unwrapping, below).

### JSON-looking text stays text (schema-aware unwrapping)

`deserializeParams` in `proxy.ts` decodes double-serialized parameters, the
upstream workaround for clients that send nested objects as JSON strings
(issues #176/#208). It used to walk the argument tree schema-blind: *any* string
that trimmed to `{...}` or `[...]` was `JSON.parse`d and, if it decoded to a
container, replaced by it. So a paragraph whose text merely quoted a JSON
snippet became an object, and Notion rejected the append with
"…should be a string" - correctly, since `richTextRequest.text.content` really
is `type: string`. Appending `[1, 2]` as text had the same fate.

The walk is now guided by the tool's own `inputSchema`: a string is decoded only
where the schema at that exact path permits an object or an array. `$ref`s are
followed into the tool's (pruned) `$defs` and `anyOf`/`oneOf`/`allOf` are
expanded, so `blockObjectRequest`'s four branches resolve.

Two things to know before touching it:

- **The string branch is not evidence.** `withStringFallback` in `parser.ts`
  wraps every complex top-level property in `anyOf: [complex, {type: string}]`
  precisely so a double-serialized object passes validation. Reading that as
  "the schema wants a string here" would disable the unwrap everywhere. The
  question asked is therefore "can this position hold structure?", never "does
  some branch allow a string?".
- **A position no schema describes keeps the old eager behaviour**, so #176/#208
  still work for free-form maps - notably `properties` on `API-post-page`, which
  the spec declares `additionalProperties: true`. Text that must survive
  verbatim belongs in a block, where the schema is precise. When descending into
  a key, branches that *name* the property win over a sibling
  `additionalProperties: true` branch; without that rule the converter's own
  catch-all item branch would make every key unconstrained again.

`proxy.test.ts` → `schema-aware unwrapping (fork fix)` pins both directions
against the real bundled spec, including that free-form limit.

### Notion's union errors, rewritten (`mcp/validation-error.ts`)

When Notion cannot tell which variant of a union was meant it answers with
`body failed validation. Fix one:` and one line per variant - up to 34 of them,
none naming the actual mistake. `formatValidationError` compacts that into a
first line stating the mismatch and one trailing line of alternatives; any
message that is already precise is returned untouched.

**The `properties` map has two forms, and mixing them is what that shape usually
means.** Notion accepts a page property wrapped (`{"Tokens": {"number": 4}}`)
*or* in shorthand (`{"Tokens": 4}`, `{"Priority": {"name": "Low"}}`) - and
validates the **whole map** in one form or the other. One `API-patch-page` call
carrying both therefore 400s, blaming whichever entry is *wrapped* and listing
the shorthand union's keys (`id, name, start, lat, state` - a select option, a
date, a location, a verification), which describe neither the property sent nor
the shorthand entry that actually caused it. Verified against the live API
2026-08-13: wrapped + wrapped succeeds, shorthand + shorthand succeeds, only the
mix fails. `explainMixedPropertyForms` recognises it from the arguments sent and
names both properties and both ways out. The detection is deliberately
conservative - `null`, `undefined` and `{}` count as neither form, since clearing
a property looks the same either way - so an unrecognised case falls back to the
generic summary rather than inventing a mix.

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

### Tools say what a successful call returns

A generated description used to document only how a call can *fail*. The
`Error Responses:` block was there, nothing described a success, and
`returnSchema` - which the converter has always computed - never leaves the
server, because `MCPProxy` sends a tool's name, description and inputSchema
only. So an agent learned the shape of a result by calling the tool and reading
what came back, and the bundled spec did not know it either: 33 of 37
operations declared their 200 as a bare `{"type": "object"}`.

Both halves are fixed. The spec carries **response component schemas**
(`pageObjectResponse`, `blockObjectResponse`, `paginatedListResponse`,
`dataSourceObjectResponse`, `databaseObjectResponse`,
`fileUploadObjectResponse`) referenced from the 18 most-used operations, with
the fields read off live Notion responses rather than guessed. The converter
renders them into the description as a `Returns:` section - one line naming the
top-level fields and their types - which is the part that actually reaches the
caller. Three comment operations declare no schema at all and only carry an
*example*; that example is a real response, so its top-level keys are inferred
from it (top level only - one instance is not evidence for anything deeper).

**Why documentation and not an MCP `outputSchema`:** declaring one obliges every
response to carry matching `structuredContent`, and this proxy returns the
Notion payload as text. Adding the field alone would make a validating client
reject every call. Cost of the section: descriptions grew ~7.6 KB across the 37
tools; an operation still on the placeholder gets no section rather than a line
naming no fields. Pinned by `parser-response-shape.test.ts`.

### The resolved-schema cache is keyed on the mode, not just the ref

`convertOpenApiSchemaToJsonSchema` memoises each resolved `$ref`, and the key
used to be the ref string alone - while the result also depends on
`resolveRefs` (inline the target, or leave a `#/$defs/...` pointer) and on
`resolvedRefs` (the set of refs already open, used to cut recursion). So the
first caller decided the schema for every later one, in whichever mode it
happened to want, and a schema *truncated* to break a cycle was cached and
handed to callers starting from a clean set.

The mode is now part of the key, and a conversion that made a cut is not cached
at all (`cycleCuts` counts them). Nothing hit either case: every call site
outside the converter passes `resolveRefs: false`, and every Notion ref lives
under `#/components/schemas/`, which returns before the cache is consulted -
only a ref elsewhere (a Swagger-style `#/definitions/...`) falls through to it.
`parser-schema-cache.test.ts` exercises both on that path. The dead `refSchema`
that upstream built beside the lookup and never read is gone with it.

**And the cache never shares an object.** It used to store what it returned and
return what it stored, so a caller writing into its result wrote into the cache
- and callers do write into it: `convertOperationToMCPMethod` sets
`.description` on a parameter schema, `extractResponseSchema` on a response
schema. One such write would then be served to every other tool resolving the
same ref, with nothing at the mutation site pointing at the cause. Reads and
writes now go through `copySchema` (`structuredClone`; a spread would still
share every nested `properties`/`items`/`oneOf` subtree), so the stored object
is never the object anyone holds. **Identity is no longer evidence of a cache
hit** - the "converted once" test counts `internalResolveRef` calls instead.
The clone costs nothing on the Notion spec today: measured over a full
`convertToMCPTools()`, the cache takes 0 entries and serves 0 hits, for the
`#/components/schemas/` reason above. A spec that does reach it pays one deep
copy per hit, which is the intended trade - a shared reference is wrong, and
cheaply so.

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
short. The second one no comparison against Notion can catch - the byte counts
agree because the fragment is all there ever was.

**Inference alone cannot settle the second one, so the send tool takes a
`content_length` of its own** - the source file's size in bytes, checked against
what actually arrived and refused on any mismatch. It is this server's check,
never forwarded to Notion, and it is consulted *before* the format check,
because a file can be missing bytes in the middle and still end with its
format's end-of-file marker. Agents should always send it; the parameter
description says so.

The inference is the fallback when they do not, and each rule covers a different
gap. Decoded bytes are checked against the file format's own end-of-file marker
(PNG `IEND`, JPEG `FFD9`, GIF `3B`, PDF `%%EOF`), and the encoding against
base64 shapes that cannot be complete. **What was missing, and cost a second
incident:** a cut that lands on a base64 group boundary produces a string with a
whole number of groups that decodes cleanly, so no length rule objects - a
3,371-byte file arrived as exactly 3,316 characters, stored as 2,487 bytes, and
was reported as a success. Terminal `=` padding is the tell (an encoder emits it
whenever the length is not a multiple of three, so a padded string ran to the
end), and where there is neither padding, nor a format whose end we recognise,
nor a declared `content_length`, nothing can vouch for the payload and it is
refused rather than stored. That refusal applies from 1 KB up: two thirds of
files are padded and provable anyway, and refusing every small unpadded one
would reject a third of all notes and icons to guard against a cut that does not
happen inside a single message.

The guard tests live in `src/openapi-mcp-server/client/__tests__/comment-attachments.test.ts`,
`update-comment.test.ts`, `update-block.test.ts`,
`http-client-upload.test.ts`, `http-client.upload-integrity.test.ts` and the tool-surface snapshot in
`src/openapi-mcp-server/openapi/__tests__/notion-spec.snapshot.test.ts` - if a
bump drops a patch, those fail rather than the capability disappearing quietly.

### Telling inline bytes from a file path (`isBareBase64`)

A `file` parameter reaches a hosted deployment as one string, and nothing in the
protocol says whether it names a path or *is* the bytes. `isBareBase64` in
`http-client.ts` decides, and every time it has guessed "path" for real base64
the caller got `no such file on the machine running this server` - a filesystem
error about a value that never named a file, and one that reads as "attaching a
file does not work". Three dimensions have each caused that incident in turn:
whitespace (encoders wrap their output), the alphabet (base64url spells the same
bytes with `-`/`_`), and **length**.

The length rule accepted a multiple of four, or 100+ characters. An encoder that
omits the padding leaves 4n+2 or 4n+3 characters, so a small file - the common
case for base64url, and for standard base64 piped through `tr -d '='` - matched
neither and was refused. Those two lengths are now accepted too, unless the value
`looksLikeWrittenName`: it contains a `/`, or it carries neither an uppercase
letter nor a `+`. Filenames are lowercase words and separators; base64 over real
file bytes almost always has an uppercase letter or a `+`, and the odds compound
with every group. A 4n+1 length stays a path - no encoder can emit one.

**That widening was deliberately additive: `looksLikeWrittenName` decides only
the two newly admitted lengths**, because those were refused outright before, so
a veto there can only restore the old answer. On the 4n length - accepted since
the fork's first version - the same two signals are not enough on their own: `/`
is a legal standard-base64 character, and all-lowercase base64 of a few bytes is
genuine often enough to matter (~12% of 3-byte payloads, ~3% of 6-byte ones).

**The 4n case has its own veto, `readsAsMistypedName`, and it needs all four of
its conditions.** Before it, a short lowercase extensionless name whose length
happened to be a multiple of four - `my-notes`, `project-plan` - was charset-valid
base64, so a mistyped path was decoded to junk bytes, uploaded, and reported as a
success. The four conditions: at most **16 characters** (12 decoded bytes), **no
`=` padding** (an encoder's signature, never part of a filename),
`looksLikeWrittenName`, and the decoded bytes do **not** look like content - no
known file header (PNG/JPEG/GIF/PDF/ZIP/UTF-8 BOM) and not valid UTF-8 that is
≥87% printable. A declared `content_length` switches the veto off entirely: the
caller has said the value is the bytes and how many, and a wrong reading would be
caught by the length check rather than stored.

Two of those conditions are load-bearing in ways that are easy to undo:

- **The 16-character cap is not tuning, it is the boundary between two
  populations.** "No uppercase and no `+`" is sound for base64 over *random*
  bytes but not over *structured* ones: the repo's own base64url fixture, 24
  bytes of `0xff 0xef 0xbf`, encodes to 32 all-lowercase characters of genuine
  payload. A cap of 32 (the first draft) would have refused it. Payloads that
  regular are never 12 bytes long; a mistyped path is a short word. Raising the
  cap moves the veto into real-payload territory.
- **The magic-prefix list earns its place on JPEG alone.** Three bytes of JPEG
  header encode to `/9j/` - no uppercase, no `+`, and a `/` - i.e. every name
  signal at once. Without the header check, real image bytes would be read as a
  filename.

**Documented residual, deliberately not chased further:** a genuinely random
binary payload of 3-12 bytes whose base64 is all lowercase and unpadded still
reads as a name and comes back as "no such file". Gate 2 is a heuristic, not a
proof, and no cheap check separates twelve arbitrary bytes from twelve other
arbitrary bytes - entropy scoring was considered and rejected as a false
precision. The error message therefore names the remedy in that case (send it
padded, as a data: URI, or with `content_length`), and the hint is added only
when the value *would* have been read as bytes but for the veto, so an ordinary
missing path keeps its plain message. An existing file on disk always wins over
the base64 reading whatever the name looks like, so stdio callers passing real
paths are untouched.

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

### `npm audit` is blind to prerelease-tagged versions

A clean `npm audit` here does not mean the tree is clean. `multer@1.4.5-lts.1`
sat in `devDependencies` with 8 HIGH GitHub advisories against that exact
version, and audit reported 0 vulnerabilities the whole time: the `-lts.1`
prerelease suffix falls outside npm's semver range matching, so the advisory
ranges never match. It was unimported dead weight from the vendored bootstrap
commit and was removed 2026-08-10. When checking dependencies, cross-check any
version carrying a prerelease tag against the registry or OSV directly.

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

**Snapshot files are pinned to LF in `.gitattributes`** (`*.snap text eol=lf`).
Vitest rewrites `notion-spec.snapshot.test.ts.snap` with LF endings on every run,
while Git for Windows checks it out as CRLF by default (`core.autocrlf=true`
lives in its *system* config, so it applies even with nothing set locally). The
mismatch left `git status` reporting the file modified after every test run
while `git diff` showed nothing at all - the blob is byte-identical once the
endings are normalised, so only the checkout form differed. Don't remove the
line, and don't "fix" a stale CRLF copy by editing the snapshot: check it out
again (`git checkout -- <path>`) and the attribute lands it as LF.

## API Version

Uses Notion API version `2025-09-03` (Data Source Edition). The spec includes both:
- `/v1/databases/{database_id}` - Traditional database endpoints
- `/v1/data_sources/{data_source_id}` - New data source endpoints

Two groups of endpoints pin a newer version per operation instead: the
page-markdown endpoints and `/v1/views*`, both on `2026-03-11`. `HttpClient`
reads the header from each operation's own spec default, so these stay isolated
from the rest of the API.
