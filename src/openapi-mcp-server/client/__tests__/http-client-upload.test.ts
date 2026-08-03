import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HttpClient } from '../http-client'
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
      expect(call?.[2]).toEqual({ filename: 'shot.png' })
      expect(fs.createReadStream).not.toHaveBeenCalled()
    })

    it('decodes a bare base64 string', async () => {
      // Padded out past the 100-char threshold that distinguishes base64 from a path.
      const long = Buffer.from('x'.repeat(200)).toString('base64')
      const call = await runUpload(long)
      expect((call?.[1] as Buffer).equals(Buffer.from('x'.repeat(200)))).toBe(true)
      expect(fs.createReadStream).not.toHaveBeenCalled()
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
})
