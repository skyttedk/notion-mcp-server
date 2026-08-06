import { describe, expect, it } from 'vitest'
import type { OpenAPIV3 } from 'openapi-types'
import { OpenAPIToMCPConverter } from '../parser'

/**
 * `$defs` on a generated tool must carry only the schemas that tool can reach.
 *
 * It used to be the spec's entire component collection, copied into every tool.
 * That made a shared schema cost its own size once per operation regardless of
 * who referenced it, so the bill grew as (components x operations): the real
 * Notion spec spent 119 KB of a 147 KB `tools/list` payload on `$defs` alone,
 * and adding the Views API's request schemas took it to 813 KB. Nothing failed
 * loudly — every client just paid it on every connection.
 *
 * These are unit tests over a small synthetic spec so the guarantee is stated
 * independently of whatever the Notion spec happens to contain; the real-spec
 * consequences are asserted in `views-api.test.ts`.
 */
describe('inputSchema $defs pruning', () => {
  const spec = {
    openapi: '3.1.0',
    info: { title: 'test', version: '1.0.0' },
    paths: {
      '/used': {
        post: {
          operationId: 'uses-one-schema',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { thing: { $ref: '#/components/schemas/usedSchema' } },
                },
              },
            },
          },
          responses: {},
        },
      },
      '/bare': {
        get: {
          operationId: 'uses-no-schema',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {},
        },
      },
      '/recursive': {
        post: {
          operationId: 'uses-recursive-schema',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { node: { $ref: '#/components/schemas/recursiveSchema' } },
                },
              },
            },
          },
          responses: {},
        },
      },
    },
    components: {
      schemas: {
        usedSchema: {
          type: 'object',
          properties: { nested: { $ref: '#/components/schemas/transitiveSchema' } },
        },
        transitiveSchema: { type: 'object', properties: { value: { type: 'string' } } },
        recursiveSchema: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            children: { type: 'array', items: { $ref: '#/components/schemas/recursiveSchema' } },
          },
        },
        unusedSchema: { type: 'object', properties: { never: { type: 'string' } } },
      },
    },
  } as unknown as OpenAPIV3.Document

  const methods = new OpenAPIToMCPConverter(spec).convertToMCPTools().tools['API']!.methods
  const byName = (name: string) => methods.find((m) => m.name === name)!

  it('keeps a schema the operation references, and the schemas that one references in turn', () => {
    const defs = byName('uses-one-schema').inputSchema.$defs ?? {}
    expect(Object.keys(defs).sort()).toEqual(['transitiveSchema', 'usedSchema'])
  })

  it('drops components the operation never reaches', () => {
    const defs = byName('uses-one-schema').inputSchema.$defs ?? {}
    expect(defs).not.toHaveProperty('unusedSchema')
    expect(defs).not.toHaveProperty('recursiveSchema')
  })

  it('emits no $defs at all for an operation that references nothing', () => {
    expect(byName('uses-no-schema').inputSchema.$defs).toEqual({})
  })

  it('terminates on a self-referencing schema instead of looping forever', () => {
    // A view filter can nest filters, so cycles are not hypothetical here.
    const defs = byName('uses-recursive-schema').inputSchema.$defs ?? {}
    expect(Object.keys(defs)).toEqual(['recursiveSchema'])
  })

  it('leaves every $ref in the tool resolvable — pruning must not create a dangling reference', () => {
    for (const method of methods) {
      const { $defs = {}, ...body } = method.inputSchema
      const refs = new Set<string>()
      const collect = (node: unknown): void => {
        if (!node || typeof node !== 'object') return
        if (Array.isArray(node)) return node.forEach(collect)
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
          if (key === '$ref' && typeof value === 'string') refs.add(value)
          else collect(value)
        }
      }
      collect(body)
      collect($defs)
      for (const ref of refs) {
        expect(Object.keys($defs), `${method.name} references ${ref}`).toContain(ref.replace('#/$defs/', ''))
      }
    }
  })
})
