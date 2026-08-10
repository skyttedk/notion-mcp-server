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

/** Only base64 characters, once whitespace is stripped, with optional padding. */
const BARE_BASE64_CHARS = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * The url-safe alphabet (RFC 4648 §5), which spells the same bytes with `-` for
 * `+` and `_` for `/`, and usually without padding.
 *
 * Tested separately rather than by widening the standard pattern, so a string
 * mixing the two alphabets — valid in neither — is still not read as base64.
 */
const BARE_BASE64URL_CHARS = /^[A-Za-z0-9_-]+={0,2}$/

/** The url-safe alphabet spelled back as the standard one, so Node can decode it. */
function toStandardBase64(compact: string): string {
  return compact.replace(/-/g, '+').replace(/_/g, '/')
}

/**
 * Whether a file-parameter value is inline base64 rather than a path.
 *
 * Length used to be the signal (100+ characters), which broke on tiny files:
 * a 45-byte note encodes to ~60 characters and was taken for a path that does
 * not exist. Shape is the better signal — base64 as emitted by any encoder is
 * canonically padded to a multiple of four, which a path essentially never is
 * unless it also avoids `.`, `\` and `/` entirely.
 *
 * Whitespace is stripped before the shape is judged, not tolerated inside the
 * pattern. Tolerating it inside only worked ahead of the padding, so base64
 * that ended `==` followed by a newline — the exact output of `base64`,
 * `openssl base64`, `certutil -encode` and Python's `base64.encodebytes`,
 * whenever the file's length is not a multiple of three — failed the test and
 * was reported as a missing file. The caller was then told to send "a bare
 * base64 string", which is what they had just sent: a screenshot could be
 * encoded correctly and still be unattachable, with nothing in the message
 * pointing at the trailing newline.
 *
 * Both alphabets count. A base64url payload used to match neither pattern, so
 * it fell through to the path branch and came back as "no such file" — an error
 * about the filesystem for a value that never named a file.
 *
 * The alphabet was only half the problem: the length rule missed the same case.
 * A short file encoded WITHOUT padding — what most base64url encoders emit, and
 * what `-w0 | tr -d '='` style pipelines produce for standard base64 too — has a
 * length of 4n+2 or 4n+3, so under 100 characters it satisfied neither clause and
 * was reported as a missing file. Those two lengths are therefore accepted as
 * well, guarded by `looksLikeWrittenName` below.
 *
 * Deliberately additive: every value accepted before is still accepted, exactly
 * as before, and the guard only decides the newly-admitted lengths. Applying it
 * to the 4n case as well would have vetoed genuine short base64 that happens to
 * be all lowercase — about 3% of 6-byte payloads, and 12% of 3-byte ones — which
 * is a live path, whereas the name it would protect (`my-notes`, length 8) is a
 * hypothetical one. That residual false positive is unchanged from before this
 * fix, not introduced by it.
 */
function isBareBase64(source: string): boolean {
  const compact = source.replace(/\s+/g, '')
  if (compact.length === 0) return false
  if (!BARE_BASE64_CHARS.test(compact) && !BARE_BASE64URL_CHARS.test(compact)) return false
  // The 100+ clause is the fork's original rule, kept so long payloads that
  // arrive without padding keep working.
  if (compact.length % 4 === 0 || compact.length >= 100) return true
  // 4n+1 is not a length any base64 encoder can produce, so it is never a
  // payload and always stays a path.
  if (compact.length % 4 === 1) return false
  return !looksLikeWrittenName(compact)
}

