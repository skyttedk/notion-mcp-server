import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { OpenAPIV3 } from 'openapi-types'
import { OpenAPIToMCPConverter } from '../parser'

/**
 * Guards the Views API surface added to the bundled spec (fork patch).
 *
 * Notion shipped a public Views API in GA; before it, a database view's layout
 * was unreachable from the API, so grouping, sorts, visible properties, card
 * size and compact layout could only be set by hand in the UI. These eight
 * operations are what make board layout reproducible from code.
 *
 * As with the other fork patches, a spec refresh from upstream silently reverts
 * them — this file is what turns that into a failing test rather than a
 * capability quietly disappearing. The capability assertions deliberately probe
 * the specific settings the request was filed for, not just the tool names.
 */
describe('Views API tools', () => {
  const specPath = path.resolve(process.cwd(), 'scripts/notion-openapi.json')
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf-8')) as OpenAPIV3.Document
  const { tools, openApiLookup } = new OpenAPIToMCPConverter(spec).convertToMCPTools()
  const methods = tools['API']?.methods ?? []
  const byName = (name: string) => methods.find((m) => m.name === name)

  const VIEW_TOOLS = [
    'list-views',
    'create-a-view',
    'retrieve-a-view',
    'update-a-view',
    'delete-a-view',
    'create-a-view-query',
    'get-view-query-results',
    'delete-a-view-query',
  ]

  it('exposes all eight view operations', () => {
    for (const name of VIEW_TOOLS) {
      expect(byName(name), `missing tool ${name}`).toBeDefined()
    }
  })

  it('maps each view tool to the right HTTP method and path', () => {
    const seen = VIEW_TOOLS.map((name) => {
      const op = openApiLookup[`API-${name}`]!
      return `${op.method.toUpperCase()} ${op.path}`
    })
    expect(seen).toEqual([
      'GET /v1/views',
      'POST /v1/views',
      'GET /v1/views/{view_id}',
      'PATCH /v1/views/{view_id}',
      'DELETE /v1/views/{view_id}',
      'POST /v1/views/{view_id}/queries',
      'GET /v1/views/{view_id}/queries/{query_id}',
      'DELETE /v1/views/{view_id}/queries/{query_id}',
    ])
  })

  /**
   * The Views API needs a newer API version than the rest of the server. The
   * header is declared per operation and applied by HttpClient from the spec
   * default, exactly as the page-markdown endpoints do it — so this stays a
   * local change and cannot shift the version of the other operations.
   */
  it('pins Notion-Version 2026-03-11 on every view operation without leaking it into the tool schema', () => {
    for (const name of VIEW_TOOLS) {
      const op = openApiLookup[`API-${name}`]!
      const header = (op.parameters ?? []).find(
        (p) => (p as OpenAPIV3.ParameterObject).name === 'Notion-Version',
      ) as OpenAPIV3.ParameterObject | undefined
      expect(header, `${name} declares no Notion-Version`).toBeDefined()
      expect((header!.schema as OpenAPIV3.SchemaObject).default).toBe('2026-03-11')
      expect(Object.keys(byName(name)!.inputSchema.properties ?? {})).not.toContain('Notion-Version')
    }
  })

  it('leaves every other operation on the spec-wide version', () => {
    const viewPaths = Object.keys(spec.paths).filter((p) => p.startsWith('/v1/views'))
    expect(viewPaths).toHaveLength(4)
    for (const [pathName, item] of Object.entries(spec.paths)) {
      if (pathName.startsWith('/v1/views')) continue
      for (const op of Object.values(item ?? {})) {
        const params = (op as OpenAPIV3.OperationObject)?.parameters
        if (!Array.isArray(params)) continue
        for (const p of params as OpenAPIV3.ParameterObject[]) {
          if (p.name !== 'Notion-Version') continue
          expect((p.schema as OpenAPIV3.SchemaObject).default).not.toBe('2026-03-11-views-only')
        }
      }
    }
  })

  it('requires the ids a view cannot be created without', () => {
    // database_id and data_source_id are different ids and both are needed;
    // data_source_id is the required one, database_id/view_id/create_database
    // are the three mutually exclusive placements.
    const create = byName('create-a-view')!
    expect([...(create.inputSchema.required ?? [])].sort()).toEqual(['data_source_id', 'name', 'type'])
    const props = Object.keys(create.inputSchema.properties ?? {})
    expect(props).toEqual(expect.arrayContaining(['database_id', 'view_id', 'create_database', 'position', 'placement']))
  })

  /**
   * The settings the feature request named, asserted individually. A schema can
   * regress to `type: object` and still "work" while silently telling the agent
   * nothing, which is the failure mode these catch.
   */
  describe('covers the layout settings that were previously unreachable', () => {
    const configOf = (tool: string) => JSON.stringify(byName(tool)!.inputSchema.$defs?.viewConfigurationRequest ?? {})
    const groupBy = () => JSON.stringify(byName('update-a-view')!.inputSchema.$defs?.viewGroupByRequest ?? {})

    it('grouping, including hide empty groups', () => {
      expect(groupBy()).toContain('hide_empty_groups')
      expect(groupBy()).toContain('property_id')
      // Board columns are a group_by; a board cannot exist without one.
      expect(configOf('create-a-view')).toContain('sub_group_by')
    })

    it('card size and compact layout — the two the hosted Notion MCP cannot set', () => {
      for (const tool of ['create-a-view', 'update-a-view']) {
        expect(configOf(tool)).toContain('card_layout')
        expect(configOf(tool)).toContain('compact')
        expect(configOf(tool)).toContain('cover_size')
      }
    })

    it('property visibility and order', () => {
      const props = byName('update-a-view')!.inputSchema.$defs?.viewPropertyConfigRequest
      expect(Object.keys((props as { properties?: object })?.properties ?? {})).toEqual(
        expect.arrayContaining(['property_id', 'visible', 'width']),
      )
    })

    it('filters and sorts on both create and update', () => {
      for (const tool of ['create-a-view', 'update-a-view']) {
        const props = Object.keys(byName(tool)!.inputSchema.properties ?? {})
        expect(props).toEqual(expect.arrayContaining(['filter', 'sorts', 'quick_filters', 'configuration']))
      }
    })

    it('every view type Notion offers', () => {
      const create = JSON.stringify(byName('create-a-view')!.inputSchema)
      for (const type of ['table', 'board', 'calendar', 'timeline', 'gallery', 'list', 'map', 'form', 'chart', 'dashboard']) {
        expect(create, `view type ${type} missing`).toContain(`"${type}"`)
      }
    })
  })

  /**
   * The view request schemas are by far the largest in the spec, so they are
   * also the ones that would hurt most if they were copied into tools that do
   * not use them. See parser-defs-pruning.test.ts for the mechanism.
   */
  it('does not push the view schemas into unrelated tools', () => {
    const unrelated = byName('retrieve-a-page')!
    expect(Object.keys(unrelated.inputSchema.$defs ?? {})).toEqual([])

    const listViews = byName('list-views')!
    expect(Object.keys(listViews.inputSchema.$defs ?? {})).toEqual([])

    // ...while the tools that do need them still carry them.
    expect(Object.keys(byName('create-a-view')!.inputSchema.$defs ?? {})).toContain('viewConfigurationRequest')
  })

  it('keeps the whole tool list smaller than it was before views existed', () => {
    // Sanity ceiling, not a micro-benchmark: measured 76.9 KB on this branch
    // against 147.3 KB shipped before it, with eight more tools.
    const payload = methods.map((m) => ({ name: `API-${m.name}`, description: m.description, inputSchema: m.inputSchema }))
    expect(JSON.stringify(payload).length).toBeLessThan(120_000)
  })
})
