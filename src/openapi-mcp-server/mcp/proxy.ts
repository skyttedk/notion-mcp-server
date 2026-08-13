import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, JSONRPCResponse, ListToolsRequestSchema, Tool } from '@modelcontextprotocol/sdk/types.js'
import { JSONSchema7 as IJsonSchema } from 'json-schema'
import { OpenAPIToMCPConverter } from '../openapi/parser'
import { HttpClient, HttpClientError } from '../client/http-client'
import { formatValidationError } from './validation-error'
import { OpenAPIV3 } from 'openapi-types'
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

type PathItemObject = OpenAPIV3.PathItemObject & {
  get?: OpenAPIV3.OperationObject
  put?: OpenAPIV3.OperationObject
  post?: OpenAPIV3.OperationObject
  delete?: OpenAPIV3.OperationObject
  patch?: OpenAPIV3.OperationObject
}

type NewToolDefinition = {
  methods: Array<{
    name: string
    description: string
    inputSchema: IJsonSchema & { type: 'object' }
    returnSchema?: IJsonSchema
  }>
}

/**
 * A position in the argument tree, expressed as the schema branches that may
 * apply there. `undefined` means "no schema describes this position" — the
 * signal to fall back to the schema-blind behaviour that predates the fork fix
 * below.
 */
type SchemaCandidates = IJsonSchema[] | undefined

/** How deep `$ref`/`anyOf` expansion may go before it gives up. */
const MAX_SCHEMA_DEPTH = 12

/**
 * Recursively deserialize stringified JSON values in parameters.
 * This handles the case where MCP clients (like Cursor, Claude Code, and some
 * SDKs) double-serialize nested object/array parameters, sending them as JSON
 * strings instead of structured values.
 *
 * The whole argument tree is walked uniformly: every object property and every
 * array element is visited, JSON-looking strings are decoded, and the decoded
 * result is walked again. This normalizes deeply nested cases — including a
 * stringified object that sits inside an array element object (e.g.
 * `{ children: [{ paragraph: '{"rich_text":[...]}' }] }`) and values that were
 * JSON-encoded more than once (e.g. `JSON.stringify(JSON.stringify(parent))`) —
 * before the request is forwarded to the Notion API.
 *
 * Fork fix (schema-aware unwrapping): the walk is guided by the tool's own
 * `inputSchema` instead of being schema-blind. Upstream decoded *any* string
 * that looked like JSON, wherever it sat, so ordinary prose that happens to
 * start with `{` and end with `}` — a Notion paragraph quoting a JSON snippet —
 * was turned into an object and Notion rejected the request with
 * "…should be a string". Sibling symptoms: `[1, 2]` typed into a text field
 * became an array. A string is now decoded only where the schema actually
 * permits an object or array; where it permits only a string (e.g.
 * `richTextRequest.text.content`) it is forwarded untouched. Positions no
 * schema describes keep the old eager behaviour, so the double-serialization
 * fix is preserved for anything untyped.
 *
 * NB: the string branch that `withStringFallback` (parser.ts) adds to every
 * complex property cannot be read as "the schema wants a string here" — it
 * exists precisely to let a double-serialized object through validation. That
 * is why the test below is "does this position permit structure?" and not
 * "does any branch permit a string?".
 *
 * @see https://github.com/makenotion/notion-mcp-server/issues/176
 */
function deserializeParams(params: Record<string, unknown>, inputSchema?: IJsonSchema): Record<string, unknown> {
  const defs = (inputSchema?.$defs ?? {}) as Record<string, IJsonSchema>
  const root: SchemaCandidates = inputSchema ? expandBranches([inputSchema], defs) : undefined

  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    result[key] = deserializeValue(value, propertyCandidates(root, key, defs), defs)
  }
  return result
}

/**
 * Normalize a single value: decode a JSON-encoded string into the structured
 * value it represents (recursing into the result), walk into every array
 * element, and walk into every nested object property. Non-JSON strings and
 * scalars are returned unchanged, so values the schema legitimately wants as
 * strings (and numbers/booleans encoded as strings) are left intact.
 */
function deserializeValue(value: unknown, candidates: SchemaCandidates, defs: Record<string, IJsonSchema>): unknown {
  if (typeof value === 'string') {
    // The one place the schema changes the outcome: a string stays a string
    // unless this position can hold an object or an array.
    if (candidates && !allowsStructured(candidates)) {
      return value
    }
    return unwrapJsonString(value, candidates, defs)
  }

  if (Array.isArray(value)) {
    const items = itemCandidates(candidates, defs)
    return value.map((entry) => deserializeValue(entry, items, defs))
  }

  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value)) {
      result[key] = deserializeValue(nested, propertyCandidates(candidates, key, defs), defs)
    }
    return result
  }

  return value
}

