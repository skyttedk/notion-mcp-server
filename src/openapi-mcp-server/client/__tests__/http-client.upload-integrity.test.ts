import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import zlib from 'node:zlib'
import { HttpClient } from '../http-client'
import type { OpenAPIV3 } from 'openapi-types'

/**
 * Regression: a screenshot handed to the send step as base64 arrived cut short
 * (43,627 bytes of PNG became its first 8,751 bytes), and every layer accepted
 * it — Notion stored the fragment, echoed a matching content_length, and the
 * tool reported success, so the page ended up with a broken image and no error
 * anywhere. These tests pin both halves: a large binary must survive the send
 * path byte for byte, and a payload that is provably incomplete must be refused
 * before anything is uploaded.
 */

/** Build a real, valid PNG of roughly `pixels` random RGB pixels (incompressible, so it stays large). */
function makePng(width: number, height: number): Buffer {
  const chunk = (type: string, body: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(body.length)
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), body])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(typed))
    return Buffer.concat([len, typed, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  const raw = Buffer.alloc(height * (1 + width * 3))
  // Deterministic pseudo-random pixels (xorshift32, kept in 32-bit integer ops
  // so it does not degenerate): noise does not compress, so the PNG stays the
  // size the test needs.
  let seed = 0x12345678
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3)
    raw[row] = 0 // filter: none
    for (let i = 0; i < width * 3; i++) {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      seed |= 0
      raw[row + 1 + i] = (seed >>> 24) & 0xff
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

let CRC_TABLE: number[] | null = null
function crc32(buf: Buffer): number {
  if (!CRC_TABLE) {
    CRC_TABLE = []
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c >>> 0
    }
  }
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Length of the file part's body in a raw multipart payload. */
function filePartLength(body: Buffer, contentType: string): number {
  const boundary = /boundary=(.+)$/.exec(contentType)![1]
  const headerEnd = body.indexOf('\r\n\r\n')
  const next = body.indexOf(Buffer.from(`--${boundary}`), headerEnd)
  return next - (headerEnd + 4) - 2 // strip the CRLF before the next boundary
}

const SEND_PATH = '/v1/file_uploads/{file_upload_id}/send'

const spec = {
  openapi: '3.0.0',
  info: { title: 'Notion', version: '1.0.0' },
  servers: [{ url: 'http://127.0.0.1' }],
  paths: {
    [SEND_PATH]: {
      post: {
        operationId: 'send-a-file-upload',
        parameters: [{ name: 'file_upload_id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['file'],
                properties: {
                  file: { type: 'string', format: 'binary' },
                  filename: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'ok' } },
      },
    },
  },
} as unknown as OpenAPIV3.Document

describe('file-upload integrity', () => {
  const received: number[] = []
  let server: Server
  let client: HttpClient

  beforeAll(async () => {
    const app = express()
    app.use(express.raw({ type: 'multipart/form-data', limit: '50mb' }))
    app.post('/v1/file_uploads/:id/send', (req, res) => {
      const bytes = filePartLength(req.body as Buffer, req.headers['content-type'] as string)
      received.push(bytes)
      // Notion echoes the size it stored, which matches whatever it was sent.
      res.json({ object: 'file_upload', id: req.params.id, status: 'uploaded', content_length: bytes })
    })
    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s))
    })
    const port = (server.address() as any).port
    client = new HttpClient({ baseUrl: `http://127.0.0.1:${port}`, headers: {} }, spec)
  })

  afterAll(() => {
    server.close()
  })

  const send = (file: string) =>
    client.executeOperation({ ...(spec.paths[SEND_PATH]!.post as any), method: 'post', path: SEND_PATH }, {
      file_upload_id: 'u1',
      file,
    })

  const png = makePng(320, 110) // ~40 KB, the size that exposed the truncation

  it('is large enough to be a meaningful payload', () => {
    expect(png.length).toBeGreaterThan(35_000)
  })

  it('sends a 40 KB image byte for byte', async () => {
    received.length = 0
    const res = await send(png.toString('base64'))
    expect(received).toEqual([png.length])
    expect((res.data as any).content_length).toBe(png.length)
  })

  it('sends a 40 KB image byte for byte as a data: URI', async () => {
    received.length = 0
    await send(`data:image/png;base64,${png.toString('base64')}`)
    expect(received).toEqual([png.length])
  })

  // The reported incident, to scale: the base64 lost its tail in transit, and
  // the surviving prefix decoded to a headed-but-unterminated PNG.
  it('refuses a PNG whose base64 was cut short, and uploads nothing', async () => {
    received.length = 0
    const cut = png.toString('base64').slice(0, 11_668)
    expect(Buffer.from(cut, 'base64').length).toBeLessThan(png.length)
    await expect(send(cut)).rejects.toThrow(/PNG payload is incomplete/)
    expect(received).toEqual([])
  })

  it('refuses a cut-short PNG sent as a data: URI', async () => {
    received.length = 0
    await expect(send(`data:image/png;base64,${png.toString('base64').slice(0, 11_668)}`)).rejects.toThrow(
      /PNG payload is incomplete/,
    )
    expect(received).toEqual([])
  })

  it('refuses base64 of an impossible length', async () => {
    received.length = 0
    await expect(send(`data:image/png;base64,${png.toString('base64').slice(0, 11_669)}`)).rejects.toThrow(
      /base64 payload is truncated/,
    )
    expect(received).toEqual([])
  })

  // Node's decoder stops at the first '=', so concatenated chunks would upload
  // only the first one.
  it('refuses base64 with padding in the middle', async () => {
    received.length = 0
    const half = png.subarray(0, 3001).toString('base64') // a length that pads
    await expect(send(`data:image/png;base64,${half}${half}`)).rejects.toThrow(/padding/)
    expect(received).toEqual([])
  })

  // Formats without a self-declared end are none of the guard's business.
  it('still uploads a payload of an unrecognised format', async () => {
    received.length = 0
    const text = Buffer.from('a'.repeat(5000))
    await send(text.toString('base64'))
    expect(received).toEqual([text.length])
  })
})
