import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import type { Server } from 'http'
import type { OpenAPIV3 } from 'openapi-types'
import { HttpClient } from '../http-client'
import { OpenAPIToMCPConverter } from '../../openapi/parser'
import { startTestServer, stopTestServer } from './test-server'

/**
 * Fork patch guard (the shapes `API-patch-block-children` documents).
 *
 * The bundled spec named only four block types - paragraph, bulleted list item,
 * image and file. Headings, to-dos, code blocks and quotes still went through,
 * but only because the converter widens every array item with a permissive
 * `{object, additionalProperties: true}` branch, so nothing in the tool told a
 * caller what shape those types need: getting one right was guesswork answered
 * by a live 400. The three heading levels, `to_do`, `code` and `quote` are now
 * named schemas beside the original four, the same treatment `API-update-a-block`
 * already had.
 *
 * The addition is purely additive, and these tests pin both halves of that: the
 * new types are described, and the catch-all that carries every remaining type
 * (`numbered_list_item`, `toggle`, `callout`, `divider`, ...) is still there.
 */
describe('append block children (fork patch)', () => {
  const specPath = path.resolve(process.cwd(), 'scripts/notion-openapi.json')
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf-8')) as OpenAPIV3.Document
  const { tools, openApiLookup } = new OpenAPIToMCPConverter(spec).convertToMCPTools()
  const toolFor = (name: string) => {
    const method = tools['API']?.methods.find((m) => m.name === name)
    expect(method, `tool ${name} is missing`).toBeDefined()
    return method!
  }

  // The converter rewrites component refs to `#/$defs/...` and wraps each array
  // item in an anyOf, so a branch has to be dug out and its ref followed.
  const deref = (schema: any, defs: Record<string, any>): any =>
    schema?.$ref ? defs[schema.$ref.replace('#/$defs/', '')] : schema
  const itemBranches = (schema: any, defs: Record<string, any>): any[] => {
    const items = schema.properties.children.items
    // items = anyOf[ blockObjectRequest, string, catch-all object ]; the first
    // branch is itself an anyOf over the named block schemas.
    const outer: any[] = items.anyOf ?? [items]
    return outer.flatMap((branch) => {
      const resolved = deref(branch, defs)
      return resolved?.anyOf ? resolved.anyOf.map((b: any) => deref(b, defs)) : [resolved]
    })
  }

  describe('tool surface', () => {
    const schema = () => toolFor('patch-block-children').inputSchema as any

    it('names a schema for every block type an agent commonly appends', () => {
      const s = schema()
      const named = itemBranches(s, s.$defs ?? {})
        .flatMap((branch) => Object.keys(branch?.properties ?? {}))
        .filter((key) => key !== 'type')

      for (const blockType of [
        'paragraph',
        'heading_1',
        'heading_2',
        'heading_3',
        'bulleted_list_item',
        'to_do',
        'quote',
        'code',
        'image',
        'file',
      ]) {
        expect(named, `${blockType} has no named schema`).toContain(blockType)
      }
    })

    it('keeps the catch-all, so an undocumented block type is still accepted', () => {
      const s = schema()
      const branches = itemBranches(s, s.$defs ?? {})

      // A branch that accepts any object is what carries numbered_list_item,
      // toggle, callout, divider and everything else Notion adds later.
      expect(
        branches.some((branch) => branch?.type === 'object' && branch?.additionalProperties === true),
      ).toBe(true)
    })

    it('asks a to_do for its text and lets the box be ticked up front', () => {
      const s = schema()
      const toDo = itemBranches(s, s.$defs ?? {}).find((branch) => branch?.properties?.to_do)?.properties?.to_do

      expect(toDo?.properties?.checked?.type).toBe('boolean')
      expect(toDo?.properties?.rich_text).toBeDefined()
      // A to-do with no text is an empty line, so unlike an edit the text is required.
      expect(toDo?.required ?? []).toContain('rich_text')
    })

    it('tells a code block which language names are allowed', () => {
      const s = schema()
      const code = itemBranches(s, s.$defs ?? {}).find((branch) => branch?.properties?.code)?.properties?.code

      expect(code?.required ?? []).toContain('rich_text')
      expect(code?.properties?.language?.type).toBe('string')
      expect(code?.properties?.language?.description).toContain('plain text')
      expect(code?.properties?.caption).toBeDefined()
    })

    it('offers the heading fields Notion actually accepts', () => {
      const s = schema()
      const defs = s.$defs ?? {}
      // The three heading levels share one content schema, so this arrives as a $ref.
      const heading = deref(
        itemBranches(s, defs).find((branch) => branch?.properties?.heading_1)?.properties?.heading_1,
        defs,
      )

      expect(heading?.required ?? []).toContain('rich_text')
      expect(heading?.properties?.is_toggleable?.type).toBe('boolean')
      expect(heading?.properties?.color?.type).toBe('string')
    })

    it('resolves every ref the new schemas introduced', () => {
      const method = toolFor('patch-block-children')
      const defs = (method.inputSchema as any).$defs ?? {}
      const refs = JSON.stringify(method.inputSchema).match(/"#\/\$defs\/([^"]+)"/g) ?? []

      expect(Object.keys(defs)).toContain('richTextRequest')
      for (const ref of refs) {
        const name = ref.replace('"#/$defs/', '').replace('"', '')
        expect(defs[name], `dangling $ref to ${name}`).toBeDefined()
      }
    })

    it('is still an append, not an edit', () => {
      expect(openApiLookup['API-patch-block-children']?.method).toBe('patch')
      expect(toolFor('patch-block-children').description).toContain('API-update-a-block')
    })
  })

  describe('over the wire', () => {
    let server: Server
    let baseUrl: string
    let received: { url: string; body: any } | undefined

    beforeEach(async () => {
      received = undefined
      const app = express()
      app.use(express.json())
      app.patch('/v1/blocks/:block_id/children', (req, res) => {
        received = { url: req.originalUrl, body: req.body }
        res.status(200).json({ object: 'list', results: [] })
      })
      ;({ server, baseUrl } = await startTestServer(app))
    })

    afterEach(async () => {
      await stopTestServer(server)
    })

    // Point the spec at the throwaway server so nothing can reach the real API.
    const localSpec = () => ({ ...spec, servers: [{ url: baseUrl }] }) as OpenAPIV3.Document
    const route = '/v1/blocks/{block_id}/children'
    const operation = () =>
      ({
        ...(spec.paths![route]!.patch as OpenAPIV3.OperationObject),
        method: 'patch',
        path: route,
      }) as any

    it('sends a to_do and a code block through unchanged', async () => {
      const client = new HttpClient({ baseUrl }, localSpec())
      const children = [
        { to_do: { rich_text: [{ text: { content: 'Ship the fix' } }], checked: false } },
        { code: { rich_text: [{ text: { content: 'print("hi")' } }], language: 'python' } },
      ]

      await client.executeOperation(operation(), { block_id: 'page-id', children })

      expect(received?.url).toBe('/v1/blocks/page-id/children')
      expect(received?.body?.block_id).toBeUndefined()
      expect(received?.body).toEqual({ children })
    })

    it('still passes an undocumented block type straight through', async () => {
      const client = new HttpClient({ baseUrl }, localSpec())
      const children = [{ numbered_list_item: { rich_text: [{ text: { content: 'First' } }] } }]

      await client.executeOperation(operation(), { block_id: 'page-id', children })

      expect(received?.body).toEqual({ children })
    })
  })
})
