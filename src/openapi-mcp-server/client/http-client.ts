import type { OpenAPIV3, OpenAPIV3_1 } from 'openapi-types'
import OpenAPIClientAxios from 'openapi-client-axios'
import type { AxiosInstance } from 'axios'
import FormData from 'form-data'
import fs from 'fs'
import { Headers } from './polyfill-headers'
import { isFileUploadParameter } from '../openapi/file-upload'

export type HttpClientConfig = {
  baseUrl: string
  headers?: Record<string, string>
}

export type HttpClientResponse<T = any> = {
  data: T
  status: number
  headers: Headers
}

/** Only base64 characters (whitespace tolerated), with optional padding. */
const BARE_BASE64_CHARS = /^[A-Za-z0-9+/\s]+={0,2}$/

/**
 * Whether a file-parameter value is inline base64 rather than a path.
 *
 * Length used to be the signal (100+ characters), which broke on tiny files:
 * a 45-byte note encodes to ~60 characters and was taken for a path that does
 * not exist. Shape is the better signal — base64 as emitted by any encoder is
 * canonically padded to a multiple of four, which a path essentially never is
 * unless it also avoids `.`, `\` and `/` entirely.
 */
function isBareBase64(source: string): boolean {
  if (!BARE_BASE64_CHARS.test(source)) return false
  const compact = source.replace(/\s+/g, '')
  if (compact.length === 0) return false
  // The 100+ clause is the fork's original rule, kept so long payloads that
  // arrive without padding keep working.
  return compact.length % 4 === 0 || compact.length >= 100
}

/**
 * Whether the value names a file that exists on this machine. An existing file
 * always wins over the base64 reading, so stdio callers passing a real path are
 * unaffected no matter what the path looks like.
 */
function localFileExists(source: string): boolean {
  // A path is bounded; never hand megabytes of base64 to the filesystem.
  if (source.length > 4096) return false
  try {
    return fs.statSync(source).isFile()
  } catch {
    return false
  }
}

export class HttpClientError extends Error {
  constructor(
    message: string,
    public status: number,
    public data: any,
    public headers?: Headers,
  ) {
    super(`${status} ${message}`)
    this.name = 'HttpClientError'
  }
}

export class HttpClient {
  private api: Promise<AxiosInstance>
  private client: OpenAPIClientAxios
  private config: HttpClientConfig
  private openApiSpec: OpenAPIV3.Document | OpenAPIV3_1.Document

