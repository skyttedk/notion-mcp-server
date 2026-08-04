import { describe, it, expect, afterEach } from 'vitest'
import express, { type Express } from 'express'
import type { Server } from 'http'
import type { OpenAPIV3 } from 'openapi-types'
import { HttpClient } from '../http-client'
import { startTestServer, stopTestServer } from './test-server'

/**
 * Pins the single rule both request-building paths share: a value declared
 * under an operation's `parameters` travels in the URL or the headers, so it
 * must never be sent as a body field.
 *
 * The rule used to be written out twice — once for the multipart body and once
 * for the JSON body — and the two spellings could drift apart, re-opening the
 * stray-field defect in file uploads. It now lives in `declaredParameters`, and
 * these tests assert the observable outcome on both paths against a real server
 * rather than the helper itself, so they keep holding if the helper moves.
 */
describe('HttpClient declared parameters never become body fields', () => {
  let server: Server | undefined

  afterEach(async () => {
    await stopTestServer(server)
    server = undefined
  })

  function echoApp(): Express {
    const app = express()
    app.use(express.json())
    // Capture the multipart payload verbatim; asserting on the raw part
    // headers is what proves which fields were appended.
    app.use(express.raw({ type: 'multipart/form-data', limit: '10mb' }))
    app.post('/v1/json', (req, res) => {
      res.json({ body: req.body, query: req.query })
    })
    app.post('/v1/upload', (req, res) => {
      res.json({ raw: Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '', query: req.query })
    })
    return app
  }

  /**
   * Every declared location is represented: an inline query parameter, a
   * `$ref`'d query parameter, and a header parameter — alongside `real_field`,
   * which is the only genuine body field.
   */
  function spec(baseUrl: string): OpenAPIV3.Document {
    const parameters = [
      { name: 'filter', in: 'query', required: false, schema: { type: 'string' } },
      { $ref: '#/components/parameters/sharedFilter' },
      { name: 'Notion-Version', in: 'header', required: false, schema: { type: 'string', default: '2025-09-03' } },
    ] as any

    return {
      openapi: '3.0.0',
      info: { title: 't', version: '1' },
      servers: [{ url: baseUrl }],
      components: {
        parameters: {
          sharedFilter: { name: 'filter_ref', in: 'query', required: false, schema: { type: 'string' } },
        },
      },
      paths: {
        '/v1/json': {
          post: {
            operationId: 'jsonOp',
            parameters,
            requestBody: {
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { real_field: { type: 'string' } } },
                },
              },
            },
            responses: { '200': { description: 'ok' } },
          },
        },
        '/v1/upload': {
          post: {
            operationId: 'uploadOp',
            parameters,
            requestBody: {
              content: {
                'multipart/form-data': {
                  schema: {
                    type: 'object',
                    properties: {
                      file: { type: 'string', format: 'binary' },
                      real_field: { type: 'string' },
                    },
                  },
                },
              },
            },
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    } as OpenAPIV3.Document
  }

  // Every declared parameter is supplied as an argument, so anything that
  // leaks into the body does so because the rule failed to exclude it.
  const args = {
    filter: 'inline',
    filter_ref: 'referenced',
    'Notion-Version': '2026-03-11',
    real_field: 'keep-me',
  }

  it('keeps URL parameters out of the multipart body, including $ref’d and header ones', async () => {
    let baseUrl: string
    ;({ server, baseUrl } = await startTestServer(echoApp()))
    const s = spec(baseUrl)
    const client = new HttpClient({ baseUrl }, s)

    // 'aGVsbG8=' is bare base64 for 'hello'.
    const res = await client.executeOperation(s.paths!['/v1/upload']!.post as any, { ...args, file: 'aGVsbG8=' })
    const raw: string = res.data.raw

    expect(raw).toContain('name="file"')
    expect(raw).toContain('name="real_field"')
    expect(raw).toContain('keep-me')

    expect(raw).not.toContain('name="filter"')
    expect(raw).not.toContain('name="filter_ref"')
    expect(raw).not.toContain('name="Notion-Version"')
    // The values themselves are gone too, not merely renamed.
    expect(raw).not.toContain('referenced')
  })

  /**
   * The `filter_ref` assertions below are the one place behaviour moved. The
   * JSON path used to test `'name' in param`, which is false for a `$ref`'d
   * declaration, so a referenced query parameter was neither routed into the
   * URL nor removed from the body — the very leak the multipart path had just
   * been fixed for. Sharing the rule resolves that in the multipart path's
   * favour. It cannot affect the shipped server: the bundled Notion spec's only
   * `$ref`'d parameter is the `Notion-Version` header, and there are no
   * referenced path or query parameters at all.
   */
  it('keeps URL parameters out of the JSON body, including $ref’d ones', async () => {
    let baseUrl: string
    ;({ server, baseUrl } = await startTestServer(echoApp()))
    const s = spec(baseUrl)
    const client = new HttpClient({ baseUrl }, s)

    const res = await client.executeOperation(s.paths!['/v1/json']!.post as any, args)

    expect(res.data.body).toHaveProperty('real_field', 'keep-me')
    expect(res.data.body).not.toHaveProperty('filter')
    expect(res.data.body).not.toHaveProperty('filter_ref')

    // They went to the address instead of the body.
    expect(res.data.query).toHaveProperty('filter', 'inline')
    expect(res.data.query).toHaveProperty('filter_ref', 'referenced')
  })

  /**
   * Documents a difference between the two paths that this refactor
   * deliberately did NOT resolve: the multipart path excludes header-declared
   * parameters from the body, the JSON path does not. It is unreachable in
   * practice — the parser strips header parameters from every tool's input
   * schema, so no caller can supply one — but pinning it here means a future
   * change to it has to be a decision rather than an accident.
   */
  it('still passes header-declared parameters through to the JSON body (documented difference)', async () => {
    let baseUrl: string
    ;({ server, baseUrl } = await startTestServer(echoApp()))
    const s = spec(baseUrl)
    const client = new HttpClient({ baseUrl }, s)

    const res = await client.executeOperation(s.paths!['/v1/json']!.post as any, args)

    expect(res.data.body).toHaveProperty('Notion-Version', '2026-03-11')
  })
})
