import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { OpenAPIV3 } from 'openapi-types'
import { OpenAPIToMCPConverter } from '../parser'

/**
 * A tool used to describe only how it can fail.
 *
 * The generated description carried an `Error Responses:` block and nothing
 * about a successful one, and `returnSchema` — which the converter has always
 * computed — never leaves the server, because `MCPProxy` sends a tool's name,
 * description and inputSchema only. So the shape of a result was something an
 * agent discovered by calling the tool and reading what came back, and the
 * bundled spec did not know it either: 33 of 37 operations declared their 200
 * as a bare `{"type": "object"}`.
 *
 * Two things fix that and both are pinned here: the spec now carries real
 * response schemas for the operations that get used, and the converter renders
 * a `Returns:` section into the description, which is the part that actually
 * reaches the caller. Declaring an MCP `outputSchema` instead would oblige
 * every response to carry matching `structuredContent`, which this proxy does
 * not produce — hence documentation rather than a contract change.
 */
describe('successful-response documentation', () => {
  const specPath = path.resolve(process.cwd(), 'scripts/notion-openapi.json')
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf-8')) as OpenAPIV3.Document
  const { tools } = new OpenAPIToMCPConverter(spec).convertToMCPTools()
  const methods = tools['API']?.methods ?? []
  const byName = (name: string) => methods.find((m) => m.name === name)

  // One per response component the spec defines, so a dropped `$ref` fails
  // here rather than silently reverting a tool to "returns an object".
  const DOCUMENTED: Array<[operation: string, mentions: string]> = [
    ['retrieve-a-page', 'properties: object'],
    ['post-page', 'properties: object'],
    ['patch-page', 'properties: object'],
    ['retrieve-a-block', 'has_children: boolean'],
    ['get-block-children', 'results: array of object'],
    ['patch-block-children', 'has_more: boolean'],
    ['query-data-source', 'next_cursor: string'],
    ['post-search', 'results: array of object'],
    ['retrieve-a-data-source', 'properties: object'],
    ['retrieve-a-database', 'data_sources: array of object'],
    ['create-a-file-upload', 'upload_url: string'],
    ['send-a-file-upload', 'content_length: integer'],
  ]

  it.each(DOCUMENTED)('%s says what a successful call returns', (operation, mentions) => {
    const method = byName(operation)
    expect(method, `${operation} is missing from the generated tools`).toBeDefined()
    expect(method!.description).toContain('\nReturns:\n')
    expect(method!.description).toContain(mentions)
  })

  it('keeps the error responses alongside the new section', () => {
    const description = byName('retrieve-a-page')!.description
    expect(description).toContain('Error Responses:')
    expect(description.indexOf('Returns:')).toBeLessThan(description.indexOf('Error Responses:'))
  })

  it('derives the shape from the spec example when no schema is declared', () => {
    // These three document their result only as an example — a real Notion
    // response, so its top-level keys are the shape.
    const created = byName('create-a-comment')!
    expect(created.description).toContain('discussion_id: string')
    expect(created.description).toContain('rich_text: array of object')

    const listed = byName('retrieve-a-comment')!
    expect(listed.description).toContain('results: array of object')
    expect(listed.description).toContain('has_more: boolean')
  })

  it('adds nothing for an operation whose 200 is still the bare placeholder', () => {
    // The view tools were added with the spec's generic `{"type": "object"}`
    // response. A line naming no fields would be noise, so there is none.
    expect(byName('list-views')!.description).not.toContain('Returns:')
  })

  it('leaves returnSchema pointing at the shared component', () => {
    const returnSchema = byName('retrieve-a-page')!.returnSchema as Record<string, unknown>
    expect(returnSchema.$ref).toBe('#/$defs/pageObjectResponse')
    expect(Object.keys(returnSchema.$defs as object)).toEqual(['pageObjectResponse'])
  })
})
