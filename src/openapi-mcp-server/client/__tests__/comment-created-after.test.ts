import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import type { Server } from 'http'
import type { OpenAPIV3 } from 'openapi-types'
import { HttpClient, COMMENT_SCAN_MAX_PAGES } from '../http-client'
import { OpenAPIToMCPConverter } from '../../openapi/parser'
import { startTestServer, stopTestServer } from './test-server'

/**
 * Fork patch guard (`created_after` on retrieve-a-comment).
 *
 * Notion's `GET /v1/comments` takes only `block_id`, `start_cursor` and
 * `page_size`: no sort, no filter, oldest first. Asking "was anything said
 * since I last looked?" therefore meant re-reading the whole thread on every
 * poll. `created_after` is this server's own parameter — Notion has never
 * heard of it — so these tests pin the three things that can go wrong:
 * the parameter must never reach Notion, the filter must span page
 * boundaries, and a thread too long to scan must fail rather than answer from
 * a partial walk.
 */
describe('retrieve-a-comment created_after (fork patch)', () => {
  const specPath = path.resolve(process.cwd(), 'scripts/notion-openapi.json')
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf-8')) as OpenAPIV3.Document

  it('exposes created_after as an optional string on the generated tool', () => {
    const { tools } = new OpenAPIToMCPConverter(spec).convertToMCPTools()
    const method = tools['API']?.methods.find((m) => m.name === 'retrieve-a-comment')

    expect(method).toBeDefined()
    const createdAfter = (method!.inputSchema.properties as Record<string, any>)?.created_after
    expect(createdAfter).toBeDefined()
    // block_id stays the only required argument — polling without a filter must
    // keep working exactly as before.
    expect(method!.inputSchema.required ?? []).toEqual(['block_id'])
  })

  describe('over the wire', () => {
    let server: Server
    let baseUrl: string
    let requests: Record<string, any>[]
    /** Full oldest-first thread the fake Notion serves, page by page. */
    let thread: any[]
    /** When true the fake never runs out of pages, to exercise the scan cap. */
    let endless: boolean

    const comment = (index: number, createdTime: string) => ({
      object: 'comment',
      id: `comment-${index}`,
      created_time: createdTime,
      rich_text: [{ type: 'text', text: { content: `comment ${index}` } }],
    })

    /** 250 comments one minute apart — three pages at the forced size of 100. */
    const buildThread = () =>
      Array.from({ length: 250 }, (_, i) => comment(i, new Date(Date.UTC(2026, 7, 10, 0, i)).toISOString()))

    beforeEach(async () => {
      requests = []
      thread = buildThread()
      endless = false

      const app = express()
      app.get('/v1/comments', (req, res) => {
        requests.push({ ...req.query })
        const size = Number(req.query.page_size ?? 100)
        const start = Number(req.query.start_cursor ?? 0)
        const slice = endless
          ? Array.from({ length: size }, (_, i) => comment(start + i, new Date(Date.UTC(2026, 7, 10, 0, 0)).toISOString()))
          : thread.slice(start, start + size)
        const next = start + slice.length
        const hasMore = endless || next < thread.length
        res.status(200).json({
          object: 'list',
          results: slice,
          next_cursor: hasMore ? String(next) : null,
          has_more: hasMore,
          type: 'comment',
          comment: {},
        })
      })
      ;({ server, baseUrl } = await startTestServer(app))
    })

    afterEach(async () => {
      await stopTestServer(server)
    })

    // Point the spec at the throwaway server so nothing can reach real Notion.
    const localSpec = () => ({ ...spec, servers: [{ url: baseUrl }] }) as OpenAPIV3.Document

    const operation = () =>
      ({
        ...(spec.paths!['/v1/comments']!.get as OpenAPIV3.OperationObject),
        method: 'get',
        path: '/v1/comments',
      }) as OpenAPIV3.OperationObject & { method: string; path: string }

    it('filters across page boundaries and never sends created_after to Notion', async () => {
      const client = new HttpClient({ baseUrl }, localSpec())

      // Comment 149 is on the second page; everything newer spans pages 2 and 3.
      const response = await client.executeOperation(operation(), {
        block_id: 'page-id',
        created_after: thread[149].created_time,
      })

      const body = response.data as any
      expect(body.results.map((c: any) => c.id)).toEqual(thread.slice(150).map((c) => c.id))
      expect(body.results).toHaveLength(100)
      // A normal, complete list envelope — the caller sees nothing unusual.
      expect(body.has_more).toBe(false)
      expect(body.next_cursor).toBeNull()
      expect(body.object).toBe('list')

      // Three pages walked, and Notion was never told about our parameter.
      expect(requests).toHaveLength(3)
      for (const query of requests) {
        expect(query.created_after).toBeUndefined()
        expect(query.page_size).toBe('100')
        expect(query.block_id).toBe('page-id')
      }
      expect(requests.map((q) => q.start_cursor)).toEqual([undefined, '100', '200'])
    })

    it('returns an empty list when nothing is newer than the timestamp', async () => {
      const client = new HttpClient({ baseUrl }, localSpec())

      const response = await client.executeOperation(operation(), {
        block_id: 'page-id',
        created_after: thread[thread.length - 1].created_time,
      })

      expect((response.data as any).results).toEqual([])
      expect((response.data as any).has_more).toBe(false)
    })

    it('keeps the old single-request behaviour when created_after is omitted', async () => {
      const client = new HttpClient({ baseUrl }, localSpec())

      const response = await client.executeOperation(operation(), {
        block_id: 'page-id',
        page_size: 5,
      })

      const body = response.data as any
      // One request, the caller's own page_size, and the server's paging state
      // handed back untouched.
      expect(requests).toHaveLength(1)
      expect(requests[0].page_size).toBe('5')
      expect(body.results).toHaveLength(5)
      expect(body.has_more).toBe(true)
      expect(body.next_cursor).toBe('5')
    })

    it('honours a caller-supplied start_cursor as the starting point', async () => {
      const client = new HttpClient({ baseUrl }, localSpec())

      const response = await client.executeOperation(operation(), {
        block_id: 'page-id',
        start_cursor: '200',
        created_after: thread[209].created_time,
      })

      expect((response.data as any).results.map((c: any) => c.id)).toEqual(thread.slice(210).map((c) => c.id))
      expect(requests).toHaveLength(1)
      expect(requests[0].start_cursor).toBe('200')
    })

    it('fails loud past the scan limit instead of returning a partial answer', async () => {
      endless = true
      const client = new HttpClient({ baseUrl }, localSpec())

      await expect(
        client.executeOperation(operation(), {
          block_id: 'page-id',
          created_after: '2026-08-10T00:00:00.000Z',
        }),
      ).rejects.toThrow(/past the limit this server will scan/)

      // It stopped at the cap rather than walking forever.
      expect(requests).toHaveLength(COMMENT_SCAN_MAX_PAGES)
    })

    it('rejects a created_after that is not a date instead of reporting "nothing new"', async () => {
      const client = new HttpClient({ baseUrl }, localSpec())

      await expect(
        client.executeOperation(operation(), { block_id: 'page-id', created_after: 'yesterday' }),
      ).rejects.toThrow(/ISO-8601/)
      expect(requests).toHaveLength(0)
    })

    it('keeps a comment whose created_time cannot be read rather than hiding it', async () => {
      thread = [
        comment(0, '2026-08-10T00:00:00.000Z'),
        { object: 'comment', id: 'comment-undated', rich_text: [] },
        comment(2, '2026-08-10T00:02:00.000Z'),
      ]
      const client = new HttpClient({ baseUrl }, localSpec())

      const response = await client.executeOperation(operation(), {
        block_id: 'page-id',
        created_after: '2026-08-10T00:01:00.000Z',
      })

      expect((response.data as any).results.map((c: any) => c.id)).toEqual(['comment-undated', 'comment-2'])
    })
  })
})
