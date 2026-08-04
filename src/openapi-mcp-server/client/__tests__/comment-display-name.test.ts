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
 * Fork patch guard (signing a comment with a name).
 *
 * Notion accepts a `display_name` on comment creation, so a comment can say who
 * wrote it. The bundled description never listed it, so every comment posted
 * through this server appeared under the one integration name — on a busy page
 * the project manager's notes, a build worker's progress lines and a deploy
 * handover were indistinguishable.
 *
 * The shape is Notion's, not ours: `{ type: "custom", custom: { name } }`,
 * per the Comment display name reference. `custom` is the only type that
 * carries a name of your choosing.
 *
 * The tool-surface tests are the regression guard: the generated `inputSchema`
 * is what an MCP client validates against, so a spec refresh that reverts this
 * patch fails here. The wire tests pin the other half — that a supplied name
 * really is serialized into the request body, and that omitting it changes
 * nothing about the call.
 */
describe('comment display name (fork patch)', () => {
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
  const displayName = () => (toolFor('create-a-comment').inputSchema.properties as Record<string, any>).display_name

  describe('tool surface', () => {
    it('advertises display_name on create-a-comment', () => {
      expect(displayName()).toBeDefined()
    })

    it('leaves it optional — only rich_text is still required', () => {
      const method = toolFor('create-a-comment')

      expect(method.inputSchema.required ?? []).not.toContain('display_name')
      expect(method.inputSchema.required ?? []).toContain('rich_text')
    })

    it('offers the custom type, which is the one that carries a name', () => {
      const withEnum = branchesOf(displayName())
        .flatMap((branch) => branchesOf(branch?.properties?.type))
        .find((branch) => Array.isArray(branch?.enum))

      expect(withEnum?.enum).toContain('custom')
    })

    it('nests the name under custom.name, the way Notion accepts it', () => {
      const custom = branchesOf(displayName()).flatMap((branch) => branchesOf(branch?.properties?.custom))
      const withName = custom.find((branch) => branch?.properties?.name)

      expect(withName, 'display_name.custom.name is missing').toBeDefined()
      expect(branchesOf(withName!.properties.name).some((branch) => branch?.type === 'string')).toBe(true)
    })

    it('says on the schema what omitting it does, since that is the text an agent reads', () => {
      // The operation-level `description` never reaches the agent — only the
      // summary and the property descriptions do — so the guidance has to sit
      // on the property itself.
      const description = branchesOf(displayName())
        .map((branch) => String(branch?.description ?? ''))
        .join(' ')
        .toLowerCase()

      expect(description).toContain('integration')
      expect(description).toContain('custom')
    })

    // The other half of the card: none of the existing comment options may be
    // disturbed by the addition.
    it('keeps the parent, thread-reply and attachment options intact', () => {
      const properties = toolFor('create-a-comment').inputSchema.properties as Record<string, any>

      expect(properties.parent).toBeDefined()
      expect(properties.discussion_id).toBeDefined()
      expect(properties.attachments).toBeDefined()
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
      app.post('/v1/comments', (req, res) => {
        received = req.body
        res.status(200).json({ object: 'comment', id: 'comment-id' })
      })
      ;({ server, baseUrl } = await startTestServer(app))
    })

    afterEach(async () => {
      await stopTestServer(server)
    })

    // Point the spec at the throwaway server so nothing can escape to the real
    // Notion API, whichever of baseUrl / spec `servers` the client prefers.
    const localSpec = () => ({ ...spec, servers: [{ url: baseUrl }] }) as OpenAPIV3.Document
    const createComment = () => ({
      ...(spec.paths!['/v1/comments']!.post as OpenAPIV3.OperationObject),
      method: 'post',
      path: '/v1/comments',
    })

    it('forwards a supplied name in the create-comment body', async () => {
      const client = new HttpClient({ baseUrl }, localSpec())

      await client.executeOperation(createComment(), {
        parent: { page_id: 'page-id' },
        rich_text: [{ text: { content: 'Build finished.' } }],
        display_name: { type: 'custom', custom: { name: 'build worker' } },
      })

      expect(received?.display_name).toEqual({ type: 'custom', custom: { name: 'build worker' } })
    })

    it('sends no display_name when none is given, so the old behaviour is unchanged', async () => {
      const client = new HttpClient({ baseUrl }, localSpec())

      await client.executeOperation(createComment(), {
        parent: { page_id: 'page-id' },
        rich_text: [{ text: { content: 'Unsigned, as before.' } }],
      })

      expect(received?.display_name).toBeUndefined()
      expect(received?.rich_text).toEqual([{ text: { content: 'Unsigned, as before.' } }])
    })

    it('carries the name into a threaded reply too, not just a new comment', async () => {
      const client = new HttpClient({ baseUrl }, localSpec())

      await client.executeOperation(createComment(), {
        discussion_id: 'discussion-id',
        rich_text: [{ text: { content: 'Replying in the thread.' } }],
        display_name: { type: 'custom', custom: { name: 'deploy worker' } },
      })

      expect(received?.display_name).toEqual({ type: 'custom', custom: { name: 'deploy worker' } })
      expect(received?.discussion_id).toBe('discussion-id')
      expect(received?.parent).toBeUndefined()
    })
  })
})