/**
 * Whether a short, charset-valid value reads as a hand-written relative name
 * (`report`, `notes-2`, `docs/report`) rather than as encoded bytes.
 *
 * Two signals, both cheap. A `/` says the value is spelled in path segments —
 * `/` is a legal standard-base64 character, which is why this only ever vetoes
 * the newly-admitted lengths and never a value that was accepted before. And
 * filename words are lowercase, digits and separators, while base64 over real
 * file bytes almost always carries an uppercase letter or a `+` (three quarters
 * of a random 4-character group do, and the odds compound with every group).
 *
 * The remaining false negative — an all-lowercase 4n+2/4n+3 payload — behaves
 * exactly as it did before this fix, i.e. it is reported as a missing file, with
 * a message that names the accepted input forms. The false positive it prevents
 * is worse: an extensionless name that does not exist would be decoded to junk
 * bytes and uploaded as if it were the file. An existing file on disk always
 * wins over either reading, so stdio callers are untouched.
 */
function looksLikeWrittenName(compact: string): boolean {
  return compact.includes('/') || !/[A-Z+]/.test(compact)
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

/**
 * A file payload that is provably not the whole file. Thrown before anything is
 * sent, and re-thrown unwrapped so the caller reads the diagnosis rather than
 * `Failed to read file at <80 characters of base64>…`.
 */
class UploadPayloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UploadPayloadError'
  }
}

/**
 * A file source this server cannot read at all — in practice a path on the
 * caller's machine, sent to a deployment that shares no disk with it. Also
 * re-thrown unwrapped, for the same reason as above.
 */
class UploadSourceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UploadSourceError'
  }
}

/**
 * The tail of a path, for use in an error message.
 *
 * Never echo the whole value: a path carries the caller's username and folder
 * names, and a non-path source can be megabytes of base64.
 */
function describeSource(source: string): string {
  const tail = source.split(/[\\/]/).pop() || source
  return tail.length > 60 ? `${tail.slice(0, 60)}...` : tail
}

/**
 * The first character that belongs to neither alphabet nor to the padding.
 * Whitespace never reaches this: it is stripped beforehand, deliberately, since
 * encoders wrap their output and a newline shifts nothing.
 *
 * `=` is excluded here so a misplaced one keeps its own, more specific
 * diagnosis below rather than being reported as a foreign character.
 */
const NON_BASE64_CHAR = /[^A-Za-z0-9+/\-_=]/

/**
 * One character, rendered for an error message. Printable ASCII is shown as
 * itself as well as by code point, because the offender is typically invisible
 * or indistinguishable from a legitimate one — a non-breaking hyphen, a smart
 * quote, a stray NUL — and quoting it alone would read as nonsense.
 */
function describeCharAt(text: string, index: number): string {
  const code = text.codePointAt(index) ?? 0
  const hex = `U+${code.toString(16).toUpperCase().padStart(4, '0')}`
  return code > 0x20 && code < 0x7f ? `'${String.fromCodePoint(code)}' (${hex})` : hex
}

/**
 * Decode inline base64, refusing input that cannot be a complete payload.
 *
 * Node's base64 decoder is deliberately forgiving: it skips characters outside
 * the alphabet and stops dead at the first `=`, so a payload that lost its tail
 * in transit decodes to a short buffer instead of failing. Three shapes are
 * provable corruption and are rejected here rather than uploaded:
 *
 *  - a character outside both alphabets. Skipping it does not merely drop that
 *    character: it pulls every following character back into the previous
 *    4-character group, so from that point on the decoded bytes are re-cut
 *    across the wrong boundaries and the file is garbage — at a length within
 *    a byte of correct, which is why nothing downstream notices. A declared
 *    content_length only catches this when the caller states the true source
 *    size; state one derived from the corrupted text and it agrees;
 *  - a length of `4n + 1`, which no encoder can produce (a base64 string is
 *    4n, 4n+2 or 4n+3 characters — unpadded tails are accepted, since the
 *    fork already takes payloads that arrive without padding);
 *  - a `=` anywhere but in the final padding, which silently ends the decode
 *    at that point and would store only the bytes before it.
 */
