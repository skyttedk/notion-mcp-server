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
 * Fork patch guard (deleting a comment).
 *
 * Notion has always accepted `DELETE /v1/comments/{comment_id}`, but the
 * bundled description never listed it, so an agent could post a comment and
 * then had no way to take it back — a duplicate or a wrong number stayed on the
 * card until a human cleared it by hand.
 *
 * The tool-surface test is the regression guard: the generated `inputSchema` is
 * what an MCP client validates against, so a spec refresh that drops the
 * operation fails here. The wire test pins the other half — that the call
 * really leaves as a DELETE against the one comment's URL, and carries no body.
 *
 * Note on where the warning lives: the operation-level `description` never
 * reaches the agent (the converter uses `summary` for the tool description and
 * the parameter descriptions for the schema), so the irreversibility warning is
 * asserted in exactly those two places.
 */
describe('delete a comment (fork patch)', () => {
  const specPath = path.resolve(process.cwd(), 'scripts/notion-openapi.json')
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf-8')) as OpenAPIV3.Document
  const { tools } = new OpenAPIToMCPConverter(spec).convertToMCPTools()
  const toolFor = (name: string) => {
    const method = tools['API']?.methods.find((m) => m.name === name)
    expect(method, `tool ${name} is missing`).toBeDefined()
    return method!
  }

  describe('tool surface', () => {
    it('exposes delete-a-comment taking a required comment_id', () => {
      const method = toolFor('delete-a-comment')
      const properties = method.inputSchema.properties as Record<string, any>

      expect(properties.comment_id).toBeDefined()
      expect(method.inputSchema.required ?? []).toContain('comment_id')
    })

    it('warns in the tool description that the deletion cannot be undone', () => {
      // `summary` is what the converter turns into the tool description, so this
      // is the text an agent actually reads before calling.
      expect(toolFor('delete-a-comment').description.toLowerCase()).toContain('cannot be undone')
    })

    it('warns again on comment_id, which is the part that reaches the schema', () => {
      const properties = toolFor('delete-a-comment').inputSchema.properties as Record<string, any>
      const description = String(properties.comment_id?.description ?? '').toLowerCase()

      expect(description).toContain('permanent')
      // one comment at a time, by id — a discussion id names the whole thread
      expect(description).toContain('discussion_id')
    })

    it('offers no way to delete a whole thread or page of comments at once', () => {
      const names = tools['API']!.methods.map((m) => m.name)
      expect(names.filter((name) => name.includes('delete') && name.includes('comment'))).toEqual(['delete-a-comment'])
    })
  })

  describe('over the wire', () => {
    let server: Server
    let baseUrl: string
    let received: { method: string; url: string; commentId: string; body: unknown } | undefined

    beforeEach(async () => {
      received = undefined
      const app = express()
      app.use(express.json())
      app.delete('/v1/comments/:comment_id', (req, res) => {
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

    it('sends a DELETE to the one comment and no body', async () => {
      const route = '/v1/comments/{comment_id}'
      const operation = {
        ...(spec.paths![route]!.delete as OpenAPIV3.OperationObject),
        method: 'delete',
        path: route,
      }
      const client = new HttpClient({ baseUrl }, localSpec())

      const response = await client.executeOperation(operation, { comment_id: 'comment-id' })

      expect(received?.method).toBe('DELETE')
      expect(received?.commentId).toBe('comment-id')
      // the id belongs in the address, not in the payload
      expect(received?.url).toBe('/v1/comments/comment-id')
      expect(received?.body).toEqual({})
      expect(response.data).toEqual({ object: 'comment', id: 'comment-id' })
    })
  })
})
