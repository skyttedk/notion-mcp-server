import type { OpenAPIV3, OpenAPIV3_1 } from 'openapi-types'
import type { JSONSchema7 as IJsonSchema } from 'json-schema'

type NewToolMethod = {
  name: string
  description: string
  inputSchema: IJsonSchema & { type: 'object' }
  returnSchema?: IJsonSchema
}

/**
 * What a `format: binary` parameter accepts, appended to the parameter's own
 * description so the caller sees it in the tool schema.
 *
 * Upstream advertised "absolute paths to local files", which is wrong for a
 * remotely hosted server: it shares no filesystem with the caller, so every
 * path it is given is a file-not-found. The sources that do work over HTTP are
 * listed first, and the path is described for what it is — stdio only.
 */
export const FILE_PARAM_DESCRIPTION =
  'file contents as a data: URI, a bare base64 string, or an http(s) URL the server can fetch; ' +
  'a local file path works only when the server runs on the same machine as the caller (stdio)'

export class OpenAPIToMCPConverter {
  private schemaCache: Record<string, IJsonSchema> = {}
  private nameCounter: number = 0

  /**
   * How many times a `$ref` was cut short because it was already being
   * expanded higher up the tree. See the cache note in
   * `convertOpenApiSchemaToJsonSchema`: a subtree converted while such a cut
   * was made is not the full schema, so it must not be cached.
   */
  private cycleCuts: number = 0

  constructor(private openApiSpec: OpenAPIV3.Document | OpenAPIV3_1.Document) {}

