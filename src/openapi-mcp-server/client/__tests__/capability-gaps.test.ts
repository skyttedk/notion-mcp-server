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
 * Fork patch guard (capability gaps closed from the spec survey).
 *
 * The bundled OpenAPI description is the only thing that limits what a caller
 * may ask for — the client forwards whatever it is handed. Three options Notion
 * accepts were missing from that description, so agents could not use them:
 *
 *   1. comments anchored to a block (`parent.block_id`) or replied into an
 *      existing thread (`discussion_id`); only `parent.page_id` was advertised
 *   2. a page created with its whole body in one call (`markdown`)
 *   3. a file upload imported from a URL (`mode: external_url` + `external_url`)
 *   4. creating a database at all (`POST /v1/databases`), and its sibling
 *      correction: `create-a-data-source` adds a data source to an EXISTING
 *      database, so its parent is a database id. On 2025-09-03 and later Notion
 *      refuses a page parent there outright, which left the namespace with no
 *      way to make a database.
 *
 * The tool-surface tests are the regression guards: the generated `inputSchema`
 * is what an MCP client validates against, so a spec refresh that reverts these
 * patches fails here. The wire tests pin the other half — that an accepted
 * argument really is serialized into the request body.
 */
describe('spec capability gaps (fork patch)', () => {
  const specPath = path.resolve(process.cwd(), 'scripts/notion-openapi.json')
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf-8')) as OpenAPIV3.Document
  const { tools } = new OpenAPIToMCPConverter(spec).convertToMCPTools()
  const toolFor = (name: string) => {
    const method = tools['API']?.methods.find((m) => m.name === name)
    expect(method, `tool ${name} is missing`).toBeDefined()
    return method!
  }
  // The converter wraps every property in an anyOf (structured value | JSON
  // string), so the branches have to be dug out before they can be inspected.
  const branchesOf = (schema: any): any[] => schema?.anyOf ?? schema?.oneOf ?? [schema]

  describe('1. comments on a block, and replies into a thread', () => {
    it('advertises both page and block parents on create-a-comment', () => {
      const parent = (toolFor('create-a-comment').inputSchema.properties as Record<string, any>).parent
      const variants = branchesOf(parent).flatMap((branch) => branchesOf(branch))

      expect(variants.some((v) => v?.properties?.page_id)).toBe(true)
      expect(variants.some((v) => v?.properties?.block_id)).toBe(true)
    })

    it('advertises discussion_id and no longer forces a parent', () => {
      const method = toolFor('create-a-comment')
      const properties = method.inputSchema.properties as Record<string, any>

      expect(properties.discussion_id).toBeDefined()
      // Replying into a thread carries no parent at all, so parent cannot stay
      // required — rich_text still is.
      expect(method.inputSchema.required ?? []).not.toContain('parent')
      expect(method.inputSchema.required ?? []).toContain('rich_text')
    })
  })

  describe('2. a page created with its content in one call', () => {
    it('advertises markdown on post-page as an optional string', () => {
      const method = toolFor('post-page')
      const markdown = (method.inputSchema.properties as Record<string, any>).markdown

      expect(markdown).toBeDefined()
      expect(branchesOf(markdown).some((branch) => branch?.type === 'string')).toBe(true)
      expect(method.inputSchema.required ?? []).not.toContain('markdown')
    })
  })

  describe('3. a file upload imported from a URL', () => {
    it('advertises the external_url mode and its URL field', () => {
      const properties = toolFor('create-a-file-upload').inputSchema.properties as Record<string, any>

      const modeBranches = branchesOf(properties.mode)
      const withEnum = modeBranches.find((branch) => Array.isArray(branch?.enum))
      expect(withEnum?.enum).toContain('external_url')
      // the two existing modes must survive the addition
      expect(withEnum?.enum).toContain('single_part')
      expect(withEnum?.enum).toContain('multi_part')

      expect(properties.external_url).toBeDefined()
    })
  })

  describe('4. creating a database, and what create-a-data-source really does', () => {
    it('offers create-a-database with a page parent and initial_data_source', () => {
      const method = toolFor('create-a-database')
      const properties = method.inputSchema.properties as Record<string, any>

      expect(properties.initial_data_source).toBeDefined()
      expect(method.inputSchema.required ?? []).toContain('parent')
      expect(method.inputSchema.required ?? []).toContain('initial_data_source')

      // the column schema hangs off initial_data_source.properties
      const initial = branchesOf(properties.initial_data_source).find((branch) => branch?.properties?.properties)
      expect(initial, 'initial_data_source must carry a properties map').toBeDefined()

      // The parent is a $ref, so it is the (pruned) $defs entry that carries
      // the shape — a page parent, because an internal integration cannot
      // create a workspace-level database.
      const parentVariants = branchesOf(properties.parent)
      expect(parentVariants.some((v) => v?.$ref === '#/$defs/pageIdParentRequest')).toBe(true)
      const defs = (method.inputSchema as any).$defs as Record<string, any>
      expect(defs?.pageIdParentRequest?.properties?.page_id).toBeDefined()
    })

    it('says both ids come back, and that a status property is creatable', () => {
      const description = toolFor('create-a-database').description

      // The database id and the data source id are different values and
      // API-create-a-view needs both — the whole reason this tool exists.
      expect(description).toContain('data_sources: array of object')
      expect(description).toContain('data_sources[0].id')
      // The open question the card asked to settle, answered in the description
      // rather than left to every caller's own experiment.
      expect(description).toContain('status')
      expect(description).toContain('option_ids')
    })

    it('points create-a-data-source at a database parent, not a page', () => {
      const method = toolFor('create-a-data-source')
      const parentVariants = branchesOf((method.inputSchema.properties as Record<string, any>).parent).flatMap(
        (branch) => branchesOf(branch),
      )

      expect(parentVariants.some((v) => v?.properties?.database_id)).toBe(true)
      expect(parentVariants.some((v) => v?.properties?.page_id)).toBe(false)
      expect(method.description).not.toContain('Create a new data source (database)')
    })

    it('offers update-a-database for the attributes that are not columns', () => {
      const properties = toolFor('update-a-database').inputSchema.properties as Record<string, any>

      for (const field of ['title', 'parent', 'icon', 'cover', 'is_inline', 'is_locked']) {
        expect(properties[field], `update-a-database is missing ${field}`).toBeDefined()
      }
    })
  })

  describe('over the wire', () => {
    let server: Server
    let baseUrl: string
    let received: Record<string, any> | undefined

    beforeEach(async () => {
      received = undefined
      const app = express()
      app.use(express.json())
      for (const route of ['/v1/comments', '/v1/pages', '/v1/file_uploads', '/v1/databases', '/v1/data_sources']) {
        app.post(route, (req, res) => {
          received = req.body
          res.status(200).json({ ok: true })
        })
      }
      ;({ server, baseUrl } = await startTestServer(app))
    })

    afterEach(async () => {
      await stopTestServer(server)
    })

    // Point the spec at the throwaway server so nothing can escape to the real
    // Notion API, whichever of baseUrl / spec `servers` the client prefers.
    const localSpec = () => ({ ...spec, servers: [{ url: baseUrl }] }) as OpenAPIV3.Document
    const operationFor = (route: string) => ({
      ...(spec.paths![route]!.post as OpenAPIV3.OperationObject),
      method: 'post',
      path: route,
    })

    it('forwards a block parent and a discussion reply on create-a-comment', async () => {
      const client = new HttpClient({ baseUrl }, localSpec())

      await client.executeOperation(operationFor('/v1/comments'), {
        parent: { block_id: 'block-id' },
        rich_text: [{ text: { content: 'Anchored to this paragraph' } }],
      })
      expect(received?.parent).toEqual({ block_id: 'block-id' })

      await client.executeOperation(operationFor('/v1/comments'), {
        discussion_id: 'discussion-id',
        rich_text: [{ text: { content: 'Replying in the thread' } }],
      })
      expect(received?.discussion_id).toBe('discussion-id')
      expect(received?.parent).toBeUndefined()
    })

    it('forwards markdown in the create-page body', async () => {
      const client = new HttpClient({ baseUrl }, localSpec())

      await client.executeOperation(operationFor('/v1/pages'), {
        parent: { page_id: 'page-id' },
        properties: { title: [{ text: { content: 'One-call page' } }] },
        markdown: '# Heading\n\nBody text.',
      })

      expect(received?.markdown).toBe('# Heading\n\nBody text.')
      expect(received?.children).toBeUndefined()
    })

    it('forwards the whole create-database body, initial_data_source included', async () => {
      const client = new HttpClient({ baseUrl }, localSpec())

      await client.executeOperation(operationFor('/v1/databases'), {
        parent: { page_id: 'page-id' },
        title: [{ text: { content: 'PM board' } }],
        initial_data_source: {
          properties: { Name: { title: {} }, Status: { status: {} } },
        },
        is_inline: true,
      })

      expect(received?.parent).toEqual({ page_id: 'page-id' })
      expect(received?.initial_data_source).toEqual({
        properties: { Name: { title: {} }, Status: { status: {} } },
      })
      expect(received?.is_inline).toBe(true)
    })

    it('forwards a database parent on create-a-data-source', async () => {
      const client = new HttpClient({ baseUrl }, localSpec())

      await client.executeOperation(operationFor('/v1/data_sources'), {
        parent: { type: 'database_id', database_id: 'database-id' },
        properties: { Name: { title: {} } },
      })

      expect(received?.parent).toEqual({ type: 'database_id', database_id: 'database-id' })
    })

    it('forwards the external_url import mode in the file-upload body', async () => {
      const client = new HttpClient({ baseUrl }, localSpec())

      await client.executeOperation(operationFor('/v1/file_uploads'), {
        mode: 'external_url',
        filename: 'report.pdf',
        external_url: 'https://example.com/report.pdf',
      })

      expect(received?.mode).toBe('external_url')
      expect(received?.external_url).toBe('https://example.com/report.pdf')
      expect(received?.filename).toBe('report.pdf')
    })
  })
})
