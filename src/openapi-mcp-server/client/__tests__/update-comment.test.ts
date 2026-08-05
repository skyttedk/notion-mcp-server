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
 * Fork patch guard (correcting a comment, and the length limit).
 *
 * Notion accepts `PATCH /v1/comments/{comment_id}`, but the bundled description
 * listed only create and delete — so a comment with a typo or a wrong number had
 * to be deleted and written again, which loses its place in the thread.
 *
 * The same spec never mentioned that Notion caps a rich-text run at 2000
 * characters, so an over-long comment came back as a bare 400 with nothing to
 * explain it. The cap is per run and not per comment (verified against the live
 * API: two runs totalling ~2016 characters are accepted), so the description has
 * to say that splitting is the way out — otherwise an agent shortens text that
 * did not need shortening.
 *
 * The tool-surface tests are the regression guards: the generated `inputSchema`
 * is what an MCP client validates against, so a spec refresh that drops the
 * operation or the limit fails here. The wire test pins the other half — that
 * the call really leaves as a PATCH against the one comment's URL, with the new
 * text in the body and the id only in the address.
 */
describe('update a comment (fork patch)', () => {
  const specPath = path.resolve(process.cwd(), 'scripts/notion-openapi.json')
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf-8')) as OpenAPIV3.Document
  const { tools, openApiLookup } = new OpenAPIToMCPConverter(spec).convertToMCPTools()
  const toolFor = (name: string) => {
    const method = tools['API']?.methods.find((m) => m.name === name)
    expect(method, `tool ${name} is missing`).toBeDefined()
    return method!
  }
  // The converter wraps every property in an anyOf (structured value | JSON
  // string), so the branches have to be dug out before they can be inspected.
  const branchesOf = (schema: any): any[] => schema?.anyOf ?? schema?.oneOf ?? [schema]
  const richTextArray = (toolName: string) => {
    const richText = (toolFor(toolName).inputSchema.properties as Record<string, any>).rich_text
    const array = branchesOf(richText).find((branch) => branch?.type === 'array')
    expect(array, `rich_text on ${toolName} has no array branch`).toBeDefined()
    return array
  }
  // Items are wrapped in the same anyOf (structured value | JSON string | free
  // object), so the structured branch has to be picked out.
  const richTextContent = (toolName: string) =>
    branchesOf(richTextArray(toolName).items).find((branch) => branch?.properties?.text)?.properties?.text?.properties
      ?.content

  describe('tool surface', () => {
    it('exposes update-a-comment taking a comment_id and the new text', () => {
      const method = toolFor('update-a-comment')
      const properties = method.inputSchema.properties as Record<string, any>
      const required = method.inputSchema.required ?? []

      expect(properties.comment_id).toBeDefined()
      expect(properties.rich_text).toBeDefined()
      expect(required).toContain('comment_id')
      expect(required).toContain('rich_text')
    })

    it('sends it as a PATCH, which is what makes it an edit rather than a new comment', () => {
      expect(openApiLookup['API-update-a-comment']?.method).toBe('patch')
    })

    it('says in the tool description that the new text replaces the old one', () => {
      // `summary` is what the converter turns into the tool description, so this
      // is the text an agent actually reads before calling.
      const description = toolFor('update-a-comment').description.toLowerCase()
      expect(description).toContain('replaces')
    })

    it('warns on comment_id that someone else\'s comment cannot be edited', () => {
      const properties = toolFor('update-a-comment').inputSchema.properties as Record<string, any>
      const description = String(properties.comment_id?.description ?? '').toLowerCase()

      expect(description).toContain('404')
      // one comment at a time, by id — a discussion id names the whole thread
      expect(description).toContain('discussion_id')
    })

    it('states the 2000-character limit where the agent reads it, on both comment tools', () => {
      for (const toolName of ['create-a-comment', 'update-a-comment']) {
        // The converter drops `maxLength`/`maxItems`, so the description is the
        // only place the limit can reach an agent — hence it is asserted here
        // and the numeric constraints are asserted on the spec below.
        expect(String(richTextContent(toolName)?.description ?? ''), toolName).toContain('2000')
      }
    })

    it('says the cap is per run, so long text is split rather than cut', () => {
      for (const toolName of ['create-a-comment', 'update-a-comment']) {
        expect(String(richTextArray(toolName).description ?? ''), toolName).toContain('per run')
      }
    })

    it('keeps the limits as real constraints in the spec, not only as prose', () => {
      const bodySchema = (operation: any) =>
        operation.requestBody.content['application/json'].schema.properties.rich_text

      for (const operation of [spec.paths!['/v1/comments']!.post, spec.paths!['/v1/comments/{comment_id}']!.patch]) {
        const richText = bodySchema(operation)
        expect(richText.maxItems).toBe(100)
        expect(richText.items.properties.text.properties.content.maxLength).toBe(2000)
      }
    })
  })

  describe('over the wire', () => {
    let server: Server
    let baseUrl: string
    let received: { method: string; url: string; commentId: string; body: any } | undefined

    beforeEach(async () => {
      received = undefined
      const app = express()
      app.use(express.json())
      app.patch('/v1/comments/:comment_id', (req, res) => {
        received = { method: req.method, url: req.originalUrl, commentId: req.params.comment_id, body: req.body }
        res.status(200).json({ object: 'comment', id: req.params.comment_id })
      })
      ;({ server, baseUrl } = await startTestServer(app))
    })

    afterEach(async () => {
      await stopTestServer(server)
    })

    // Point the spec at the throwaway server so nothing can escape to the real
    // Notion API, whichever of baseUrl / spec `servers` the client prefers.
    const localSpec = () => ({ ...spec, servers: [{ url: baseUrl }] }) as OpenAPIV3.Document

    it('sends a PATCH to the one comment with the replacement text', async () => {
      const route = '/v1/comments/{comment_id}'
      const operation = {
        ...(spec.paths![route]!.patch as OpenAPIV3.OperationObject),
        method: 'patch',
        path: route,
      }
      const client = new HttpClient({ baseUrl }, localSpec())

      const response = await client.executeOperation(operation, {
        comment_id: 'comment-id',
        rich_text: [{ text: { content: 'Corrected: the number is 42' } }],
      })

      expect(received?.method).toBe('PATCH')
      expect(received?.commentId).toBe('comment-id')
      // the id belongs in the address, not in the payload
      expect(received?.url).toBe('/v1/comments/comment-id')
      expect(received?.body?.comment_id).toBeUndefined()
      expect(received?.body?.rich_text).toEqual([{ text: { content: 'Corrected: the number is 42' } }])
      expect(response.data).toEqual({ object: 'comment', id: 'comment-id' })
    })
  })
})