  /**
   * Resolve a $ref reference to its schema in the openApiSpec.
   * Returns the raw OpenAPI SchemaObject or null if not found.
   */
  private internalResolveRef(ref: string, resolvedRefs: Set<string>): OpenAPIV3.SchemaObject | null {
    if (!ref.startsWith('#/')) {
      return null
    }
    if (resolvedRefs.has(ref)) {
      this.cycleCuts += 1
      return null
    }

    const parts = ref.replace(/^#\//, '').split('/')
    let current: any = this.openApiSpec
    for (const part of parts) {
      current = current[part]
      if (!current) return null
    }
    resolvedRefs.add(ref)
    return current as OpenAPIV3.SchemaObject
  }

  /**
   * Convert an OpenAPI schema (or reference) into a JSON Schema object.
   * Uses caching and handles cycles by returning $ref nodes.
   */
  convertOpenApiSchemaToJsonSchema(
    schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject,
    resolvedRefs: Set<string>,
    resolveRefs: boolean = false,
  ): IJsonSchema {
    if ('$ref' in schema) {
      const ref = schema.$ref
      if (!resolveRefs) {
        if (ref.startsWith('#/components/schemas/')) {
          return {
            $ref: ref.replace(/^#\/components\/schemas\//, '#/$defs/'),
            ...('description' in schema ? { description: schema.description as string } : {}),
          }
        }
        console.error(`Attempting to resolve ref ${ref} not found in components collection.`)
        // deliberate fall through
      }
      // Fork fix (cache correctness): the cache key is the ref *and the mode*.
      //
      // Converting a ref does not depend on the ref alone. With `resolveRefs`
      // the target is inlined and its own refs are inlined with it; without it
      // the nested refs stay as `#/$defs/...` pointers. The two modes therefore
      // produce different schemas for the same ref, and a key of just the ref
      // handed whichever result was computed first back to the other caller.
      // Nothing hits it today only because every call site outside this method
      // passes `resolveRefs: false` and every Notion ref lives under
      // `#/components/schemas/`, which returns above before reaching the cache.
      const cacheKey = `${resolveRefs ? 'inline' : 'ref'}:${ref}`
      const cached = this.schemaCache[cacheKey]
      if (cached) {
        return cached
      }

      // `resolvedRefs` is the third input, and it cannot go in the key: it is
      // the set of refs already being expanded above this one, used to cut
      // recursion. A subtree converted while such a cut was made is a
      // *truncated* schema — correct in that position, wrong for a caller that
      // starts from a clean set — so results built over a cut are not cached.
      // Comparing the cut counter before and after is what tells the two apart.
      const cutsBefore = this.cycleCuts
      const resolved = this.internalResolveRef(ref, resolvedRefs)
      if (!resolved) {
        // TODO: need extensive tests for this and we definitely need to handle the case of self references
        console.error(`Failed to resolve ref ${ref}`)
        return {
          $ref: ref.replace(/^#\/components\/schemas\//, '#/$defs/'),
          description: 'description' in schema ? ((schema.description as string) ?? '') : '',
        }
      } else {
        const converted = this.convertOpenApiSchemaToJsonSchema(resolved, resolvedRefs, resolveRefs)
        if (this.cycleCuts === cutsBefore) {
          this.schemaCache[cacheKey] = converted
        }

        return converted
      }
    }

    // Handle inline schema
    const result: IJsonSchema = {}

    if (schema.type) {
      result.type = schema.type as IJsonSchema['type']
    }

    // Convert binary format to uri-reference and enhance description
    if (schema.format === 'binary') {
      result.format = 'uri-reference'
      const binaryDesc = FILE_PARAM_DESCRIPTION
      result.description = schema.description ? `${schema.description} (${binaryDesc})` : binaryDesc
    } else {
      if (schema.format) {
        result.format = schema.format
      }
      if (schema.description) {
        result.description = schema.description
      }
    }

    if (schema.enum) {
      result.enum = schema.enum
    }

    // Handle const values (important for oneOf discriminators)
    if ('const' in schema && schema.const !== undefined) {
      result.const = schema.const as IJsonSchema['const']
    }

    if (schema.default !== undefined) {
      result.default = schema.default
    }

    // Handle object properties
    if (schema.type === 'object') {
      result.type = 'object'
      if (schema.properties) {
        result.properties = {}
        for (const [name, propSchema] of Object.entries(schema.properties)) {
          result.properties[name] = this.convertOpenApiSchemaToJsonSchema(propSchema, resolvedRefs, resolveRefs)
        }
      }
      if (schema.required) {
        result.required = schema.required
      }
      if (schema.additionalProperties === true || schema.additionalProperties === undefined) {
        result.additionalProperties = true
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        result.additionalProperties = this.convertOpenApiSchemaToJsonSchema(schema.additionalProperties, resolvedRefs, resolveRefs)
      } else {
        result.additionalProperties = false
      }
    }

    // Handle arrays - ensure binary format conversion happens for array items too
    if (schema.type === 'array' && schema.items) {
      result.type = 'array'
      result.items = this.convertOpenApiSchemaToJsonSchema(schema.items, resolvedRefs, resolveRefs)
    }

    // oneOf, anyOf, allOf
    if (schema.oneOf) {
      result.oneOf = schema.oneOf.map((s) => this.convertOpenApiSchemaToJsonSchema(s, resolvedRefs, resolveRefs))
    }
    if (schema.anyOf) {
      result.anyOf = schema.anyOf.map((s) => this.convertOpenApiSchemaToJsonSchema(s, resolvedRefs, resolveRefs))
    }
    if (schema.allOf) {
      result.allOf = schema.allOf.map((s) => this.convertOpenApiSchemaToJsonSchema(s, resolvedRefs, resolveRefs))
    }

    return result
  }

  convertToMCPTools(): {
    tools: Record<string, { methods: NewToolMethod[] }>
    openApiLookup: Record<string, OpenAPIV3.OperationObject & { method: string; path: string }>
    zip: Record<string, { openApi: OpenAPIV3.OperationObject & { method: string; path: string }; mcp: NewToolMethod }>
  } {
    const apiName = 'API'

    const openApiLookup: Record<string, OpenAPIV3.OperationObject & { method: string; path: string }> = {}
    const tools: Record<string, { methods: NewToolMethod[] }> = {
      [apiName]: { methods: [] },
    }
    const zip: Record<string, { openApi: OpenAPIV3.OperationObject & { method: string; path: string }; mcp: NewToolMethod }> = {}
    for (const [path, pathItem] of Object.entries(this.openApiSpec.paths || {})) {
      if (!pathItem) continue

      for (const [method, operation] of Object.entries(pathItem)) {
        if (!this.isOperation(method, operation)) continue

        const mcpMethod = this.convertOperationToMCPMethod(operation, method, path)
        if (mcpMethod) {
          const uniqueName = this.ensureUniqueName(mcpMethod.name)
          mcpMethod.name = uniqueName
          // Apply description prefix to the already-built description (which includes error responses)
          mcpMethod.description = this.getDescription(mcpMethod.description)
          tools[apiName]!.methods.push(mcpMethod)
          openApiLookup[apiName + '-' + uniqueName] = { ...operation, method, path }
          zip[apiName + '-' + uniqueName] = { openApi: { ...operation, method, path }, mcp: mcpMethod }
        }
      }
    }

    return { tools, openApiLookup, zip }
  }

  private convertComponentsToJsonSchema(): Record<string, IJsonSchema> {
    const components = this.openApiSpec.components || {}
    const schema: Record<string, IJsonSchema> = {}
    for (const [key, value] of Object.entries(components.schemas || {})) {
      schema[key] = this.convertOpenApiSchemaToJsonSchema(value, new Set())
    }
    return schema
  }

  /**
   * Fork fix (tool-list size): keep only the `$defs` a schema can actually reach.
   *
   * `$defs` used to be the spec's *entire* component collection, copied into
   * every tool's inputSchema and returnSchema alike — so one shared schema cost
   * its own size multiplied by the number of operations, whether or not any of
   * them referenced it. With 11 small components that was already 121 KB of the
   * `tools/list` payload for 29 tools; adding the Views API's 43 request
   * schemas would have taken it to ~3 MB, which every client pays on every
   * connection.
   *
   * Walking `$ref`s from the root instead makes the cost proportional to what a
   * tool uses: the same 29 tools need 5 KB, and the eight view tools fit in the
   * remaining budget. Traversal is over the *converted* schema, where refs have
   * already been rewritten to `#/$defs/...`, so it does not depend on how the
   * OpenAPI-to-JSON-Schema step names things. `seen` also terminates the
   * recursive schemas (a filter can nest filters), which is why a ref is
   * recorded before its target is queued.
   */
  private reachableDefs(root: IJsonSchema, allDefs: Record<string, IJsonSchema>): Record<string, IJsonSchema> {
    const seen = new Set<string>()
    const queue: unknown[] = [root]

    const visit = (node: unknown): void => {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) {
        for (const item of node) visit(item)
        return
      }
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === '$ref' && typeof value === 'string') {
          const name = value.replace(/^#\/(?:\$defs|components\/schemas)\//, '')
          if (!seen.has(name) && allDefs[name]) {
            seen.add(name)
            queue.push(allDefs[name])
          }
        } else {
          visit(value)
        }
      }
    }

    while (queue.length > 0) visit(queue.pop())

    const pruned: Record<string, IJsonSchema> = {}
    // Emit in the spec's own declaration order so output stays stable across runs.
    for (const name of Object.keys(allDefs)) {
      if (seen.has(name)) pruned[name] = allDefs[name]!
    }
    return pruned
  }
  private isOperation(method: string, operation: any): operation is OpenAPIV3.OperationObject {
    return ['get', 'post', 'put', 'delete', 'patch'].includes(method.toLowerCase())
  }

  private isParameterObject(param: OpenAPIV3.ParameterObject | OpenAPIV3.ReferenceObject): param is OpenAPIV3.ParameterObject {
    return !('$ref' in param)
  }

  private isRequestBodyObject(body: OpenAPIV3.RequestBodyObject | OpenAPIV3.ReferenceObject): body is OpenAPIV3.RequestBodyObject {
    return !('$ref' in body)
  }

  private resolveParameter(param: OpenAPIV3.ParameterObject | OpenAPIV3.ReferenceObject): OpenAPIV3.ParameterObject | null {
    if (this.isParameterObject(param)) {
      return param
    } else {
      const resolved = this.internalResolveRef(param.$ref, new Set())
      if (resolved && (resolved as OpenAPIV3.ParameterObject).name) {
        return resolved as OpenAPIV3.ParameterObject
      }
    }
    return null
  }

  private resolveRequestBody(body: OpenAPIV3.RequestBodyObject | OpenAPIV3.ReferenceObject): OpenAPIV3.RequestBodyObject | null {
    if (this.isRequestBodyObject(body)) {
      return body
    } else {
      const resolved = this.internalResolveRef(body.$ref, new Set())
      if (resolved) {
        return resolved as OpenAPIV3.RequestBodyObject
      }
    }
    return null
  }

  private resolveResponse(response: OpenAPIV3.ResponseObject | OpenAPIV3.ReferenceObject): OpenAPIV3.ResponseObject | null {
    if ('$ref' in response) {
      const resolved = this.internalResolveRef(response.$ref, new Set())
      if (resolved) {
        return resolved as OpenAPIV3.ResponseObject
      } else {
        return null
      }
    }
    return response
  }

  private convertOperationToMCPMethod(operation: OpenAPIV3.OperationObject, method: string, path: string): NewToolMethod | null {
    if (!operation.operationId) {
      console.warn(`Operation without operationId at ${method} ${path}`)
      return null
    }

    const methodName = operation.operationId

    const inputSchema: IJsonSchema & { type: 'object' } = {
      $defs: this.convertComponentsToJsonSchema(),
      type: 'object',
      properties: {},
      required: [],
    }

    // Handle parameters (path, query, header, cookie)
    if (operation.parameters) {
      for (const param of operation.parameters) {
        const paramObj = this.resolveParameter(param)
        if (paramObj && paramObj.schema) {
          // Header parameters (e.g. Notion-Version) are transport concerns that the
          // server manages, not values the model should supply. Skip them so they
          // don't clutter the tool schema; HttpClient applies their spec defaults.
          if (paramObj.in === 'header') {
            continue
          }
          const schema = this.convertOpenApiSchemaToJsonSchema(paramObj.schema, new Set(), false)
          // Merge parameter-level description if available
          if (paramObj.description) {
            schema.description = paramObj.description
          }
          inputSchema.properties![paramObj.name] = this.withStringFallback(schema)
          if (paramObj.required) {
            inputSchema.required!.push(paramObj.name)
          }
        }
      }
    }

    // Handle requestBody
    if (operation.requestBody) {
      const bodyObj = this.resolveRequestBody(operation.requestBody)
      if (bodyObj?.content) {
        // Handle multipart/form-data for file uploads
        // We convert the multipart/form-data schema to a JSON schema and we require
        // that the user passes in a string for each file that points to the local file
        if (bodyObj.content['multipart/form-data']?.schema) {
          const formSchema = this.convertOpenApiSchemaToJsonSchema(bodyObj.content['multipart/form-data'].schema, new Set(), false)
          if (formSchema.type === 'object' && formSchema.properties) {
            for (const [name, propSchema] of Object.entries(formSchema.properties)) {
              inputSchema.properties![name] = this.withStringFallback(propSchema as IJsonSchema)
            }
            if (formSchema.required) {
              inputSchema.required!.push(...formSchema.required!)
            }
          }
        }
        // Handle application/json
        else if (bodyObj.content['application/json']?.schema) {
          const bodySchema = this.convertOpenApiSchemaToJsonSchema(bodyObj.content['application/json'].schema, new Set(), false)
          // Merge body schema into the inputSchema's properties
          if (bodySchema.type === 'object' && bodySchema.properties) {
            for (const [name, propSchema] of Object.entries(bodySchema.properties)) {
              inputSchema.properties![name] = this.withStringFallback(propSchema as IJsonSchema)
            }
            if (bodySchema.required) {
              inputSchema.required!.push(...bodySchema.required!)
            }
          } else {
            // If the request body is not an object, just put it under "body"
            inputSchema.properties!['body'] = this.withStringFallback(bodySchema)
            inputSchema.required!.push('body')
          }
        }
      }
    }

    // Build description including error responses.
    // Fork fix: show the summary AND the description. The summary is the one-line title,
    // the description is where the longer, hard-won guidance is written (how to
    // attach a file, what Markdown mode to prefer). Preferring one over the
    // other silently dropped everything written in `description`, so that text
    // never reached an agent and maintainers wrote instructions into the void.
    let description = [operation.summary, operation.description].filter(Boolean).join('\n')

    // Extract return type (response schema)
    const returnSchema = this.extractResponseType(operation.responses)

    // Fork fix (undocumented success shape): say what a *successful* call
    // returns, not only how it can fail. Upstream put the 4xx/5xx entries in
    // the description and stopped there, and `returnSchema` never reaches the
    // client — `MCPProxy` sends name, description and inputSchema only — so an
    // agent had to discover the result shape by calling the tool and looking.
    // Rendering it into the description is what actually gets it in front of
    // the caller, and costs no change to the call contract (declaring an MCP
    // `outputSchema` would oblige every response to carry matching
    // `structuredContent`, which this proxy does not produce).
    const returnShape = this.describeReturnShape(returnSchema)
    if (returnShape) {
      description += '\nReturns:\n' + returnShape
    }

    if (operation.responses) {
      const errorResponses = Object.entries(operation.responses)
        .filter(([code]) => code.startsWith('4') || code.startsWith('5'))
        .map(([code, response]) => {
          const responseObj = this.resolveResponse(response)
          let errorDesc = responseObj?.description || ''
          return `${code}: ${errorDesc}`
        })

      if (errorResponses.length > 0) {
        description += '\nError Responses:\n' + errorResponses.join('\n')
      }
    }

    // Narrow `$defs` to what this operation's own parameters and body reach.
    // Computed from the populated schema minus `$defs` itself — walking the
    // full collection would mark every component reachable from every tool and
    // defeat the pruning.
    const { $defs: allDefs, ...inputBody } = inputSchema
    inputSchema.$defs = this.reachableDefs(inputBody as IJsonSchema, (allDefs ?? {}) as Record<string, IJsonSchema>)

    // Generate Zod schema from input schema
    try {
      // const zodSchemaStr = jsonSchemaToZod(inputSchema, { module: "cjs" })
      // console.log(zodSchemaStr)
      // // Execute the function with the zod instance
      // const zodSchema = eval(zodSchemaStr) as z.ZodType

      return {
        name: methodName,
        description,
        inputSchema,
        ...(returnSchema ? { returnSchema } : {}),
      }
    } catch (error) {
      console.warn(`Failed to generate Zod schema for ${methodName}:`, error)
      // Fallback to a basic object schema
      return {
        name: methodName,
        description,
        inputSchema,
        ...(returnSchema ? { returnSchema } : {}),
      }
    }
  }

  /**
   * Wraps a complex schema to also accept a JSON-encoded string.
   * Handles the case where MCP clients (e.g. Claude Desktop) double-serialize
   * nested object parameters, sending them as JSON strings instead of objects.
   * The actual string→object conversion is handled by deserializeParams() in proxy.ts.
   * @see https://github.com/makenotion/notion-mcp-server/issues/208
   */
  private withStringFallback(schema: IJsonSchema): IJsonSchema {
    const isComplex =
      schema.type === 'object' ||
      '$ref' in schema ||
      'anyOf' in schema ||
      'oneOf' in schema ||
      'allOf' in schema

    if (isComplex) {
      return { anyOf: [schema, { type: 'string' }] }
    }

    if (schema.type === 'array' && schema.items) {
      return {
        ...schema,
        items: {
          anyOf: [
            schema.items as IJsonSchema,
            { type: 'string' },
            { type: 'object', additionalProperties: true },
          ],
        },
      }
    }

    return schema
  }

  /**
   * Render a successful response's own top-level fields as one short block for
   * the tool description.
   *
   * Deliberately shallow: the point is to tell a caller which keys come back
   * and roughly what is in them (`results: array of object`), not to reprint
   * the schema — the whole tool list is served on every connection, so a full
   * dump would cost more than it teaches. Operations whose spec still declares
   * the bare `{"type": "object"}` placeholder have no fields to list and get
   * no section at all, rather than a line that says nothing.
   */
  private describeReturnShape(schema: IJsonSchema | null): string | null {
    if (!schema) return null

    const defs = (schema.$defs ?? {}) as Record<string, IJsonSchema>
    const root = this.resolveDefRef(schema, defs)
    const properties = root.properties
    if (!properties || Object.keys(properties).length === 0) return null

    const fields = Object.entries(properties)
      .map(([name, propSchema]) => `${name}: ${this.shapeTypeName(propSchema as IJsonSchema, defs)}`)
      .join(', ')

    // The response's own description is worth printing only when someone wrote
    // one. Most of the spec says "Successful response", or repeats the status
    // code, which would put a line of nothing above every field list.
    const lead = root.description ?? schema.description
    const written = lead && !/^(\d{3}|successful response|ok)$/i.test(lead.trim()) ? lead : null
    return written ? `${written}\nFields: ${fields}` : `Fields: ${fields}`
  }

  /** Follow a single `#/$defs/...` pointer into the schema's own `$defs`. */
  private resolveDefRef(schema: IJsonSchema, defs: Record<string, IJsonSchema>): IJsonSchema {
    const ref = (schema as { $ref?: string }).$ref
    if (!ref) return schema
    return defs[ref.replace(/^#\/(?:\$defs|components\/schemas)\//, '')] ?? schema
  }

  /** Name a field's type for `describeReturnShape`. `depth` stops recursive schemas. */
  private shapeTypeName(schema: IJsonSchema, defs: Record<string, IJsonSchema>, depth: number = 0): string {
    const resolved = depth < 3 ? this.resolveDefRef(schema, defs) : schema
    if (resolved.type === 'array') {
      const items = resolved.items
      if (items && !Array.isArray(items) && depth < 3) {
        return `array of ${this.shapeTypeName(items as IJsonSchema, defs, depth + 1)}`
      }
      return 'array'
    }
    if (typeof resolved.type === 'string') return resolved.type
    if (Array.isArray(resolved.type)) return resolved.type.join('|')
    return 'any'
  }

  /**
   * Fork fix (undocumented success shape): derive a response schema from the
   * spec's own success *example* when it declares no schema.
   *
   * Three of the comment operations document their result only as an example.
   * That example is a real Notion response, so its top-level keys and value
   * types are the shape — recovering them is still reading the spec's response
   * definition, not inventing one, and it beats telling the caller nothing.
   * Only the top level is inferred: an example shows one instance, so deeper
   * detail would generalise further than the evidence supports.
   */
  private schemaFromExample(example: Record<string, unknown>): IJsonSchema {
    const properties: Record<string, IJsonSchema> = {}
    for (const [name, value] of Object.entries(example)) {
      properties[name] = this.exampleValueSchema(value)
    }
    return { type: 'object', properties, additionalProperties: true }
  }

  private exampleValueSchema(value: unknown): IJsonSchema {
    if (Array.isArray(value)) {
      const first = value[0]
      return { type: 'array', items: first === undefined ? {} : this.exampleValueSchema(first) }
    }
    // `null` in an example says the field is nullable, not what it holds when
    // set — so it is left untyped rather than guessed at.
    if (value === null) return { description: 'null in the example; nullable' }
    switch (typeof value) {
      case 'string':
        return { type: 'string' }
      case 'number':
        return { type: Number.isInteger(value) ? 'integer' : 'number' }
      case 'boolean':
        return { type: 'boolean' }
      case 'object':
        return { type: 'object', additionalProperties: true }
      default:
        return {}
    }
  }

  /** The first `examples` entry's value, or the singular `example`, if either is an object. */
  private firstResponseExample(content: OpenAPIV3.MediaTypeObject): Record<string, unknown> | null {
    const candidates: unknown[] = []
    for (const entry of Object.values(content.examples ?? {})) {
      candidates.push((entry as OpenAPIV3.ExampleObject)?.value)
    }
    candidates.push(content.example)
    for (const candidate of candidates) {
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        return candidate as Record<string, unknown>
      }
    }
    return null
  }

  private extractResponseType(responses: OpenAPIV3.ResponsesObject | undefined): IJsonSchema | null {
    // Look for a success response
    const successResponse = responses?.['200'] || responses?.['201'] || responses?.['202'] || responses?.['204']
    if (!successResponse) return null

    const responseObj = this.resolveResponse(successResponse)
    if (!responseObj || !responseObj.content) return null

    const jsonContent = responseObj.content['application/json']
    if (jsonContent?.schema) {
      const returnSchema = this.convertOpenApiSchemaToJsonSchema(jsonContent.schema, new Set(), false)
      returnSchema['$defs'] = this.reachableDefs(returnSchema, this.convertComponentsToJsonSchema())

      // Preserve the response description if available and not already set
      if (responseObj.description && !returnSchema.description) {
        returnSchema.description = responseObj.description
      }

      return returnSchema
    }

    // No schema, but the spec may still carry a success example — see
    // `schemaFromExample`.
    const example = jsonContent ? this.firstResponseExample(jsonContent) : null
    if (example) {
      const returnSchema = this.schemaFromExample(example)
      // A description that is just the status code ("200") says nothing.
      if (responseObj.description && !/^\d{3}$/.test(responseObj.description.trim())) {
        returnSchema.description = responseObj.description
      }
      return returnSchema
    }

    // If no JSON response, fallback to a generic string or known formats
    if (responseObj.content['image/png'] || responseObj.content['image/jpeg']) {
      return { type: 'string', format: 'binary', description: responseObj.description || '' }
    }

    // Fallback
    return { type: 'string', description: responseObj.description || '' }
  }

  private ensureUniqueName(name: string): string {
    if (name.length <= 64) {
      return name
    }

    const truncatedName = name.slice(0, 64 - 5) // Reserve space for suffix
    const uniqueSuffix = this.generateUniqueSuffix()
    return `${truncatedName}-${uniqueSuffix}`
  }

  private generateUniqueSuffix(): string {
    this.nameCounter += 1
    return this.nameCounter.toString().padStart(4, '0')
  }

  private getDescription(description: string): string {
    // Only add "Notion | " prefix for the Notion API
    if (this.openApiSpec.info.title === 'Notion API') {
      return "Notion | " + description
    }
    return description
  }
}
