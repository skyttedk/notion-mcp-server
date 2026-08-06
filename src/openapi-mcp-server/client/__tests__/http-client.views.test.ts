import { describe, it, expect, afterEach } from 'vitest'
import express, { type Express } from 'express'
import type { Server } from 'http'
import fs from 'node:fs'
import path from 'node:path'
import type { OpenAPIV3 } from 'openapi-types'
import { HttpClient } from '../http-client'
import { startTestServer, stopTestServer } from './test-server'

/**
 * Checks what the view tools actually put on the wire, using the real bundled
 * spec against a stand-in Notion.
 *
 * The tool-surface tests assert that the schema describes the right things; this
 * asserts the request that results — method, URL, query string, JSON body and
 * the pinned API version. Those are the parts a spec edit can get wrong while
 * every schema assertion still passes: a body field that never leaves the
 * client, a path parameter interpolated into the query string, or the version
 * header silently falling back to the spec-wide default and getting the whole
 * Views API rejected as unknown.
 */
describe('HttpClient view operations', () => {
  let server: Server | undefined

  afterEach(async () => {
    await stopTestServer(server)
    server = undefined
  })

  const specPath = path.resolve(process.cwd(), 'scripts/notion-openapi.json')
  const baseSpec = JSON.parse(fs.readFileSync(specPath, 'utf-8')) as OpenAPIV3.Document

  type Captured = { method: string; url: string; body: unknown; version?: string }

  function captureApp(seen: Captured[]): Express {
    const app = express()
    app.use(express.json())
    app.use((req, res) => {
      seen.push({
        method: req.method,
        url: req.originalUrl,
        body: req.body,
        version: req.headers['notion-version'] as string | undefined,
      })
      res.json({ object: 'view', id: 'view-1' })
    })
    return app
  }

  async function call(operationId: string, params: Record<string, unknown>) {
    const seen: Captured[] = []
    let baseUrl: string
    ;({ server, baseUrl } = await startTestServer(captureApp(seen)))
    const spec = { ...baseSpec, servers: [{ url: baseUrl }] } as OpenAPIV3.Document
    const client = new HttpClient({ baseUrl }, spec)

    let operation: (OpenAPIV3.OperationObject & { method: string; path: string }) | undefined
    for (const [p, item] of Object.entries(spec.paths ?? {})) {
      for (const [m, op] of Object.entries(item ?? {})) {
        if ((op as OpenAPIV3.OperationObject)?.operationId === operationId) {
          operation = { ...(op as OpenAPIV3.OperationObject), method: m, path: p }
        }
      }
    }
    if (!operation) throw new Error(`no operation ${operationId} in the bundled spec`)

    await client.executeOperation(operation, params)
    return seen[0]!
  }

  it('lists views by database, passing the filter as a query parameter', async () => {
    const req = await call('list-views', { database_id: 'db-1', page_size: 50 })
    expect(req.method).toBe('GET')
    expect(req.url).toContain('/v1/views?')
    expect(req.url).toContain('database_id=db-1')
    expect(req.url).toContain('page_size=50')
  })

  it('sends Notion-Version 2026-03-11, not the spec-wide default', async () => {
    // The Views API needs 2025-09-03 or later; the rest of this server is on
    // 2025-09-03 and must stay there, so the header is pinned per operation.
    const req = await call('list-views', { database_id: 'db-1' })
    expect(req.version).toBe('2026-03-11')
  })

  it('posts a create-a-view body with the layout intact and the ids kept distinct', async () => {
    const configuration = {
      type: 'board',
      group_by: {
        type: 'status',
        property_id: 'Status',
        group_by: 'option',
        sort: { type: 'manual' },
        hide_empty_groups: false,
      },
      card_layout: 'compact',
      cover_size: 'small',
      properties: [
        { property_id: 'title', visible: true },
        { property_id: 'Priority', visible: true },
      ],
    }
    const req = await call('create-a-view', {
      database_id: 'db-1',
      data_source_id: 'ds-1',
      name: 'Board',
      type: 'board',
      configuration,
    })

    expect(req.method).toBe('POST')
    expect(req.url).toBe('/v1/views')
    // database_id and data_source_id are different ids and both belong in the body.
    expect(req.body).toMatchObject({ database_id: 'db-1', data_source_id: 'ds-1', name: 'Board', type: 'board' })
    // The nested layout must survive verbatim — this is the whole point of the tool.
    expect((req.body as { configuration: unknown }).configuration).toEqual(configuration)
  })

  it('patches a view at its own URL and keeps a null through as a clear instruction', async () => {
    // `null` is how the API is told to remove a setting, so it must not be
    // dropped as if it were an omitted optional field.
    const req = await call('update-a-view', {
      view_id: 'view-1',
      name: 'Renamed',
      filter: null,
      configuration: { type: 'table', group_by: null },
    })

    expect(req.method).toBe('PATCH')
    expect(req.url).toBe('/v1/views/view-1')
    expect(req.body).toEqual({
      name: 'Renamed',
      filter: null,
      configuration: { type: 'table', group_by: null },
    })
    expect(req.body).not.toHaveProperty('view_id')
  })

  it('addresses a single view for retrieve and delete', async () => {
    expect((await call('retrieve-a-view', { view_id: 'v9' })).url).toBe('/v1/views/v9')
    const del = await call('delete-a-view', { view_id: 'v9' })
    expect(del.method).toBe('DELETE')
    expect(del.url).toBe('/v1/views/v9')
  })

  it('routes the three view-query steps to their own URLs', async () => {
    const created = await call('create-a-view-query', { view_id: 'v9', page_size: 25 })
    expect(created.method).toBe('POST')
    expect(created.url).toBe('/v1/views/v9/queries')
    expect(created.body).toEqual({ page_size: 25 })

    const page = await call('get-view-query-results', { view_id: 'v9', query_id: 'q1', start_cursor: 'c1' })
    expect(page.method).toBe('GET')
    expect(page.url).toContain('/v1/views/v9/queries/q1')
    expect(page.url).toContain('start_cursor=c1')

    const dropped = await call('delete-a-view-query', { view_id: 'v9', query_id: 'q1' })
    expect(dropped.method).toBe('DELETE')
    expect(dropped.url).toBe('/v1/views/v9/queries/q1')
  })
})