/**
 * Flatten a set of schemas to the leaf branches a value could match: `$ref`s
 * are followed into the tool's `$defs` and `anyOf`/`oneOf`/`allOf` are
 * expanded. `allOf` members are treated as alternatives rather than as an
 * intersection — the only questions asked of the result are "can this hold
 * structure?" and "which sub-schema describes key X?", and both are answered
 * the same way by either reading.
 */
function expandBranches(schemas: IJsonSchema[], defs: Record<string, IJsonSchema>, depth = 0): IJsonSchema[] {
  if (depth >= MAX_SCHEMA_DEPTH) {
    return schemas
  }

  const out: IJsonSchema[] = []
  for (const schema of schemas) {
    if (!schema || typeof schema !== 'object') {
      continue
    }

    const ref = (schema as { $ref?: string }).$ref
    if (ref) {
      const target = defs[ref.replace(/^#\/(?:\$defs|components\/schemas)\//, '')]
      // An unresolvable ref describes nothing; dropping it leaves the position
      // schema-less, which falls back to the legacy behaviour.
      if (target) {
        out.push(...expandBranches([target], defs, depth + 1))
      }
      continue
    }

    const union = [
      ...((schema.anyOf ?? []) as IJsonSchema[]),
      ...((schema.oneOf ?? []) as IJsonSchema[]),
      ...((schema.allOf ?? []) as IJsonSchema[]),
    ]
    if (union.length > 0) {
      out.push(...expandBranches(union, defs, depth + 1))
      continue
    }

    out.push(schema)
  }
  return out
}

/** True when at least one branch can hold an object or an array. */
function allowsStructured(candidates: IJsonSchema[]): boolean {
  return candidates.some((schema) => {
    const type = schema.type
    if (type) {
      const types = Array.isArray(type) ? type : [type]
      return types.includes('object') || types.includes('array')
    }
    // Untyped but shaped like a container, or wholly unconstrained (`{}`) —
    // in which case nothing is known and the eager default applies.
    return (
      schema.properties !== undefined ||
      schema.items !== undefined ||
      schema.additionalProperties !== undefined ||
      Object.keys(schema).length === 0
    )
  })
}

/**
 * The schemas that describe `key` inside the given object positions. Branches
 * that name the property win outright: a sibling `additionalProperties: true`
 * branch (the converter adds one to array items) would otherwise make every
 * key unconstrained and defeat the whole check.
 */
function propertyCandidates(candidates: SchemaCandidates, key: string, defs: Record<string, IJsonSchema>): SchemaCandidates {
  if (!candidates) {
    return undefined
  }

  const named = candidates
    .map((schema) => schema.properties?.[key])
    .filter((schema): schema is IJsonSchema => typeof schema === 'object' && schema !== null)
  if (named.length > 0) {
    return expandBranches(named, defs)
  }

  const additional = candidates.map((schema) => schema.additionalProperties).filter((schema) => schema !== undefined && schema !== false)
  if (additional.length === 0 || additional.some((schema) => schema === true || (typeof schema === 'object' && Object.keys(schema).length === 0))) {
    // Either nothing describes this key, or it is described as "anything".
    return undefined
  }
  return expandBranches(additional as IJsonSchema[], defs)
}

/** The schemas that describe the elements of the given array positions. */
function itemCandidates(candidates: SchemaCandidates, defs: Record<string, IJsonSchema>): SchemaCandidates {
  if (!candidates) {
    return undefined
  }

  const items = candidates
    .map((schema) => schema.items)
    // Tuple-typed `items` (an array of schemas) is not used by the Notion spec;
    // leaving it undescribed keeps the legacy behaviour rather than guessing.
    .filter((schema): schema is IJsonSchema => typeof schema === 'object' && schema !== null && !Array.isArray(schema))
  if (items.length === 0) {
    return undefined
  }
  return expandBranches(items, defs)
}

// Bound how many JSON-decode passes we attempt on a single string. One pass
// handles the common single-encoding; extra passes absorb double/triple
// serialization without unbounded work on adversarial input.
const MAX_UNWRAP_DEPTH = 3

/**
 * Resolve a (possibly multiply-)JSON-encoded string to the object or array it
 * represents. Only strings that ultimately decode to an object or array are
 * transformed (and then recursively normalized); a string that decodes to a
 * scalar (number/boolean/null) or to another plain string is returned
 * unchanged, so genuine string values are never corrupted.
 */
function unwrapJsonString(value: string, candidates: SchemaCandidates, defs: Record<string, IJsonSchema>): unknown {
  let current = value
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
    const trimmed = current.trim()
    // Only attempt a parse when the string could encode an object/array
    // (`{...}`/`[...]`) or wrap one in a JSON string literal (`"..."`). This
    // skips the common case of ordinary text without touching JSON.parse.
    const couldBeEncoded =
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"'))
    if (!couldBeEncoded) {
      break
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      break
    }

    if (typeof parsed === 'object' && parsed !== null) {
      // The decoded value occupies the same schema position as the string did.
      return deserializeValue(parsed, candidates, defs)
    }
    if (typeof parsed === 'string') {
      // Peeled one layer of JSON-string encoding; loop to see whether it wraps
      // a structured value (double-encoding).
      current = parsed
      continue
    }
    // Decoded to a scalar — not a structured value; leave the original intact.
    break
  }
  return value
}

// import this class, extend and return server
export class MCPProxy {
  private server: Server
  private httpClient: HttpClient
  private tools: Record<string, NewToolDefinition>
  private openApiLookup: Record<string, OpenAPIV3.OperationObject & { method: string; path: string }>
  /**
   * Tool name -> the schema clients were shown for it, keyed under both the
   * full name and the truncated one `tools/list` advertises, so a call arrives
   * under either spelling and still finds its schema. See `deserializeParams`.
   */
  private inputSchemas: Record<string, IJsonSchema>

  /**
   * @param headers Notion API headers to authenticate with. When omitted, the
   *   headers are resolved from the environment (`OPENAPI_MCP_HEADERS` /
   *   `NOTION_TOKEN`). The HTTP transport passes per-connection headers here so a
   *   single deployment can serve multiple Notion integrations.
   */
  constructor(name: string, openApiSpec: OpenAPIV3.Document, headers?: Record<string, string>) {
    this.server = new Server({ name, version: '1.0.0' }, { capabilities: { tools: {} } })
    const baseUrl = openApiSpec.servers?.[0].url
    if (!baseUrl) {
      throw new Error('No base URL found in OpenAPI spec')
    }
    this.httpClient = new HttpClient(
      {
        baseUrl,
        headers: headers ?? this.parseHeadersFromEnv(),
      },
      openApiSpec,
    )

    // Convert OpenAPI spec to MCP tools
    const converter = new OpenAPIToMCPConverter(openApiSpec)
    const { tools, openApiLookup } = converter.convertToMCPTools()
    this.tools = tools
    this.openApiLookup = openApiLookup
    this.inputSchemas = {}
    Object.entries(this.tools).forEach(([toolName, def]) => {
      def.methods.forEach((method) => {
        const fullName = `${toolName}-${method.name}`
        const listedName = this.truncateToolName(fullName)
        this.inputSchemas[fullName] = method.inputSchema
        this.inputSchemas[listedName] = method.inputSchema
        // `tools/list` advertises `listedName`, so that is the spelling a call
        // arrives under — but `openApiLookup` is keyed by the full name only.
        // Without an alias, any tool whose name exceeds 64 characters is listed
        // and then rejected with "Method not found": a dead end, since the
        // caller is using the exact name it was just shown. No Notion operation
        // id is long enough to trigger this today, so the alias is what keeps
        // the two sides consistent as the API grows longer ones.
        //
        // Guarded so an alias never shadows a real full-name entry: a distinct
        // tool whose full name is exactly 64 characters owns that key outright.
        if (listedName !== fullName && this.openApiLookup[fullName] && !(listedName in this.openApiLookup)) {
          this.openApiLookup[listedName] = this.openApiLookup[fullName]
        }
      })
    })

    this.setupHandlers()
  }

  private setupHandlers() {
    // Handle tool listing
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools: Tool[] = []

      // Add methods as separate tools to match the MCP format
      Object.entries(this.tools).forEach(([toolName, def]) => {
        def.methods.forEach(method => {
          const toolNameWithMethod = `${toolName}-${method.name}`;
          const truncatedToolName = this.truncateToolName(toolNameWithMethod);

          // Look up the HTTP method to determine annotations
          const operation = this.openApiLookup[toolNameWithMethod];
          const httpMethod = operation?.method?.toLowerCase();
          const isReadOnly = httpMethod === 'get';

          tools.push({
            name: truncatedToolName,
            description: method.description,
            inputSchema: method.inputSchema as Tool['inputSchema'],
            annotations: {
              title: this.operationIdToTitle(method.name),
              ...(isReadOnly
                ? { readOnlyHint: true }
                : { destructiveHint: true }),
            },
          })
        })
      })

      return { tools }
    })

    // Handle tool calling
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: params } = request.params

      // Find the operation in OpenAPI spec
      const operation = this.findOperation(name)
      if (!operation) {
        throw new Error(`Method ${name} not found`)
      }

      // Deserialize any stringified JSON parameters (fixes double-serialization bug),
      // guided by the tool's own schema so string-typed fields stay strings.
      // See: https://github.com/makenotion/notion-mcp-server/issues/176
      const deserializedParams = params ? deserializeParams(params as Record<string, unknown>, this.inputSchemas[name]) : {}

      try {
        // Execute the operation
        const response = await this.httpClient.executeOperation(operation, deserializedParams)

        // Convert response to MCP format
        return {
          content: [
            {
              type: 'text', // currently this is the only type that seems to be used by mcp server
              text: JSON.stringify(response.data), // TODO: pass through the http status code text?
            },
          ],
        }
      } catch (error) {
        console.error('Error in tool call', error instanceof Error ? error.message : 'Unknown error')
        if (error instanceof HttpClientError) {
          console.error('HttpClientError encountered, returning structured error', { status: error.status })
          const raw = error.data?.response?.data ?? error.data ?? {}
          // Notion's union validation errors bury the actual mistake in a list
          // of every variant it tried — lead with the mismatch instead.
          const data = formatValidationError(raw, deserializedParams)
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ...(typeof data === 'object' ? data : { data: data }),
                  // Fork fix: the marker goes last. Notion's own body carries a
                  // numeric `status` (e.g. 400), so spreading it over the marker
                  // overwrote it and no reply ever said "error".
                  status: 'error',
                }),
              },
            ],
          }
        }
        throw error
      }
    })
  }

  private findOperation(operationId: string): (OpenAPIV3.OperationObject & { method: string; path: string }) | null {
    return this.openApiLookup[operationId] ?? null
  }

  private parseHeadersFromEnv(): Record<string, string> {
    // First try OPENAPI_MCP_HEADERS (existing behavior)
    const headersJson = process.env.OPENAPI_MCP_HEADERS
    if (headersJson) {
      try {
        const headers = JSON.parse(headersJson)
        if (typeof headers !== 'object' || headers === null) {
          console.warn('OPENAPI_MCP_HEADERS environment variable must be a JSON object, got:', typeof headers)
        } else if (Object.keys(headers).length > 0) {
          // Only use OPENAPI_MCP_HEADERS if it contains actual headers
          return headers
        }
        // If OPENAPI_MCP_HEADERS is empty object, fall through to try NOTION_TOKEN
      } catch (error) {
        console.warn('Failed to parse OPENAPI_MCP_HEADERS environment variable:', error)
        // Fall through to try NOTION_TOKEN
      }
    }

    // Alternative: try NOTION_TOKEN
    const notionToken = process.env.NOTION_TOKEN
    if (notionToken) {
      // Notion-Version is intentionally omitted: it is sourced per-operation from
      // the OpenAPI spec by HttpClient, so endpoints can pin the version they need.
      return {
        'Authorization': `Bearer ${notionToken}`,
      }
    }

    return {}
  }

  private getContentType(headers: Headers): 'text' | 'image' | 'binary' {
    const contentType = headers.get('content-type')
    if (!contentType) return 'binary'

    if (contentType.includes('text') || contentType.includes('json')) {
      return 'text'
    } else if (contentType.includes('image')) {
      return 'image'
    }
    return 'binary'
  }

  private truncateToolName(name: string): string {
    if (name.length <= 64) {
      return name;
    }
    return name.slice(0, 64);
  }

  /**
   * Convert an operationId like "createDatabase" to a human-readable title like "Create Database"
   */
  private operationIdToTitle(operationId: string): string {
    // Split on camelCase boundaries and capitalize each word
    return operationId
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[\s_-]+/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  async connect(transport: Transport) {
    // The SDK will handle stdio communication
    await this.server.connect(transport)
  }

  getServer() {
    return this.server
  }
}
