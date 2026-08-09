import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { OpenAPIV3 } from 'openapi-types'
import { OpenAPIToMCPConverter } from '../parser'

/**
 * The converter memoises each resolved `$ref`, and the key used to be the ref
 * string alone — even though the conversion depends on two further inputs:
 *
 *  - `resolveRefs`, which decides whether a nested ref is inlined or left as a
 *    `#/$defs/...` pointer. Two callers asking in different modes therefore
 *    want different schemas for the same ref, and the first one to arrive
 *    decided it for both.
 *  - `resolvedRefs`, the set of refs already being expanded further up, used to
 *    cut recursion. A schema converted while such a cut was made is truncated —
 *    correct in that position, wrong for a caller starting from a clean set —
 *    and it was cached and handed out all the same.
 *
 * Neither fires on the Notion spec today, because every call site outside the
 * converter passes `resolveRefs: false` and every Notion ref lives under
 * `#/components/schemas/`, which returns a fresh pointer before the cache is
 * consulted. These tests pin the behaviour on the paths that do reach it, so
 * the next caller to want inlining — or the next spec carrying a Swagger-style
 * `#/definitions/...` ref — does not inherit a schema meant for someone else.
 *
 * Both cases are exercised through `#/definitions/...` refs: that is the
 * documented fall-through in `convertOpenApiSchemaToJsonSchema` for a ref
 * outside the components collection, and the one shape of ref that reaches the
 * cache in either mode.
 */
describe('resolved-schema cache', () => {
  const spec = {
    openapi: '3.1.0',
    info: { title: 'test', version: '1.0.0' },
    paths: {},
    components: {
      schemas: {
        Leaf: {
          type: 'object',
          properties: { name: { type: 'string' } },
        },
      },
    },
    // Deliberately outside `components.schemas`: a ref to anywhere else is the
    // case the converter falls through to the cache for.
    definitions: {
      Wrapper: {
        type: 'object',
        properties: { leaf: { $ref: '#/components/schemas/Leaf' } },
      },
      A: {
        type: 'object',
        properties: { b: { $ref: '#/definitions/B' } },
      },
      B: {
        type: 'object',
        properties: { a: { $ref: '#/definitions/A' } },
      },
    },
  } as unknown as OpenAPIV3.Document

  const wrapperRef = { $ref: '#/definitions/Wrapper' }

  beforeEach(() => {
    // The fall-through logs the unresolvable-by-pointer ref; that is expected
    // here and would otherwise bury the test output.
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps the two resolve modes apart, whichever is asked for first', () => {
    const pointerFirst = new OpenAPIToMCPConverter(spec)
    const pointered = pointerFirst.convertOpenApiSchemaToJsonSchema(wrapperRef, new Set(), false)
    const inlinedAfter = pointerFirst.convertOpenApiSchemaToJsonSchema(wrapperRef, new Set(), true)

    const inlineFirst = new OpenAPIToMCPConverter(spec)
    const inlined = inlineFirst.convertOpenApiSchemaToJsonSchema(wrapperRef, new Set(), true)
    const pointeredAfter = inlineFirst.convertOpenApiSchemaToJsonSchema(wrapperRef, new Set(), false)

    // Without `resolveRefs` the nested ref stays a pointer into `$defs`.
    const asPointer = { $ref: '#/$defs/Leaf' }
    expect(pointered.properties!.leaf).toEqual(asPointer)
    expect(pointeredAfter.properties!.leaf).toEqual(asPointer)

    // With it, the target is expanded in place.
    const asObject = {
      type: 'object',
      properties: { name: { type: 'string' } },
      additionalProperties: true,
    }
    expect(inlined.properties!.leaf).toEqual(asObject)
    expect(inlinedAfter.properties!.leaf).toEqual(asObject)
  })

  it('does not keep a schema that was truncated to break a cycle', () => {
    const converter = new OpenAPIToMCPConverter(spec)

    // Converting A expands B underneath it, and B's own reference back to A is
    // cut because A is already open. That truncated B must not become the
    // answer for anyone who asks for B on its own.
    converter.convertOpenApiSchemaToJsonSchema({ $ref: '#/definitions/A' }, new Set(), true)
    const b = converter.convertOpenApiSchemaToJsonSchema({ $ref: '#/definitions/B' }, new Set(), true)

    expect(b.properties!.a).toMatchObject({ type: 'object' })
    expect(b.properties!.a).not.toHaveProperty('$ref')
  })

  it('still caches, so a repeated ref in the same mode is converted once', () => {
    const converter = new OpenAPIToMCPConverter(spec)

    const first = converter.convertOpenApiSchemaToJsonSchema(wrapperRef, new Set(), true)
    const second = converter.convertOpenApiSchemaToJsonSchema(wrapperRef, new Set(), true)

    expect(second).toBe(first)
  })
})