function decodeBase64Payload(b64: string): Buffer {
  const compact = b64.replace(/\s+/g, '')
  const foreign = NON_BASE64_CHAR.exec(compact)
  if (foreign) {
    throw new UploadPayloadError(
      `The base64 payload contains ${describeCharAt(compact, foreign.index)} at character ${foreign.index}, which is ` +
        `not a base64 character. Decoding skips it and re-cuts every byte after it, so the file would be stored ` +
        `corrupted from that point on at very nearly the right size — nothing later in the chain can see that. ` +
        `Nothing was uploaded — re-encode the file and send the encoder's output unaltered.`,
    )
  }
  if (compact.length % 4 === 1) {
    throw new UploadPayloadError(
      `The base64 payload is truncated: ${compact.length} characters cannot be a complete base64 string. ` +
        `Send the whole file.`,
    )
  }
  const firstPad = compact.indexOf('=')
  if (firstPad !== -1 && firstPad < compact.length - 2) {
    throw new UploadPayloadError(
      `The base64 payload has padding ('=') at character ${firstPad} instead of at the end, so decoding it would ` +
        `silently stop there and store only part of the file. Send one continuous base64 string, not concatenated chunks.`,
    )
  }
  // Translated rather than handed straight to Node: current Node versions
  // happen to accept `-` and `_` under the 'base64' encoding, but that is
  // leniency, not a documented guarantee, and it would decode to silently wrong
  // bytes if it ever tightened. Spelling the alphabet back is unambiguous, and
  // a no-op for the standard one. The checks above run on the untranslated
  // string, whose `=` padding is the same in both alphabets.
  return Buffer.from(toStandardBase64(compact), 'base64')
}

/**
 * The byte length the caller states the payload has, or undefined when they
 * said nothing.
 *
 * This is the only fact that can prove a payload complete. Everything else this
 * file checks is inference from the bytes that arrived, and inference cannot
 * distinguish a small file from a big one that lost its tail on the way here.
 */
function readDeclaredLength(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const declared = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isInteger(declared) || declared < 0) {
    throw new UploadPayloadError(
      `content_length must be the payload's size in bytes as a whole number; received ${JSON.stringify(value)}.`,
    )
  }
  return declared
}

/** Both numbers, so the caller can see at a glance how much went missing. */
function describeLengthMismatch(actual: number, declared: number): string {
  const direction = actual < declared ? 'cut short on the way here' : 'longer than declared'
  return (
    `The payload is ${direction}: content_length says ${declared} bytes but ${actual} arrived. ` +
    `Nothing was uploaded — resend the whole file, or correct content_length if that number was wrong.`
  )
}

/**
 * Whether an encoded payload carries its own proof of being whole.
 *
 * A base64 encoder pads the final group with `=` whenever the file's length is
 * not a multiple of three, so terminal padding proves the encoder ran to the
 * end. Without it the string is either a complete multiple-of-three file or a
 * fragment cut at a group boundary, and the two are indistinguishable: the
 * reported incident was a payload cut to exactly 3,316 characters, which is a
 * whole number of groups, decodes cleanly to 2,487 bytes, and passes every
 * length rule below.
 */
function encodingProvesCompleteness(encoded: string): boolean {
  return encoded.replace(/\s+/g, '').endsWith('=')
}

/**
 * Below this many bytes an unprovable payload is accepted rather than refused.
 *
 * Two thirds of files encode with padding and are provable outright; the rest
 * are not, and refusing all of them would reject a third of every small
 * attachment — a note, an icon, a snippet — to protect against a cut that
 * cannot happen to them. Nothing in this path truncates a payload that arrives
 * whole inside one message: the two observed truncations arrived as 8,751 and
 * 2,487 bytes, both far above this line. So the demand for proof is made where
 * the risk is, and a declared content_length remains the answer at any size.
 */
const UNPROVABLE_PAYLOAD_LIMIT = 1024

