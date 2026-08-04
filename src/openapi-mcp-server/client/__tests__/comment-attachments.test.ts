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
 * Fork patch guard (comment attachments).
 *
 * Notion's `POST /v1/comments` accepts an `attachments` array of file-upload
 * references, so a comment can carry a screenshot. The bundled OpenAPI spec did
 * not expose it, which made the generated `create-a-comment` tool text-only —
 * an agent could write a comment or attach a picture, never both.
 *
 * Two halves are covered. The tool-surface test is the regression guard: it is
 * the generated `inputSchema` that decides what a caller may send, so a spec
 * refresh that drops the patch fails here. The wire test pins the other half —
 * that an accepted `attachments` argument really is serialized into the JSON
 * body of `POST /v1/comments` rather than dropped somewhere in the client. It
 * would pass even without the spec patch (the HTTP client forwards whatever
 * params it is handed); keep it anyway, since a client-side body filter added
 * later would break attachments while the schema still advertised them.
 */
describe('create-a-comment attachments (fork patch)', () => {
  const specPath = path.resolve(process.cwd(), 'scripts/notion-openapi.json')
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf-8')) as OpenAPIV3.Document

  it('exposes attachments on the generated create-a-comment tool', () => {
    const { tools } = new OpenAPIToMCPConverter(spec).convertToMCPTools()
    const method = tools['API']?.methods.find((m) => m.name === 'create-a-comment')

    expect(method).toBeDefined()
    const attachments = (method!.inputSchema.properties as Record<string, any>)?.attachments
    expect(attachments).toBeDefined()

    // The converter wraps each property in an anyOf (structured value | JSON
    // string), so dig out the array branch and check the item shape.
    const arrayBranch = attachments.anyOf
      ? attachments.anyOf.find((branch: any) => branch.type === 'array')
      : attachments
    expect(arrayBranch?.type).toBe('array')

    const itemBranches = arrayBranch.items?.anyOf ?? [arrayBranch.items]
    const objectBranch = itemBranches.find((branch: any) => branch?.properties?.file_upload_id)
    expect(objectBranch).toBeDefined()
    expect(objectBranch.required).toContain('file_upload_id')

    // attachments must stay optional — a plain text comment still has to work.
    expect(method!.inputSchema.required ?? []).not.toContain('attachments')
  })

  describe('over the wire', () => {
    let server: Server
    let baseUrl: string
    let received: any

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

    it('forwards attachments in the JSON body of the create-comment request', async () => {
      const client = new HttpClient({ baseUrl }, localSpec())
      const operation = {
        ...(spec.paths!['/v1/comments']!.post as OpenAPIV3.OperationObject),
        method: 'post',
        path: '/v1/comments',
      }

      const response = await client.executeOperation(operation, {
        parent: { page_id: 'page-id' },
        rich_text: [{ text: { content: 'Here is the screenshot' } }],
        attachments: [{ type: 'file_upload', file_upload_id: 'upload-id' }],
      })

      expect(response.status).toBe(200)
      expect(received).toBeDefined()
      expect(received.attachments).toEqual([{ type: 'file_upload', file_upload_id: 'upload-id' }])
      // the text half must survive alongside the attachment
      expect(received.rich_text[0].text.content).toBe('Here is the screenshot')
    })

    it('sends no attachments key when the caller omits it', async () => {
      const client = new HttpClient({ baseUrl }, localSpec())
      const operation = {
        ...(spec.paths!['/v1/comments']!.post as OpenAPIV3.OperationObject),
        method: 'post',
        path: '/v1/comments',
      }

      await client.executeOperation(operation, {
        parent: { page_id: 'page-id' },
        rich_text: [{ text: { content: 'Plain comment' } }],
      })

      expect(received).toBeDefined()
      expect(received.attachments).toBeUndefined()
    })
  })
})
