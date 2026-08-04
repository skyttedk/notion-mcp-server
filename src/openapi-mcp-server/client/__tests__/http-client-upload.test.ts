import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HttpClient, HttpClientError } from '../http-client'
import { OpenAPIV3 } from 'openapi-types'
import fs from 'fs'
import FormData from 'form-data'

vi.mock('fs')
vi.mock('form-data')

describe('HttpClient File Upload', () => {
  let client: HttpClient
  const mockApiInstance = {
    uploadFile: vi.fn(),
  }

  const baseConfig = {
    baseUrl: 'http://test.com',
    headers: {},
  }

  const mockOpenApiSpec: OpenAPIV3.Document = {
    openapi: '3.0.0',
    info: {
      title: 'Test API',
      version: '1.0.0',
    },
    paths: {
      '/upload': {
        post: {
          operationId: 'uploadFile',
          responses: {
            '200': {
              description: 'File uploaded successfully',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: {
                        type: 'boolean',
                      },
                    },
                  },
                },
              },
            },
          },
          requestBody: {
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  properties: {
                    file: {
                      type: 'string',
                      format: 'binary',
                    },
                    description: {
                      type: 'string',
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    client = new HttpClient(baseConfig, mockOpenApiSpec)
    // @ts-expect-error - Mock the private api property
    client['api'] = Promise.resolve(mockApiInstance)
  })

  it('should handle file uploads with FormData', async () => {
    const mockFormData = new FormData()
    const mockFileStream = { pipe: vi.fn() }
    const mockFormDataHeaders = { 'content-type': 'multipart/form-data; boundary=---123' }

    vi.mocked(fs.createReadStream).mockReturnValue(mockFileStream as any)
    vi.spyOn(FormData.prototype, 'append').mockImplementation(() => {})
    vi.spyOn(FormData.prototype, 'getHeaders').mockReturnValue(mockFormDataHeaders)

    const uploadPath = mockOpenApiSpec.paths['/upload']
    if (!uploadPath?.post) {
      throw new Error('Upload path not found in spec')
    }
    const operation = uploadPath.post as OpenAPIV3.OperationObject & { method: string; path: string }
    const params = {
      file: '/path/to/test.txt',
      description: 'Test file',
    }

    mockApiInstance.uploadFile.mockResolvedValue({
      data: { success: true },
      status: 200,
      headers: {},
    })

    await client.executeOperation(operation, params)

    expect(fs.createReadStream).toHaveBeenCalledWith('/path/to/test.txt')
    expect(FormData.prototype.append).toHaveBeenCalledWith('file', mockFileStream)
    expect(FormData.prototype.append).toHaveBeenCalledWith('description', 'Test file')
    expect(mockApiInstance.uploadFile).toHaveBeenCalledWith({}, expect.any(FormData), { headers: mockFormDataHeaders })
  })

  it('should throw error for invalid file path', async () => {
    vi.mocked(fs.createReadStream).mockImplementation(() => {
      throw new Error('File not found')
    })

    const uploadPath = mockOpenApiSpec.paths['/upload']
    if (!uploadPath?.post) {
      throw new Error('Upload path not found in spec')
    }
    const operation = uploadPath.post as OpenAPIV3.OperationObject & { method: string; path: string }
    const params = {
      file: '/nonexistent/file.txt',
      description: 'Test file',
    }

    await expect(client.executeOperation(operation, params)).rejects.toThrow('Failed to read file at /nonexistent/file.txt')
  })

  // Fork addition: a remotely hosted server shares no filesystem with the
  // caller, so file params also accept inline bytes or a fetchable URL.
  describe('remote file sources', () => {
    const BYTES = Buffer.from('fake screenshot bytes')
    const B64 = BYTES.toString('base64')

    const runUpload = async (file: string, extra: Record<string, any> = {}) => {
      vi.spyOn(FormData.prototype, 'append').mockImplementation(() => {})
      vi.spyOn(FormData.prototype, 'getHeaders').mockReturnValue({})
      const operation = mockOpenApiSpec.paths['/upload']!.post as OpenAPIV3.OperationObject & {
        method: string
        path: string
      }
      mockApiInstance.uploadFile.mockResolvedValue({ data: { success: true }, status: 200, headers: {} })
      await client.executeOperation(operation, { file, ...extra })
      return vi.mocked(FormData.prototype.append).mock.calls.find((c) => c[0] === 'file')
    }

    it('decodes a data: URI to bytes without touching the filesystem', async () => {
      const call = await runUpload(`data:image/png;base64,${B64}`, { filename: 'shot.png' })
      expect(call?.[1]).toBeInstanceOf(Buffer)
      expect((call?.[1] as Buffer).equals(BYTES)).toBe(true)
      expect(call?.[2]).toEqual({ filename: 'shot.png', contentType: 'image/png' })
      expect(fs.createReadStream).not.toHaveBeenCalled()
    })

    it('decodes a bare base64 string', async () => {
      const long = Buffer.from('x'.repeat(200)).toString('base64')
      const call = await runUpload(long)
      expect((call?.[1] as Buffer).equals(Buffer.from('x'.repeat(200)))).toBe(true)
      expect(fs.createReadStream).not.toHaveBeenCalled()
    })

    // Regression: base64 used to be recognised only at 100+ characters, so a
    // tiny file's base64 was taken for a path and failed with file-not-found.
    it('decodes a tiny bare base64 string, far below the old 100-char threshold', async () => {
      const tiny = Buffer.from('a short note')
      const call = await runUpload(tiny.toString('base64'))
      expect(call?.[1]).toBeInstanceOf(Buffer)
      expect((call?.[1] as Buffer).equals(tiny)).toBe(true)
      expect(fs.createReadStream).not.toHaveBeenCalled()
    })

    // Length is no longer the signal, so an existing file must still win —
    // otherwise a stdio path made only of base64 characters would be decoded.
    it('prefers a local file that actually exists over reading it as base64', async () => {
      // Once: the stat mock must not leak into later tests, where the same
      // shape of string is meant to be read as base64.
      vi.mocked(fs.statSync).mockReturnValueOnce({ isFile: () => true } as any)
      const stream = { pipe: vi.fn() }
      vi.mocked(fs.createReadStream).mockReturnValue(stream as any)
      const call = await runUpload('/data/report')
      expect(fs.createReadStream).toHaveBeenCalledWith('/data/report')
      expect(call?.[1]).toBe(stream)
    })

    it('fetches an http(s) URL', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => BYTES.buffer.slice(BYTES.byteOffset, BYTES.byteOffset + BYTES.byteLength),
      })
      vi.stubGlobal('fetch', fetchMock)

      const call = await runUpload('https://example.com/shot.png', { filename: 'shot.png' })
      expect(fetchMock).toHaveBeenCalledWith('https://example.com/shot.png')
      expect((call?.[1] as Buffer).equals(BYTES)).toBe(true)
      expect(fs.createReadStream).not.toHaveBeenCalled()
      vi.unstubAllGlobals()
    })

    it('surfaces a failed fetch instead of uploading nothing', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }))
      await expect(runUpload('https://example.com/missing.png')).rejects.toThrow('returned 404')
      vi.unstubAllGlobals()
    })

    it('still reads a local path, so stdio use is unchanged', async () => {
      const stream = { pipe: vi.fn() }
      vi.mocked(fs.createReadStream).mockReturnValue(stream as any)
      const call = await runUpload('/path/to/test.txt')
      expect(fs.createReadStream).toHaveBeenCalledWith('/path/to/test.txt')
      expect(call?.[1]).toBe(stream)
    })
  })

  // Fork fix: Notion rejects the send step with a content-type mismatch when
  // the multipart part's Content-Type differs from what the create step
  // declared — which is what form-data's filename-based guess produced for
  // every non-image type. The send op therefore looks the upload up and
  // reuses its recorded filename and content_type.
  describe('send-a-file-upload content type', () => {
    const TEXT = Buffer.from('# markdown\n\nsome notes\n'.repeat(10))
    const B64 = TEXT.toString('base64')

    const sendSpec: OpenAPIV3.Document = {
      openapi: '3.0.0',
      info: { title: 'Notion-ish API', version: '1.0.0' },
      paths: {
        '/v1/file_uploads/{file_upload_id}/send': {
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
        '/v1/file_uploads/{file_upload_id}': {
          get: {
            operationId: 'retrieve-a-file-upload',
            parameters: [{ name: 'file_upload_id', in: 'path', required: true, schema: { type: 'string' } }],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    }

    const sendApi = {
      'send-a-file-upload': vi.fn(),
      'retrieve-a-file-upload': vi.fn(),
    }

    const runSend = async (params: Record<string, any>) => {
      vi.spyOn(FormData.prototype, 'append').mockImplementation(() => {})
      vi.spyOn(FormData.prototype, 'getHeaders').mockReturnValue({})
      const sendClient = new HttpClient(baseConfig, sendSpec)
      // @ts-expect-error - Mock the private api property
      sendClient['api'] = Promise.resolve(sendApi)
      const operation = sendSpec.paths['/v1/file_uploads/{file_upload_id}/send']!.post as OpenAPIV3.OperationObject & {
        method: string
        path: string
      }
      sendApi['send-a-file-upload'].mockResolvedValue({ data: { status: 'uploaded' }, status: 200, headers: {} })
      await sendClient.executeOperation(operation, { file_upload_id: 'fu-1', ...params })
      return vi.mocked(FormData.prototype.append).mock.calls.find((c) => c[0] === 'file')
    }

    beforeEach(() => {
      sendApi['retrieve-a-file-upload'].mockResolvedValue({
        data: { id: 'fu-1', status: 'pending', filename: 'notes.md', content_type: 'text/markdown' },
        status: 200,
        headers: {},
      })
    })

    it('reuses the create step\'s filename and content_type when filename is omitted', async () => {
      const call = await runSend({ file: B64 })
      expect(sendApi['retrieve-a-file-upload']).toHaveBeenCalledWith({ file_upload_id: 'fu-1' }, undefined, expect.anything())
      expect(call?.[2]).toEqual({ filename: 'notes.md', contentType: 'text/markdown' })
    })

    it('keeps the caller\'s filename but still uses the declared content_type', async () => {
      const call = await runSend({ file: B64, filename: 'renamed.md' })
      expect(call?.[2]).toEqual({ filename: 'renamed.md', contentType: 'text/markdown' })
    })

    it('does not send filename as a form field of its own', async () => {
      await runSend({ file: B64, filename: 'notes.md' })
      const fieldNames = vi.mocked(FormData.prototype.append).mock.calls.map((c) => c[0])
      expect(fieldNames).not.toContain('filename')
    })

    it('falls back to the data: URI mediatype when the lookup fails', async () => {
      sendApi['retrieve-a-file-upload'].mockRejectedValue(new Error('boom'))
      const call = await runSend({ file: `data:text/plain;charset=utf-8;base64,${B64}`, filename: 'notes.txt' })
      expect(call?.[2]).toEqual({ filename: 'notes.txt', contentType: 'text/plain' })
    })
  })

  // Fork guard: Notion accepts a truncated single-part upload, stores the
  // fragment, and still returns success — so a short store must fail loud.
  describe('truncation guard', () => {
    const BYTES = Buffer.from('fake screenshot bytes') // 21 bytes
    const DATA_URI = `data:image/png;base64,${BYTES.toString('base64')}`

    const runUploadWithResponse = async (data: any) => {
      vi.spyOn(FormData.prototype, 'append').mockImplementation(() => {})
      vi.spyOn(FormData.prototype, 'getHeaders').mockReturnValue({})
      const operation = mockOpenApiSpec.paths['/upload']!.post as OpenAPIV3.OperationObject & {
        method: string
        path: string
      }
      mockApiInstance.uploadFile.mockResolvedValue({ data, status: 200, headers: {} })
      return client.executeOperation(operation, { file: DATA_URI, filename: 'shot.png' })
    }

    it('throws when Notion stored fewer bytes than were sent', async () => {
      await expect(runUploadWithResponse({ content_length: 4, status: 'uploaded' })).rejects.toThrow(
        'File upload truncated: sent 21 bytes but Notion stored 4',
      )
    })

    it('succeeds when the stored size matches the sent size', async () => {
      await expect(runUploadWithResponse({ content_length: 21, status: 'uploaded' })).resolves.toMatchObject({
        status: 200,
      })
    })

    it('does not guard when the response carries no content_length', async () => {
      await expect(runUploadWithResponse({ success: true })).resolves.toMatchObject({ status: 200 })
    })
  })

  // Fork fix (upload hygiene): only genuine body fields belong in the multipart
  // payload — path/query parameters already travel in the URL — and an
  // explicitly empty optional value must fail with a readable message instead
  // of an opaque TypeError from inside form-data.
  describe('upload request hygiene', () => {
    const B64 = Buffer.from('some bytes').toString('base64')

    const hygieneSpec: OpenAPIV3.Document = {
      openapi: '3.0.0',
      info: { title: 'Test API', version: '1.0.0' },
      paths: {
        '/things/{thing_id}/upload': {
          post: {
            operationId: 'uploadThing',
            parameters: [
              { name: 'thing_id', in: 'path', required: true, schema: { type: 'string' } },
              { name: 'variant', in: 'query', required: false, schema: { type: 'string' } },
            ],
            requestBody: {
              content: {
                'multipart/form-data': {
                  schema: {
                    type: 'object',
                    required: ['file'],
                    properties: {
                      file: { type: 'string', format: 'binary' },
                      description: { type: 'string' },
                    },
                  },
                },
              },
            },
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    }

    const hygieneApi = { uploadThing: vi.fn() }

    const run = async (params: Record<string, any>) => {
      // form-data is auto-mocked in this file, so a null value would be
      // swallowed by the stub. Reproduce what the real library does: it reads
      // `value.name`/`value.path` when building the part header, which throws
      // on null/undefined.
      vi.spyOn(FormData.prototype, 'append').mockImplementation(((_field: string, value: any) => {
        if (value === null || value === undefined) {
          throw new TypeError(`Cannot read properties of ${value} (reading 'name')`)
        }
      }) as any)
      vi.spyOn(FormData.prototype, 'getHeaders').mockReturnValue({})
      const hygieneClient = new HttpClient(baseConfig, hygieneSpec)
      // @ts-expect-error - Mock the private api property
      hygieneClient['api'] = Promise.resolve(hygieneApi)
      const operation = hygieneSpec.paths['/things/{thing_id}/upload']!.post as OpenAPIV3.OperationObject & {
        method: string
        path: string
      }
      hygieneApi.uploadThing.mockResolvedValue({ data: { ok: true }, status: 200, headers: {} })
      await hygieneClient.executeOperation(operation, params)
      return vi.mocked(FormData.prototype.append).mock.calls.map((call) => call[0])
    }

    it('keeps path and query parameters out of the multipart body', async () => {
      const fields = await run({ thing_id: 't-1', variant: 'small', file: B64, description: 'a note' })
      expect(fields).not.toContain('thing_id')
      expect(fields).not.toContain('variant')
      expect(fields).toEqual(expect.arrayContaining(['file', 'description']))
    })

    it('still sends the path and query parameters in the URL', async () => {
      await run({ thing_id: 't-1', variant: 'small', file: B64 })
      expect(hygieneApi.uploadThing).toHaveBeenCalledWith(
        { thing_id: 't-1', variant: 'small' },
        expect.anything(),
        expect.anything(),
      )
    })

    it('rejects an explicitly empty optional value with a readable message', async () => {
      await expect(run({ thing_id: 't-1', file: B64, description: null })).rejects.toThrow(
        'Parameter "description" was sent as null; omit the parameter instead of sending an empty value.',
      )
    })
  })

  it('should handle multiple file uploads', async () => {
    const mockFormData = new FormData()
    const mockFileStream1 = { pipe: vi.fn() }
    const mockFileStream2 = { pipe: vi.fn() }
    const mockFormDataHeaders = { 'content-type': 'multipart/form-data; boundary=---123' }

    vi.mocked(fs.createReadStream)
      .mockReturnValueOnce(mockFileStream1 as any)
      .mockReturnValueOnce(mockFileStream2 as any)
    vi.spyOn(FormData.prototype, 'append').mockImplementation(() => {})
    vi.spyOn(FormData.prototype, 'getHeaders').mockReturnValue(mockFormDataHeaders)

    const operation: OpenAPIV3.OperationObject = {
      operationId: 'uploadFile',
      responses: {
        '200': {
          description: 'Files uploaded successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: {
                    type: 'boolean',
                  },
                },
              },
            },
          },
        },
      },
      requestBody: {
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              properties: {
                file1: {
                  type: 'string',
                  format: 'binary',
                },
                file2: {
                  type: 'string',
                  format: 'binary',
                },
                description: {
                  type: 'string',
                },
              },
            },
          },
        },
      },
    }

    const params = {
      file1: '/path/to/test1.txt',
      file2: '/path/to/test2.txt',
      description: 'Test files',
    }

    mockApiInstance.uploadFile.mockResolvedValue({
      data: { success: true },
      status: 200,
      headers: {},
    })

    await client.executeOperation(operation as OpenAPIV3.OperationObject & { method: string; path: string }, params)

    expect(fs.createReadStream).toHaveBeenCalledWith('/path/to/test1.txt')
    expect(fs.createReadStream).toHaveBeenCalledWith('/path/to/test2.txt')
    expect(FormData.prototype.append).toHaveBeenCalledWith('file1', mockFileStream1)
    expect(FormData.prototype.append).toHaveBeenCalledWith('file2', mockFileStream2)
    expect(FormData.prototype.append).toHaveBeenCalledWith('description', 'Test files')
    expect(mockApiInstance.uploadFile).toHaveBeenCalledWith({}, expect.any(FormData), { headers: mockFormDataHeaders })
  })

  // Fork guard: when the bot-protection layer in front of Notion refuses an
  // upload it answers with an HTML page rather than an API error. That page must
  // never reach the caller — it is unreadable as an error, and it names the
  // sender — so it is replaced with a short, explicit message.
  describe('bot-protection refusal', () => {
    // Invented stand-in. A real block page also carries the sender's network
    // address and a reference id; neither may ever be reproduced in a fixture.
    const BLOCK_PAGE =
      '<!DOCTYPE html><html><head><title>Attention Required</title></head>' +
      '<body><h1>Sorry, you have been blocked</h1>' +
      '<p>This website is using a security service to protect itself.</p></body></html>'

    const failingUpload = async (response: any): Promise<HttpClientError> => {
      vi.spyOn(FormData.prototype, 'append').mockImplementation(() => {})
      vi.spyOn(FormData.prototype, 'getHeaders').mockReturnValue({})
      const operation = mockOpenApiSpec.paths['/upload']!.post as OpenAPIV3.OperationObject & {
        method: string
        path: string
      }
      mockApiInstance.uploadFile.mockRejectedValue({ response })
      try {
        await client.executeOperation(operation, {
          file: `data:image/png;base64,${Buffer.from('fake screenshot bytes').toString('base64')}`,
          filename: 'shot.png',
        })
      } catch (error) {
        return error as HttpClientError
      }
      throw new Error('expected the upload to be rejected')
    }

    it('reports an HTML refusal as a short error naming the block and the status', async () => {
      const error = await failingUpload({ status: 403, statusText: 'Forbidden', data: BLOCK_PAGE, headers: {} })

      expect(error).toBeInstanceOf(HttpClientError)
      expect(error.status).toBe(403)
      expect(error.message).toContain('Blocked before reaching Notion')
      expect(error.message).toContain('403')
      expect(error.message).toContain('an HTML page')
      expect(error.message.length).toBeLessThan(400)
    })

    it('withholds the block page from the error payload', async () => {
      const error = await failingUpload({ status: 403, statusText: 'Forbidden', data: BLOCK_PAGE, headers: {} })

      expect(error.data).toMatchObject({ object: 'error', code: 'blocked_before_notion' })
      const payload = JSON.stringify(error.data)
      expect(payload).not.toContain('<')
      expect(payload).not.toContain('security service')
      expect(payload).not.toContain('Attention Required')
    })

    it('catches a non-JSON refusal that is not HTML', async () => {
      const error = await failingUpload({
        status: 429,
        statusText: 'Too Many Requests',
        data: 'Service temporarily unavailable',
        headers: {},
      })

      expect(error.status).toBe(429)
      expect(error.message).toContain('Blocked before reaching Notion')
      expect(error.message).toContain('a non-JSON body')
      expect(error.data).toMatchObject({ code: 'blocked_before_notion' })
    })

    it('passes an ordinary JSON API error through unchanged', async () => {
      const body = { object: 'error', status: 400, code: 'validation_error', message: 'body failed validation' }
      const error = await failingUpload({ status: 400, statusText: 'Bad Request', data: body, headers: {} })

      expect(error.data).toEqual(body)
      expect(error.message).toBe('400 Bad Request')
    })
  })
})
