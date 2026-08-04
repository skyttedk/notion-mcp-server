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

  describe('over the wire', () => {
    let server: Server
    let baseUrl: string
    let received: Record<string, any> | undefined

    beforeEach(async () => {
      received = undefined
      const app = express()
      app.use(express.json())
      for (const route of ['/v1/comments', '/v1/pages', '/v1/file_uploads']) {
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
