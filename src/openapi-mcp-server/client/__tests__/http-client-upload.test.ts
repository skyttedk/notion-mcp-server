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

  // A path is only streamed once it is known to exist (see 'unreadable file
  // sources' below), so tests that mean to exercise the local-path branch must
  // say so. Once, never for the whole file: elsewhere the same shape of string
  // is meant to be read as base64.
  const pathExistsOnce = () => vi.mocked(fs.statSync).mockReturnValueOnce({ isFile: () => true } as any)

  it('should handle file uploads with FormData', async () => {
    const mockFormData = new FormData()
    const mockFileStream = { pipe: vi.fn() }
    const mockFormDataHeaders = { 'content-type': 'multipart/form-data; boundary=---123' }

    pathExistsOnce()
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

  // The file is there but cannot be opened (permissions, a broken device).
  // That is a genuine read failure and keeps upstream's wrapped message; the
  // separate case of a path that is simply not on this machine is covered in
  // 'unreadable file sources' below.
  it('should throw error when an existing file cannot be read', async () => {
    pathExistsOnce()
    vi.mocked(fs.createReadStream).mockImplementation(() => {
      throw new Error('EACCES: permission denied')
    })

    const uploadPath = mockOpenApiSpec.paths['/upload']
    if (!uploadPath?.post) {
      throw new Error('Upload path not found in spec')
    }
    const operation = uploadPath.post as OpenAPIV3.OperationObject & { method: string; path: string }
    const params = {
      file: '/unreadable/file.txt',
      description: 'Test file',
    }

    await expect(client.executeOperation(operation, params)).rejects.toThrow('Failed to read file at /unreadable/file.txt')
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

    // The reported incident: a screenshot encoded on the caller's own machine
    // was refused. Whitespace used to be tolerated only ahead of the padding,
    // so base64 ending `==` plus a newline — what `base64`, `openssl base64`,
    // `certutil -encode` and Python's `base64.encodebytes` all emit whenever
    // the file's length is not a multiple of three — failed the shape test and
    // came back as "no such file", advising the caller to send the very thing
    // they had sent.
    it('decodes padded base64 that ends with a newline, as command-line encoders emit', async () => {
      const padded = Buffer.from('screenshot bytes that need padding') // 34 bytes -> '==' padding
      expect(padded.toString('base64')).toMatch(/==$/)
      const call = await runUpload(`${padded.toString('base64')}\n`)
      expect(call?.[1]).toBeInstanceOf(Buffer)
      expect((call?.[1] as Buffer).equals(padded)).toBe(true)
      expect(fs.createReadStream).not.toHaveBeenCalled()
    })

    it('decodes base64 wrapped at 76 columns with a trailing newline', async () => {
      const bytes = Buffer.from('x'.repeat(499) + 'y') // 500 bytes -> '=' padding
      expect(bytes.toString('base64')).toMatch(/=$/)
      const wrapped = `${(bytes.toString('base64').match(/.{1,76}/g) ?? []).join('\n')}\n`
      expect(wrapped).toContain('\n')
      const call = await runUpload(wrapped)
      expect((call?.[1] as Buffer).equals(bytes)).toBe(true)
      expect(fs.createReadStream).not.toHaveBeenCalled()
    })

    // The url-safe alphabet (RFC 4648 §5) spells the same bytes with '-' and
    // '_'. It used to match neither shape test, so the value fell through to
    // the path branch and came back as "no such file" — an error about the
    // filesystem for a payload that never named a file.
    describe('base64url', () => {
      // Encodes to '/++/' per three bytes, i.e. '_--_' url-safe, so every
      // payload below genuinely exercises both substituted characters.
      const urlSafeBytes = (groups: number) => Buffer.from(Array.from({ length: groups * 3 }, (_, i) => [0xff, 0xef, 0xbf][i % 3]))
      const toBase64Url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_')

      it('round-trips an unpadded base64url payload to the original bytes', async () => {
        const bytes = urlSafeBytes(8) // 24 bytes: a whole number of groups, so no padding
        const encoded = toBase64Url(bytes)
        expect(encoded).toMatch(/-/)
        expect(encoded).toMatch(/_/)
        expect(encoded).not.toContain('=')

        const call = await runUpload(encoded)
        expect(call?.[1]).toBeInstanceOf(Buffer)
        expect((call?.[1] as Buffer).equals(bytes)).toBe(true)
        expect(fs.createReadStream).not.toHaveBeenCalled()
      })

      it('round-trips a padded base64url payload to the original bytes', async () => {
        const bytes = Buffer.concat([urlSafeBytes(8), Buffer.from([0xff])]) // 25 bytes -> '==' padding
        const encoded = toBase64Url(bytes)
        expect(encoded).toMatch(/-/)
        expect(encoded).toMatch(/_/)
        expect(encoded).toMatch(/==$/)

        const call = await runUpload(encoded)
        expect((call?.[1] as Buffer).equals(bytes)).toBe(true)
        expect(fs.createReadStream).not.toHaveBeenCalled()
      })

      // What most base64url encoders actually emit: padding omitted entirely,
      // so the length is not a multiple of four.
      it('round-trips base64url with the padding stripped, as encoders emit it', async () => {
        const bytes = Buffer.concat([urlSafeBytes(26), Buffer.from([0xff, 0xef])]) // 80 bytes
        const encoded = toBase64Url(bytes).replace(/=+$/, '')
        expect(encoded.length % 4).not.toBe(0)

        const call = await runUpload(encoded)
        expect((call?.[1] as Buffer).equals(bytes)).toBe(true)
        expect(fs.createReadStream).not.toHaveBeenCalled()
      })

      // A string mixing the two alphabets is valid base64 in neither, so it is
      // still not read as bytes.
      it('does not read a value mixing both alphabets as base64', async () => {
        await expect(runUpload('AAAA+AAA_AAA')).rejects.toThrow(/no such file on the machine running this server/)
      })
    })

    // The length dimension of the defect the base64url block above fixes for
    // the alphabet. An encoder that omits the padding leaves 4n+2 or 4n+3
    // characters, which under 100 characters satisfied neither length clause,
    // so a small file came back as "no such file on the machine running this
    // server" — a filesystem error for a value that never named a file.
    describe('short unpadded payloads', () => {
      const unpadded = (buf: Buffer) => buf.toString('base64').replace(/=+$/, '')

      it('round-trips a short unpadded standard-base64 payload', async () => {
        const bytes = Buffer.from('Ten bytes!') // 10 bytes -> 14 characters once the padding is dropped
        const encoded = unpadded(bytes)
        expect(encoded.length).toBeLessThan(100)
        expect(encoded.length % 4).not.toBe(0)

        const call = await runUpload(encoded)
        expect(call?.[1]).toBeInstanceOf(Buffer)
        expect((call?.[1] as Buffer).equals(bytes)).toBe(true)
        expect(fs.createReadStream).not.toHaveBeenCalled()
      })

      it('round-trips a short unpadded base64url payload', async () => {
        const bytes = Buffer.concat([Buffer.from('Note'), Buffer.from([0xff, 0xbf, 0xff])]) // 7 bytes -> 10 characters
        const encoded = unpadded(bytes).replace(/\+/g, '-').replace(/\//g, '_')
        expect(encoded).toMatch(/[-_]/)
        expect(encoded.length).toBeLessThan(100)
        expect(encoded.length % 4).not.toBe(0)

        const call = await runUpload(encoded)
        expect((call?.[1] as Buffer).equals(bytes)).toBe(true)
        expect(fs.createReadStream).not.toHaveBeenCalled()
      })

      // The reason the widened length is guarded rather than free: these are the
      // values it would otherwise decode into junk bytes and upload as if they
      // were the file. A lowercase word, with or without path segments, is a
      // name someone typed — not the output of an encoder.
      it.each(['report', 'notes-2', 'docs/report'])('still resolves the hand-written name %s as a path', async (name) => {
        await expect(runUpload(name)).rejects.toThrow(/no such file on the machine running this server/)
        expect(fs.createReadStream).not.toHaveBeenCalled()
      })

      // No base64 encoder can emit a 4n+1-length value, so that length is never
      // a payload however much it looks like one.
      it('still resolves a 4n+1-length value as a path', async () => {
        expect('Abcde'.length % 4).toBe(1)
        await expect(runUpload('Abcde')).rejects.toThrow(/no such file on the machine running this server/)
      })

      it('prefers an existing file over decoding it, even when its name reads as base64', async () => {
        pathExistsOnce()
        const stream = { pipe: vi.fn() }
        vi.mocked(fs.createReadStream).mockReturnValue(stream as any)
        const call = await runUpload('Report') // 6 characters, uppercase: base64-shaped by the rule above
        expect(fs.createReadStream).toHaveBeenCalledWith('Report')
        expect(call?.[1]).toBe(stream)
      })

    })

    // The 4n length was accepted outright from the fork's first version, so a
    // short lowercase extensionless name whose length happens to be a multiple
    // of four was decoded to junk bytes and uploaded as if it were the file:
    // a mistyped path reported back as a success. The veto is four conditions
    // deep precisely so it takes that shape and nothing else with it.
    describe('the mistyped-name veto on 4n lengths', () => {
      it.each(['plan', 'my-notes', 'project-plan', 'quarterly-report'])(
        'resolves the 4n-length lowercase name %s as a path instead of decoding it',
        async (name) => {
          expect(name.length % 4).toBe(0)
          await expect(runUpload(name)).rejects.toThrow(/no such file on the machine running this server/)
          expect(fs.createReadStream).not.toHaveBeenCalled()
        },
      )

      // The caller of a real short payload must be able to tell this refusal
      // from an ordinary missing file, or the remedy is invisible.
      it('names the remedy when the refused value could also have been base64', async () => {
        await expect(runUpload('my-notes')).rejects.toThrow(/send it with its base64 padding, as a data: URI, or alongside content_length/)
      })

      // A genuine path carries no such hint: it was never readable as bytes.
      it('leaves the message alone for a value that is not base64-shaped at all', async () => {
        const promise = runUpload('/home/agent/notes.txt')
        await expect(promise).rejects.toThrow(/no such file on the machine running this server/)
        await expect(promise).rejects.not.toThrow(/base64 padding/)
      })

      // What the earlier fix protected by leaving the 4n case alone, and what
      // the content check keeps protecting now: an all-lowercase group is real
      // base64 often enough to matter, and here it decodes to printable text.
      it('still decodes an all-lowercase 4n payload whose bytes are printable text', async () => {
        expect(Buffer.from('omc').toString('base64')).toBe('b21j')
        const call = await runUpload('b21j')
        expect((call?.[1] as Buffer).equals(Buffer.from('omc'))).toBe(true)
        expect(fs.createReadStream).not.toHaveBeenCalled()
      })

      // A JPEG's first three bytes encode to '/9j/' — no uppercase, no '+', and
      // a '/' in the bargain, i.e. every name signal there is. The magic-prefix
      // branch is what keeps real image bytes out of the veto.
      // It is refused further down — three bytes of a JPEG is a truncated file
      // and the integrity guard says so — but by the payload diagnosis, not by
      // the filesystem. That is the whole point: it was read as bytes.
      it('still reads a payload that opens with a known file header as bytes', async () => {
        const jpegHead = Buffer.from([0xff, 0xd8, 0xff])
        expect(jpegHead.toString('base64')).toBe('/9j/')
        const promise = runUpload('/9j/')
        await expect(promise).rejects.toThrow(/JPEG payload is incomplete/)
        await expect(promise).rejects.not.toThrow(/no such file/)
      })

      // The cap. Structured binary can be all-lowercase at any length — the
      // base64url fixture above is 32 such characters of genuine payload — so
      // the veto only ever looks at values short enough to be a typed word.
      it.each([
        ['4bz/wtiop0lk4olpfiyx', 15],
        ['cgapdyl3csos1qqotc24', 15],
      ])('still decodes the all-lowercase payload %s, which is past the length cap', async (encoded, bytes) => {
        expect(encoded.length).toBeGreaterThan(16)
        const call = await runUpload(encoded)
        expect((call?.[1] as Buffer).length).toBe(bytes)
        expect(fs.createReadStream).not.toHaveBeenCalled()
      })

      // Padding is an encoder's signature, and never part of a filename.
      it('still decodes a short all-lowercase payload that carries its padding', async () => {
        const bytes = Buffer.from([0xa6, 0x56, 0xa7, 0xa6])
        const encoded = bytes.toString('base64')
        expect(encoded).toMatch(/=$/)
        expect(encoded).not.toMatch(/[A-Z+]/)
        const call = await runUpload(encoded)
        expect((call?.[1] as Buffer).equals(bytes)).toBe(true)
      })

      // A stated size settles what the value is, so the veto steps aside — and
      // a wrong reading would be caught by the length check rather than stored.
      it('decodes a vetoed value as bytes when content_length says so', async () => {
        const call = await runUpload('my-notes', { content_length: 6 })
        expect(call?.[1]).toBeInstanceOf(Buffer)
        expect((call?.[1] as Buffer).length).toBe(6)
        expect(fs.createReadStream).not.toHaveBeenCalled()
      })

      // Documented residual, unchanged by this fix and not chased further: a
      // 3-12 byte payload of random binary whose base64 is all lowercase and
      // unpadded reads as a name and is refused. The bytes are junk to look at
      // either way; the message says how to send them regardless.
      it.each(['/nly', 'wrg0rimc', '4168s7itdlg/dset'])(
        'refuses the genuine but unprovable short binary payload %s',
        async (encoded) => {
          expect(encoded.length % 4).toBe(0)
          expect(encoded).not.toMatch(/[A-Z+=]/)
          await expect(runUpload(encoded)).rejects.toThrow(/no such file on the machine running this server/)
        },
      )

      it('prefers an existing file over the veto, so a real path always wins', async () => {
        pathExistsOnce()
        const stream = { pipe: vi.fn() }
        vi.mocked(fs.createReadStream).mockReturnValue(stream as any)
        const call = await runUpload('my-notes')
        expect(fs.createReadStream).toHaveBeenCalledWith('my-notes')
        expect(call?.[1]).toBe(stream)
      })
    })

    // Length is no longer the signal, so an existing file must still win —
    // otherwise a stdio path made only of base64 characters would be decoded.
    it('prefers a local file that actually exists over reading it as base64', async () => {
      pathExistsOnce()
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
      pathExistsOnce()
      const stream = { pipe: vi.fn() }
      vi.mocked(fs.createReadStream).mockReturnValue(stream as any)
      const call = await runUpload('/path/to/test.txt')
      expect(fs.createReadStream).toHaveBeenCalledWith('/path/to/test.txt')
      expect(call?.[1]).toBe(stream)
    })
  })

  // The reported incident: an agent on another machine passed the path of a
  // screenshot it had just taken, got a bare ENOENT naming no alternative, and
  // concluded that attaching a file was impossible — so the screenshot was
  // dropped. createReadStream never throws for a missing file (it emits ENOENT
  // asynchronously, past every catch here), so the check has to come first.
  describe('unreadable file sources', () => {
    const uploadPath = () => {
      const op = mockOpenApiSpec.paths['/upload']!.post as OpenAPIV3.OperationObject & { method: string; path: string }
      vi.spyOn(FormData.prototype, 'append').mockImplementation(() => {})
      vi.spyOn(FormData.prototype, 'getHeaders').mockReturnValue({})
      mockApiInstance.uploadFile.mockResolvedValue({ data: { success: true }, status: 200, headers: {} })
      return op
    }

    it('refuses a path that is not on this machine, and never opens a stream', async () => {
      const promise = client.executeOperation(uploadPath(), { file: '/home/agent/screenshots/shot.png' })
      await expect(promise).rejects.toThrow(/no such file on the machine running this server/)
      expect(fs.createReadStream).not.toHaveBeenCalled()
      expect(mockApiInstance.uploadFile).not.toHaveBeenCalled()
    })

    it('names every input form the server does accept', async () => {
      const promise = client.executeOperation(uploadPath(), { file: '/home/agent/screenshots/shot.png' })
      // What the caller needs in order to retry successfully, rather than a
      // bare errno that reads as "this feature does not work".
      await expect(promise).rejects.toThrow(/data: URI/)
      await expect(promise).rejects.toThrow(/base64/)
      await expect(promise).rejects.toThrow(/http\(s\) URL/)
      await expect(promise).rejects.toThrow(/stdio/)
    })

    it('reports the basename only, never the directories around it', async () => {
      const promise = client.executeOperation(uploadPath(), { file: 'C:\\Users\\someone\\Desktop\\shot.png' })
      await expect(promise).rejects.toThrow(/'shot\.png'/)
      // A path leaks the caller's username and folder layout into an error that
      // gets pasted into tickets and chat logs.
      await expect(promise).rejects.toThrow(/^(?!.*someone)/s)
      await expect(promise).rejects.toThrow(/^(?!.*Desktop)/s)
    })

    it('does not wrap the diagnosis in upstream "Failed to read file at"', async () => {
      const promise = client.executeOperation(uploadPath(), { file: '/home/agent/shot.png' })
      await expect(promise).rejects.toThrow(/^(?!.*Failed to read file at)/s)
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

    pathExistsOnce()
    pathExistsOnce()
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
