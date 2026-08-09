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
 * Fork patch guard (editing a block's text).
 *
 * `PATCH /v1/blocks/{block_id}` is how Notion corrects the text of a block that
 * is already on a page, but the bundled spec declared the body as a single
 * empty-`properties` object named `type`. `HttpClient` sends every declared body
 * property verbatim at the top level, so the payload left as `{"type": {...}}` -
 * one level too deep - and Notion answered every call with a validation error
 * naming each block type as undefined. Only `archived` ever worked, which left
 * the tool able to delete and restore a block but never to edit one; correcting
 * a typo meant appending a fixed copy and archiving the original, which changes
 * the block's id and leaves a tombstone in the page's trash.
 *
 * The fix is in the spec, not the client: the block-type keys now sit at the top
 * level of the request body, the same shape `API-patch-block-children` already
 * uses for a new block. The wire test is the real guard - it pins that the key
 * an agent sends arrives at the top level of the JSON body - while the tool
 * surface tests catch an upstream bump that reinstates the wrapper.
 */
describe('update a block (fork patch)', () => {
  const specPath = path.resolve(process.cwd(), 'scripts/notion-openapi.json')
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf-8')) as OpenAPIV3.Document
  const { tools, openApiLookup } = new OpenAPIToMCPConverter(spec).convertToMCPTools()
  const toolFor = (name: string) => {
    const method = tools['API']?.methods.find((m) => m.name === name)
    expect(method, `tool ${name} is missing`).toBeDefined()
    return method!
  }
  // The converter wraps every property in an anyOf (structured value | JSON
  // string) and rewrites component refs to `#/$defs/...`, so the structured
  // branch has to be dug out and its ref followed before it can be read.
  const branchesOf = (schema: any): any[] => schema?.anyOf ?? schema?.oneOf ?? [schema]
  const structured = (schema: any, defs: Record<string, any>) => {
    const branch = branchesOf(schema).find((candidate) => candidate?.$ref || candidate?.type === 'object')
    return branch?.$ref ? defs[branch.$ref.replace('#/$defs/', '')] : branch
  }

  describe('tool surface', () => {
    it('takes the block-type keys directly, not a wrapper object', () => {
      const properties = toolFor('update-a-block').inputSchema.properties as Record<string, any>

      for (const blockType of [
        'paragraph',
        'heading_1',
        'heading_2',
        'heading_3',
        'bulleted_list_item',
        'numbered_list_item',
        'toggle',
        'quote',
        'callout',
        'code',
        'to_do',
      ]) {
        expect(properties[blockType], `${blockType} is missing from update-a-block`).toBeDefined()
      }
      expect(properties.block_id).toBeDefined()
      expect(properties.archived).toBeDefined()
      // The wrapper is the bug: anything nested under it never reaches Notion.
      expect(properties.type).toBeUndefined()
    })

    it('sends it as a PATCH, which is what makes it an edit rather than a new block', () => {
      expect(openApiLookup['API-update-a-block']?.method).toBe('patch')
    })

    it('says in the tool description that the new text replaces the old one', () => {
      // `summary` is what the converter turns into the tool description, so this
      // is the text an agent actually reads before calling.
      expect(toolFor('update-a-block').description.toLowerCase()).toContain('replaces')
    })

    it('carries a to_do that can be ticked without rewriting its text', () => {
      const schema = toolFor('update-a-block').inputSchema as any
      const toDo = structured(schema.properties.to_do, schema.$defs ?? {})

      expect(toDo?.properties?.checked).toBeDefined()
      expect(toDo?.properties?.rich_text).toBeDefined()
      // Either field alone is a valid edit, so neither may be required.
      expect(toDo?.required ?? []).toEqual([])
    })

    it('requires the text when a text block is being edited', () => {
      const schema = toolFor('update-a-block').inputSchema as any
      const paragraph = structured(schema.properties.paragraph, schema.$defs ?? {})

      expect(paragraph?.required ?? []).toContain('rich_text')
    })

    it('resolves the shared text schema rather than leaving a dangling $ref', () => {
      // `$defs` is pruned to what the tool can reach, so a ref added here has to
      // arrive with its target and its target's own refs.
      const method = toolFor('update-a-block')
      const defs = (method.inputSchema as any).$defs ?? {}
      const refs = JSON.stringify(method.inputSchema).match(/"#\/\$defs\/([^"]+)"/g) ?? []

      expect(Object.keys(defs)).toContain('blockTextUpdateRequest')
      expect(Object.keys(defs)).toContain('richTextRequest')
      for (const ref of refs) {
        const name = ref.replace('"#/$defs/', '').replace('"', '')
        expect(defs[name], `dangling $ref to ${name}`).toBeDefined()
      }
    })
  })

  describe('over the wire', () => {
    let server: Server
    let baseUrl: string
    let received: { method: string; url: string; blockId: string; body: any } | undefined

    beforeEach(async () => {
      received = undefined
      const app = express()
      app.use(express.json())
      app.patch('/v1/blocks/:block_id', (req, res) => {
        received = { method: req.method, url: req.originalUrl, blockId: req.params.block_id, body: req.body }
        res.status(200).json({ object: 'block', id: req.params.block_id })
      })
      ;({ server, baseUrl } = await startTestServer(app))
    })

    afterEach(async () => {
      await stopTestServer(server)
    })

    // Point the spec at the throwaway server so nothing can escape to the real
    // Notion API, whichever of baseUrl / spec `servers` the client prefers.
    const localSpec = () => ({ ...spec, servers: [{ url: baseUrl }] }) as OpenAPIV3.Document
    const route = '/v1/blocks/{block_id}'
    const operation = () =>
      ({
        ...(spec.paths![route]!.patch as OpenAPIV3.OperationObject),
        method: 'patch',
        path: route,
      }) as any

    it('puts the block-type key at the top level of the body', async () => {
      const client = new HttpClient({ baseUrl }, localSpec())

      const response = await client.executeOperation(operation(), {
        block_id: 'block-id',
        bulleted_list_item: { rich_text: [{ text: { content: 'Corrected: the number is 42' } }] },
      })

      expect(received?.method).toBe('PATCH')
      // the id belongs in the address, not in the payload
      expect(received?.url).toBe('/v1/blocks/block-id')
      expect(received?.body?.block_id).toBeUndefined()
      // this is the whole bug: the payload must not be nested under `type`
      expect(received?.body?.type).toBeUndefined()
      expect(received?.body).toEqual({
        bulleted_list_item: { rich_text: [{ text: { content: 'Corrected: the number is 42' } }] },
      })
      expect(response.data).toEqual({ object: 'block', id: 'block-id' })
    })

    it('can tick a to_do without sending any text', async () => {
      const client = new HttpClient({ baseUrl }, localSpec())

      await client.executeOperation(operation(), { block_id: 'todo-id', to_do: { checked: true } })

      expect(received?.body).toEqual({ to_do: { checked: true } })
    })

    it('still archives and restores a block on its own', async () => {
      const client = new HttpClient({ baseUrl }, localSpec())

      await client.executeOperation(operation(), { block_id: 'block-id', archived: false })

      expect(received?.body).toEqual({ archived: false })
    })
  })
})