  constructor(config: HttpClientConfig, openApiSpec: OpenAPIV3.Document | OpenAPIV3_1.Document) {
    this.config = config
    this.openApiSpec = openApiSpec
    // @ts-expect-error
    this.client = new (OpenAPIClientAxios.default ?? OpenAPIClientAxios)({
      definition: openApiSpec,
      axiosConfigDefaults: {
        baseURL: config.baseUrl,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'notion-mcp-server',
          ...config.headers,
        },
      },
    })
    this.api = this.client.init()
  }

  /**
   * Resolve a possibly-$ref'd parameter to its inline definition.
   * Only local refs (e.g. `#/components/parameters/notionVersion`) are supported.
   */
  private resolveParameter(
    param: OpenAPIV3.ParameterObject | OpenAPIV3.ReferenceObject,
  ): OpenAPIV3.ParameterObject | null {
    if (!('$ref' in param)) {
      return param as OpenAPIV3.ParameterObject
    }
    const ref = param.$ref
    if (!ref.startsWith('#/')) {
      return null
    }
    let node: any = this.openApiSpec
    for (const segment of ref.slice(2).split('/')) {
      node = node?.[segment]
      if (node === undefined) return null
    }
    return node && node.name ? (node as OpenAPIV3.ParameterObject) : null
  }

  /**
   * Build the server-managed header parameters declared on an operation.
   *
   * Header parameters (currently `Notion-Version`) are not exposed as tool
   * inputs; their value comes from the operation's header-parameter `default`
   * in the OpenAPI spec. This lets each endpoint pin the API version it needs —
   * e.g. the page-markdown endpoints require `2026-03-11` while the rest of the
   * API stays on `2025-09-03`. A header the caller configured globally (via
   * HttpClientConfig.headers) takes precedence and is left untouched.
   */
  private buildDefaultHeaders(operation: OpenAPIV3.OperationObject): Record<string, string> {
    const configured = new Set(Object.keys(this.config.headers ?? {}).map((key) => key.toLowerCase()))
    const headers: Record<string, string> = {}
    for (const param of operation.parameters ?? []) {
      const resolved = this.resolveParameter(param)
      if (!resolved || resolved.in !== 'header' || configured.has(resolved.name.toLowerCase())) {
        continue
      }
      const schema = resolved.schema as OpenAPIV3.SchemaObject | undefined
      if (schema && schema.default !== undefined) {
        headers[resolved.name] = String(schema.default)
      }
    }
    return headers
  }

  private async prepareFileUpload(
    operation: OpenAPIV3.OperationObject,
    params: Record<string, any>,
  ): Promise<{ formData: FormData; uploadedBytes: number | null } | null> {
    const fileParams = isFileUploadParameter(operation)
    if (fileParams.length === 0) return null

    const formData = new FormData()

    // Fork fix (content-type mismatch): Notion validates the multipart part's
    // Content-Type against the content_type declared at the create step, but
    // form-data can only guess the type from the filename we pass — and when
    // the caller omits one the fallback was the param name ('file'), which has
    // no extension and becomes application/octet-stream, so the send is
    // rejected. For the send endpoint, look the upload up and reuse the exact
    // filename and content_type recorded at the create step, as the tool docs
    // promise.
    let declared: { filename?: string; contentType?: string } | undefined
    if (operation.operationId === 'send-a-file-upload' && typeof params.file_upload_id === 'string') {
      try {
        const api = await this.api
        const retrieve = (api as any)['retrieve-a-file-upload']
        if (retrieve) {
          const res = await retrieve({ file_upload_id: params.file_upload_id }, undefined, {
            headers: this.buildDefaultHeaders(operation),
          })
          declared = {
            filename: res?.data?.filename ?? undefined,
            contentType: res?.data?.content_type ?? undefined,
          }
        }
      } catch {
        // Best effort: without the record we fall back to the type carried by
        // the source below, and a genuinely bad id fails on the send itself.
      }
    }

    // Byte count of the file payload(s) we actually append, used by
    // executeOperation to detect a truncated store. Only the buffer-producing
    // branches below (data: URI, bare base64, fetched URL — the remote sources
    // where truncation was seen) are measurable; the local-path stream branch
    // sets this to null, disabling the guard for stdio use.
    let uploadedBytes = 0
    let measurable = true

    // Handle file uploads
    for (const param of fileParams) {
      const filePath = params[param]
      if (!filePath) {
        throw new Error(`File path must be provided for parameter: ${param}`)
      }
      const addFile = async (name: string, source: string) => {
        // Upstream only accepted a local filesystem path. That is meaningless
        // for a remotely hosted server, which shares no disk with the caller,
        // so also accept the bytes inline (data: URI or bare base64) or a URL
        // the server can fetch. The path branch is kept for stdio use.
        try {
          const filename = typeof params.filename === 'string' ? params.filename : declared?.filename ?? name

          // Pass the part's Content-Type explicitly: Notion's recorded
          // content_type first, else the type the source itself carries
          // (stripped of parameters like charset). With neither, form-data
          // falls back to guessing from the filename as before.
          const appendBuffer = (buf: Buffer, sourceType?: string | null) => {
            uploadedBytes += buf.length
            const contentType = declared?.contentType ?? (sourceType ? sourceType.split(';')[0].trim() : undefined)
            formData.append(name, buf, contentType ? { filename, contentType } : { filename })
          }

          if (/^data:/i.test(source)) {
            const b64 = source.slice(source.indexOf(',') + 1)
            const mediaType = /^data:([^;,]+)/i.exec(source)?.[1]
            appendBuffer(Buffer.from(b64, 'base64'), mediaType)
            return
          }

          if (/^https?:\/\//i.test(source)) {
            const res = await fetch(source)
            if (!res.ok) {
              throw new Error(`GET ${source} returned ${res.status}`)
            }
            appendBuffer(Buffer.from(await res.arrayBuffer()), res.headers?.get?.('content-type'))
            return
          }

          // Bare base64, of any length: a tiny file's base64 is only a few
          // characters, so length cannot be the signal. An existing file on
          // disk still wins, which keeps stdio paths working.
          if (isBareBase64(source) && !localFileExists(source)) {
            appendBuffer(Buffer.from(source, 'base64'))
            return
          }

          // Local filesystem path (stdio only): size is not tracked here, so the
          // truncation guard is disabled for this file.
          measurable = false
          formData.append(name, fs.createReadStream(source))
        } catch (error) {
          // Keep upstream's message (it names the source, which is what you
          // need to debug) but truncate: `source` may be megabytes of base64.
          const shown = source.length > 80 ? `${source.slice(0, 80)}...` : source
          throw new Error(`Failed to read file at ${shown}: ${error}`)
        }
      }

      switch (typeof filePath) {
        case 'string':
          await addFile(param, filePath)
          break
        case 'object':
          if (Array.isArray(filePath)) {
            for (const file of filePath) {
              await addFile(param, file)
            }
            break
          }
          //deliberate fallthrough
        default:
          throw new Error(`Unsupported file type: ${typeof filePath}`)
      }
    }

    // Add non-file parameters to form data. `filename` is consumed above as
    // the file part's metadata, not a form field of its own.
    for (const [key, value] of Object.entries(params)) {
      if (!fileParams.includes(key) && key !== 'filename') {
        formData.append(key, value)
      }
    }

    return { formData, uploadedBytes: measurable ? uploadedBytes : null }
  }

  /**
   * Execute an OpenAPI operation
   */
  async executeOperation<T = any>(
    operation: OpenAPIV3.OperationObject & { method: string; path: string },
    params: Record<string, any> = {},
  ): Promise<HttpClientResponse<T>> {
    const api = await this.api
    const operationId = operation.operationId
    if (!operationId) {
      throw new Error('Operation ID is required')
    }

    // Handle file uploads if present
    const upload = await this.prepareFileUpload(operation, params)
    const formData = upload?.formData ?? null

    // Separate parameters based on their location
    const urlParameters: Record<string, any> = {}
    const bodyParams: Record<string, any> = formData || { ...params }

    // Extract path and query parameters based on operation definition
    if (operation.parameters) {
      for (const param of operation.parameters) {
        if ('name' in param && param.name && param.in) {
          if (param.in === 'path' || param.in === 'query') {
            if (params[param.name] !== undefined) {
              urlParameters[param.name] = params[param.name]
              if (!formData) {
                delete bodyParams[param.name]
              }
            }
          }
        }
      }
    }

    // Add all parameters as url parameters if there is no requestBody defined
    if (!operation.requestBody && !formData) {
      for (const key in bodyParams) {
        if (bodyParams[key] !== undefined) {
          urlParameters[key] = bodyParams[key]
          delete bodyParams[key]
        }
      }
    }

    const operationFn = (api as any)[operationId]
    if (!operationFn) {
      throw new Error(`Operation ${operationId} not found`)
    }

    try {
      // If we have form data, we need to set the correct headers
      const hasBody = Object.keys(bodyParams).length > 0
      const headers = formData
        ? formData.getHeaders()
        : { ...(hasBody ? { 'Content-Type': 'application/json' } : { 'Content-Type': null }) }
      const requestConfig = {
        headers: {
          ...this.buildDefaultHeaders(operation),
          ...headers,
        },
      }

      // first argument is url parameters, second is body parameters
      const response = await operationFn(urlParameters, hasBody ? bodyParams : undefined, requestConfig)

      // Convert axios headers to Headers object
      const responseHeaders = new Headers()
      Object.entries(response.headers).forEach(([key, value]) => {
        if (value) responseHeaders.append(key, value.toString())
      })

      // Fork guard (file-upload patch): Notion accepts a truncated single-part
      // upload, stores only the fragment, and still returns a normal success
      // object — so a short store is silent corruption. When we know how many
      // bytes we sent and Notion reports a different content_length, fail loud
      // instead of returning a corrupt attachment as success.
      if (upload && upload.uploadedBytes !== null) {
        const stored = (response.data as any)?.content_length
        if (stored !== undefined && stored !== null) {
          const storedBytes = Number(stored)
          if (!Number.isNaN(storedBytes) && storedBytes !== upload.uploadedBytes) {
            throw new HttpClientError(
              `File upload truncated: sent ${upload.uploadedBytes} bytes but Notion stored ${storedBytes}`,
              response.status,
              response.data,
              responseHeaders,
            )
          }
        }
      }

      return {
        data: response.data,
        status: response.status,
        headers: responseHeaders,
      }
    } catch (error: any) {
      if (error.response) {
        // Only log errors in non-test environments to keep test output clean
        if (process.env.NODE_ENV !== 'test') {
          console.error('Error in http client', {
            status: error.response.status,
            statusText: error.response.statusText,
          })
        }
        const headers = new Headers()
        Object.entries(error.response.headers).forEach(([key, value]) => {
          if (value) headers.append(key, value.toString())
        })

        throw new HttpClientError(error.response.statusText || 'Request failed', error.response.status, error.response.data, headers)
      }
      throw error
    }
  }
}