/**
 * A size the file's own header states about itself: an unsigned little-endian
 * integer of `size` bytes at `offset`, counting every byte from position
 * `covers` onward. A whole file is therefore exactly `covers + value` bytes.
 *
 * `covers` is spelled out rather than folded into the number because getting it
 * wrong is the classic bug with these fields: RIFF's size counts from byte 8,
 * not from byte 0, so a naive comparison is off by exactly the eight bytes of
 * header it excludes. Little-endian only — that covers RIFF and BMP; the
 * ISO-BMFF formats (AVIF, HEIC) state their sizes big-endian and per box, so
 * they need box walking rather than one field, and no unused knob here.
 */
type LengthField = { offset: number; size: number; covers: number }

/**
 * Byte signature plus whatever the format offers as proof of being whole: a
 * trailer at the end of the file (`endsWith`/`endMarker`), or a length the
 * header declares up front (`lengthField`).
 *
 * `alsoAt` carries further signature bytes at a fixed offset, for a container
 * whose leading magic is shared with other formats — RIFF also fronts WAV and
 * AVI, and only the tag at byte 8 says which one this is.
 */
const CONTAINER_FORMATS: {
  name: string
  magic: number[]
  alsoAt?: { offset: number; bytes: number[] }[]
  endsWith?: number[]
  endMarker?: string
  lengthField?: LengthField
}[] = [
  { name: 'PNG', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], endsWith: [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82] },
  { name: 'JPEG', magic: [0xff, 0xd8, 0xff], endsWith: [0xff, 0xd9] },
  { name: 'GIF', magic: [0x47, 0x49, 0x46, 0x38], endsWith: [0x3b] },
  { name: 'PDF', magic: [0x25, 0x50, 0x44, 0x46, 0x2d], endMarker: '%%EOF' },
  {
    // 'RIFF' …size… 'WEBP'. No trailer of any kind, so completeness is read off
    // the declared size instead — which needs no cooperation from the caller,
    // unlike a content_length. WebP is worth the extra mechanism because it is
    // what several screenshot tools and browsers now save by default.
    name: 'WebP',
    magic: [0x52, 0x49, 0x46, 0x46],
    alsoAt: [{ offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }],
    lengthField: { offset: 4, size: 4, covers: 8 },
  },
]

function startsWith(buf: Buffer, bytes: number[]): boolean {
  return buf.length >= bytes.length && bytes.every((byte, i) => buf[i] === byte)
}

function bytesAt(buf: Buffer, offset: number, bytes: number[]): boolean {
  return buf.length >= offset + bytes.length && bytes.every((byte, i) => buf[offset + i] === byte)
}

/**
 * Fork guard (silent corruption): what the bytes themselves say about whether
 * the file is whole.
 *
 * Notion stores whatever bytes it is given and reports the upload as
 * successful, and the byte-count guard further below only compares what we sent
 * with what Notion stored — identical numbers when the payload was already
 * short when it reached us. A 43,627-byte screenshot arrived as its first 8,751
 * bytes and was attached as a broken image with no error anywhere. The formats
 * listed above state either where they end or how long they are, so a missing
 * trailer — or a byte count short of the declared one — proves the file is
 * incomplete.
 *
 * The third verdict matters as much as the other two: for anything without a
 * known signature there is no opinion to give, and treating that silence as
 * "looks fine" is what let the second reported incident through. Callers act on
 * `unknown` by insisting the size be declared instead.
 */
type ContainerVerdict = { status: 'complete' } | { status: 'incomplete'; message: string } | { status: 'unknown' }

function judgeContainer(buf: Buffer): ContainerVerdict {
  for (const format of CONTAINER_FORMATS) {
    if (!startsWith(buf, format.magic)) continue
    // Not yet enough bytes to tell this container from another with the same
    // leading magic: no signature, so no opinion.
    if (format.alsoAt?.some(({ offset, bytes }) => !bytesAt(buf, offset, bytes))) continue
    if (format.lengthField) {
      const { offset, size, covers } = format.lengthField
      if (buf.length < offset + size) return { status: 'unknown' }
      const expected = covers + buf.readUIntLE(offset, size)
      if (buf.length === expected) return { status: 'complete' }
      // Longer than declared is not truncation — every byte the header promises
      // did arrive — but it is not something this check understands either, so
      // it stays an open question for the guards that follow.
      if (buf.length > expected) return { status: 'unknown' }
      return {
        status: 'incomplete',
        message:
          `The ${format.name} payload is incomplete: its header declares a ${expected}-byte file but ${buf.length} bytes ` +
          `arrived, so it was cut short before it reached the server. Nothing was uploaded — send the whole file.`,
      }
    }
    if (format.endsWith) {
      const tail = buf.subarray(-format.endsWith.length)
      const complete = tail.length === format.endsWith.length && format.endsWith.every((byte, i) => tail[i] === byte)
      if (complete) return { status: 'complete' }
    } else if (format.endMarker) {
      // The marker sits at the very end, but may be followed by whitespace.
      if (buf.subarray(-1024).toString('latin1').includes(format.endMarker)) return { status: 'complete' }
    }
    return {
      status: 'incomplete',
      message:
        `The ${format.name} payload is incomplete: ${buf.length} bytes ending without the format's end-of-file marker, ` +
        `so it was cut short before it reached the server. Nothing was uploaded — send the whole file.`,
    }
  }
  return { status: 'unknown' }
}

/** Whether an error body could have come from Notion's API, which always answers JSON. */
function looksLikeJson(body: string): boolean {
  try {
    JSON.parse(body)
    return true
  } catch {
    return false
  }
}

/**
 * Fork guard (bot-protection refusal): describe a refusal that never reached
 * Notion, or null when the body is an ordinary API error.
 *
 * Notion answers JSON for every outcome, errors included. A non-JSON error body
 * therefore did not come from Notion — it came from the bot-protection layer in
 * front of it, which refuses the request and serves a full HTML page instead.
 * That page used to be handed to the caller verbatim, so an agent saw a wall of
 * markup rather than "you were blocked"; it also names the sender by network
 * address and carries a reference id, neither of which belongs in a tool result
 * or a log. So the page is dropped and replaced with a short, explicit error.
 *
 * Applied to file uploads only — that is where the refusal was observed and
 * where the page body is largest. Other operations keep upstream's verbatim
 * pass-through, so an HTML 5xx from the origin still reaches the caller as-is.
 */
function describeRefusal(status: number, body: unknown): string | null {
  if (typeof body !== 'string') return null
  const trimmed = body.trim()
  if (trimmed.length === 0 || looksLikeJson(trimmed)) return null
  const shape = /^<(?:!doctype|html|\?xml)/i.test(trimmed) ? 'an HTML page' : 'a non-JSON body'
  return (
    `Blocked before reaching Notion: the request was refused with HTTP ${status} and ${shape} ` +
    `instead of an API response, so it never got past the bot-protection layer. ` +
    `The page itself is withheld because it identifies the sender. ` +
    `This is usually transient — retry in a few minutes.`
  )
}

/**
 * Fork addition (`created_after` on `retrieve-a-comment`): how many pages of
 * comments this server will walk on the caller's behalf before giving up.
 * 20 pages x the 100-comment maximum = 2000 comments. Past that we refuse
 * rather than return a partial answer: a filtered list that silently stopped
 * early is indistinguishable from "nothing new was said", which is exactly the
 * question the parameter exists to answer.
 */
export const COMMENT_SCAN_MAX_PAGES = 20
const COMMENT_SCAN_PAGE_SIZE = 100

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
   * The parameters an operation declares — the values that travel in the URL or
   * the headers, and so never belong in the request body.
   *
   * This is the one place that rule is expressed. Both request-building paths
   * need it (the multipart body must exclude every declared parameter; the JSON
   * path moves path and query parameters into the URL and out of the body), and
   * each used to re-derive it inline with a subtly different loop — so a change
   * to one could silently leave the other behind. `$ref`'d declarations are
   * followed, and a declaration without a name is dropped because it can match
   * no argument. Callers apply their own `in` filter on top.
   */
  private declaredParameters(operation: OpenAPIV3.OperationObject): OpenAPIV3.ParameterObject[] {
    const declared: OpenAPIV3.ParameterObject[] = []
    for (const param of operation.parameters ?? []) {
      const resolved = this.resolveParameter(param)
      if (resolved && resolved.name) {
        declared.push(resolved)
      }
    }
    return declared
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

    // The size the caller says they are sending. Checked against what actually
    // arrived, ahead of every inference below, because it is the only evidence
    // that survives a payload being cut before it reached this server.
    const declaredLength = readDeclaredLength(params.content_length)
    // With one source the declared size is that buffer's, so the mismatch can be
    // caught the moment it is decoded; with several it can only mean the total,
    // which is checked once the loop is done. Nothing is sent either way.
    const sourceCount = fileParams.reduce((n, p) => n + (Array.isArray(params[p]) ? params[p].length : 1), 0)
    const singleSource = sourceCount === 1

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
          const appendBuffer = (buf: Buffer, sourceType?: string | null, encoded?: string) => {
            // Size first: a declared length settles the question outright, and
            // it has to be consulted before the format check because a file cut
            // short can still end with its format's end-of-file marker — by
            // coincidence for a short trailer, and always for a format whose
            // end we cannot recognise at all. A trailer proves the last byte is
            // present, never that none are missing in between.
            if (declaredLength !== undefined && singleSource && buf.length !== declaredLength) {
              throw new UploadPayloadError(describeLengthMismatch(buf.length, declaredLength))
            }

            // A part of a multi-part upload is a fragment by design; only a
            // whole-file send can be judged complete.
            if (params.part_number === undefined) {
              const verdict = judgeContainer(buf)
              if (verdict.status === 'incomplete') {
                throw new UploadPayloadError(verdict.message)
              }
              // Nothing here can vouch for the payload: the encoding carries no
              // proof it ran to the end, the format is not one whose end we can
              // recognise, and the caller stated no size. Rather than store a
              // possible fragment and report success — the failure this guard
              // exists for — ask for the one fact that would settle it.
              const unprovable =
                verdict.status === 'unknown' &&
                declaredLength === undefined &&
                encoded !== undefined &&
                !encodingProvesCompleteness(encoded)
              if (unprovable && buf.length >= UNPROVABLE_PAYLOAD_LIMIT) {
                throw new UploadPayloadError(
                  `Cannot confirm this payload is complete: it decodes to ${buf.length} bytes, its encoding ends without ` +
                    `padding (so it could equally be a whole file or one cut at a group boundary), and its format is not one ` +
                    `whose end-of-file marker this server recognises. Send content_length with the source file's size in ` +
                    `bytes and it will be verified exactly. Nothing was uploaded.`,
                )
              }
            }
            uploadedBytes += buf.length
            const contentType = declared?.contentType ?? (sourceType ? sourceType.split(';')[0].trim() : undefined)
            formData.append(name, buf, contentType ? { filename, contentType } : { filename })
          }

          if (/^data:/i.test(source)) {
            const b64 = source.slice(source.indexOf(',') + 1)
            const mediaType = /^data:([^;,]+)/i.exec(source)?.[1]
            appendBuffer(decodeBase64Payload(b64), mediaType, b64)
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

          // Resolved once and reused: it decides both that an existing file
          // wins over the base64 reading and, below, whether a path-shaped
          // value can be opened at all.
          const existsLocally = localFileExists(source)

          // Bare base64, of any length: a tiny file's base64 is only a few
          // characters, so length cannot be the signal. An existing file on
          // disk still wins, which keeps stdio paths working.
          if (isBareBase64(source) && !existsLocally) {
            appendBuffer(decodeBase64Payload(source), undefined, source)
            return
          }

          // Local filesystem path (stdio only): size is not tracked here, so the
          // truncation guard is disabled for this file.
          //
          // Check the file exists before streaming it. createReadStream does not
          // throw for a missing file — it emits ENOENT asynchronously, well past
          // the catch below — so without this the caller got a bare filesystem
          // error naming none of the alternatives, and reasonably concluded that
          // attaching a file is impossible. Which it is not; it just cannot be
          // done by path against a server hosted somewhere else.
          if (!existsLocally) {
            throw new UploadSourceError(
              `Cannot read '${describeSource(source)}': no such file on the machine running this server. ` +
                `This server does not share a filesystem with you unless it runs locally over stdio, so a path ` +
                `to your own machine cannot be opened here. Send the contents instead — a data: URI ` +
                `('data:<mime>;base64,<...>'), a bare base64 string, or an http(s) URL this server can fetch.`,
            )
          }
          measurable = false
          formData.append(name, fs.createReadStream(source))
        } catch (error) {
          // A payload diagnosis already says exactly what is wrong; wrapping it
          // in "failed to read" would bury it behind an unreadable prefix.
          if (error instanceof UploadPayloadError || error instanceof UploadSourceError) {
            throw error
          }
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

    // Several sources in one request: the declared size can only have meant
    // their total. Still ahead of the request being made, so nothing is sent.
    if (declaredLength !== undefined && !singleSource && measurable && uploadedBytes !== declaredLength) {
      throw new UploadPayloadError(describeLengthMismatch(uploadedBytes, declaredLength))
    }

    // Fork fix (upload hygiene): only genuine body fields belong in the
    // multipart payload. In OpenAPI 3 everything declared under `parameters`
    // lives in the URL or the headers — executeOperation already puts path and
    // query parameters into `urlParameters`, and header parameters are built by
    // buildDefaultHeaders — so appending them here duplicated e.g.
    // `file_upload_id` into the body of every send request. Notion ignores the
    // stray part today, but that is undefined behaviour to depend on.
    const declaredNonBodyParams = new Set(this.declaredParameters(operation).map((param) => param.name))

    // Add non-file parameters to form data. `filename` is consumed above as
    // the file part's metadata, and `content_length` as the integrity check
    // this server performs itself; neither is a form field of its own, and
    // Notion knows nothing about the latter.
    for (const [key, value] of Object.entries(params)) {
      if (fileParams.includes(key) || key === 'filename' || key === 'content_length' || declaredNonBodyParams.has(key)) {
        continue
      }
      // form-data dereferences the value while building the part header, so an
      // explicit null/undefined blows up with an opaque TypeError deep inside
      // the library. Say what is wrong instead.
      if (value === null || value === undefined) {
        throw new Error(
          `Parameter "${key}" was sent as ${value === null ? 'null' : 'undefined'}; omit the parameter instead of sending an empty value.`,
        )
      }
      formData.append(key, value)
    }

    return { formData, uploadedBytes: measurable ? uploadedBytes : null }
  }

  /**
   * Fork addition: serve `retrieve-a-comment`'s `created_after` filter.
   *
   * Notion's `GET /v1/comments` has exactly three query parameters (`block_id`,
   * `start_cursor`, `page_size`) — no sort, no filter — and returns comments
   * oldest first. So "has anything been said since I last looked?" costs a walk
   * of the whole thread on every check. `created_after` is this server's own
   * parameter: it is stripped from the outgoing request (Notion has never heard
   * of it), the thread is walked here, and only the newer comments come back,
   * in the ordinary list envelope so callers need no special handling.
   *
   * A caller-supplied `start_cursor` is honoured as the starting point; the
   * page size is forced to the maximum, since paging in smaller steps only
   * costs more round trips for the same answer.
   */
  private async listCommentsCreatedAfter<T = any>(
    operation: OpenAPIV3.OperationObject & { method: string; path: string },
    params: Record<string, any>,
  ): Promise<HttpClientResponse<T>> {
    const rawCreatedAfter = params.created_after
    const threshold = Date.parse(String(rawCreatedAfter))
    if (Number.isNaN(threshold)) {
      // A timestamp we cannot read would compare false against every comment
      // and hand back an empty list — "no new comments" for what is really a
      // typo. Say so instead.
      throw new Error(
        `created_after must be an ISO-8601 date-time (e.g. 2026-08-10T03:11:00.000Z); received ${JSON.stringify(rawCreatedAfter)}.`,
      )
    }

    // Never send our own parameter to Notion.
    const pageParams: Record<string, any> = { ...params }
    delete pageParams.created_after
    pageParams.page_size = COMMENT_SCAN_PAGE_SIZE

    const matched: any[] = []
    let cursor: string | undefined = typeof params.start_cursor === 'string' ? params.start_cursor : undefined

    for (let page = 0; page < COMMENT_SCAN_MAX_PAGES; page++) {
      if (cursor === undefined) {
        delete pageParams.start_cursor
      } else {
        pageParams.start_cursor = cursor
      }

      // Recurses into the ordinary path — `created_after` is gone, so this
      // cannot come back here.
      const response: HttpClientResponse<any> = await this.executeOperation<any>(operation, pageParams)

      const body: any = response.data ?? {}
      for (const comment of Array.isArray(body.results) ? body.results : []) {
        const created = Date.parse(String(comment?.created_time))
        // An entry whose timestamp we cannot read is kept: we cannot prove it
        // is old, and showing one comment too many is recoverable while
        // hiding one is not.
        if (Number.isNaN(created) || created > threshold) {
          matched.push(comment)
        }
      }

      if (!body.has_more || typeof body.next_cursor !== 'string') {
        return {
          ...response,
          data: { ...body, results: matched, has_more: false, next_cursor: null } as T,
        }
      }
      cursor = body.next_cursor
    }

    throw new Error(
      `created_after: this thread has more than ${COMMENT_SCAN_MAX_PAGES * COMMENT_SCAN_PAGE_SIZE} comments, ` +
        `which is past the limit this server will scan. No result is returned, because a partially scanned ` +
        `thread cannot be told apart from one with nothing new in it. Page through it with start_cursor and ` +
        `page_size instead, without created_after.`,
    )
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

    // Fork addition: `created_after` is filtered by this server, not by Notion.
    // Absent, the code below is exactly upstream's single unpaged request.
    if (operationId === 'retrieve-a-comment' && params.created_after !== undefined && params.created_after !== null) {
      return this.listCommentsCreatedAfter<T>(operation, params)
    }

    // Handle file uploads if present
    const upload = await this.prepareFileUpload(operation, params)
    const formData = upload?.formData ?? null

    // Separate parameters based on their location
    const urlParameters: Record<string, any> = {}
    const bodyParams: Record<string, any> = formData || { ...params }

    // Extract path and query parameters based on operation definition. Only
    // these two locations are routed into the URL; header parameters are the
    // business of buildDefaultHeaders.
    for (const param of this.declaredParameters(operation)) {
      if (param.in === 'path' || param.in === 'query') {
        if (params[param.name] !== undefined) {
          urlParameters[param.name] = params[param.name]
          if (!formData) {
            delete bodyParams[param.name]
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

        // A refusal that never reached Notion is reported as itself, without the
        // block page: see describeRefusal above.
        const refusal = upload ? describeRefusal(error.response.status, error.response.data) : null
        if (refusal) {
          throw new HttpClientError(
            refusal,
            error.response.status,
            { object: 'error', code: 'blocked_before_notion', message: refusal },
            headers,
          )
        }

        throw new HttpClientError(error.response.statusText || 'Request failed', error.response.status, error.response.data, headers)
      }
      throw error
    }
  }
}
