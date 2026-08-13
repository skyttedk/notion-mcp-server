/**
 * Notion answers a rejected write with its own validation message. When it can
 * still tell which variant of a union was meant, that message is one precise
 * line and is left alone. When it cannot — the usual cause being a block type
 * it does not know — it instead lists every variant it tried:
 *
 *   body failed validation. Fix one:
 *   body.children[0].embed should be defined, instead was `undefined`.
 *   body.children[0].bookmark should be defined, instead was `undefined`.
 *   ... 32 more lines, none of which names the actual mistake ...
 *
 * The caller then has to read all of it to work out that the key it *did*
 * send is simply not on the list. This module rewrites that shape so the
 * first line states the mismatch — what was sent, what was expected — and the
 * alternatives are compacted onto one line behind it.
 */

/** `body.children[0].embed should be defined, instead was `undefined`.` */
const ALTERNATIVE_RE = /^(\S+) should (.+?), instead was (.+?)\.?$/

/** Header Notion puts in front of a union failure. */
const FIX_ONE_PREFIX = 'body failed validation. Fix one:'

interface Alternative {
  line: string
  path: string
  expectation: string
  received: string
  /** A branch Notion abandoned only because its discriminating key was absent. */
  missingKey: boolean
}

function parseAlternatives(lines: string[]): Alternative[] | null {
  const parsed: Alternative[] = []
  for (const line of lines) {
    const m = ALTERNATIVE_RE.exec(line.trim())
    if (!m) return null // unexpected shape — leave the message untouched
    const [, path, expectation, received] = m
    parsed.push({
      line: line.trim(),
      path,
      expectation,
      received,
      missingKey: expectation === 'be defined' && received === '`undefined`',
    })
  }
  return parsed.length > 0 ? parsed : null
}

/** Longest common dotted/indexed prefix of the alternatives' paths. */
function commonPrefix(paths: string[]): string {
  const split = paths.map((p) => p.split('.'))
  const first = split[0]
  let i = 0
  while (i < first.length && split.every((s) => s[i] === first[i])) i++
  return first.slice(0, i).join('.')
}

/** Resolve `body.children[0]` against the arguments actually sent. */
function valueAtPath(params: unknown, path: string): unknown {
  if (params === undefined || params === null) return undefined
  const segments = path.split('.').slice(1) // drop the leading `body`
  let cursor: any = params
  for (const segment of segments) {
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(segment)
    if (!m) return undefined
    const [, key, indices] = m
    if (key) {
      if (typeof cursor !== 'object' || cursor === null) return undefined
      cursor = cursor[key]
    }
    for (const idx of indices.match(/\d+/g) ?? []) {
      if (!Array.isArray(cursor)) return undefined
      cursor = cursor[Number(idx)]
    }
  }
  return cursor
}

function describeSent(value: unknown): string | null {
  if (value === undefined) return null
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return `Sent: ${JSON.stringify(value)}`
  }
  const keys = Object.keys(value as Record<string, unknown>)
  if (keys.length === 0) return 'Sent: an empty object'
  const type = (value as Record<string, unknown>).type
  const typeNote = typeof type === 'string' ? ` (type: ${JSON.stringify(type)})` : ''
  return `Sent keys: ${keys.join(', ')}${typeNote}`
}

/**
 * Keys Notion uses to *wrap* a page property value: `{"Tokens": {"number": 4}}`.
 * The same value may also be sent in Notion's shorthand form, `{"Tokens": 4}`,
 * and a select's shorthand is `{"name": "Low"}` — see
 * {@link explainMixedPropertyForms}.
 */
const PROPERTY_TYPE_KEYS = new Set([
  'title',
  'rich_text',
  'number',
  'select',
  'multi_select',
  'status',
  'date',
  'people',
  'files',
  'checkbox',
  'url',
  'email',
  'phone_number',
  'formula',
  'relation',
  'rollup',
  'created_time',
  'created_by',
  'last_edited_time',
  'last_edited_by',
  'unique_id',
  'verification',
  'button',
  'location',
  'place',
])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `{"select": {...}}`, or `{"type": "select", "select": {...}}`. */
function isWrappedPropertyValue(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  const keys = Object.keys(value)
  return keys.some((k) => PROPERTY_TYPE_KEYS.has(k)) && keys.every((k) => k === 'type' || PROPERTY_TYPE_KEYS.has(k))
}

/**
 * A value that can only be the shorthand form. `null`, `undefined` and `{}` are
 * deliberately not evidence either way — clearing a property is spelled the same
 * in both forms, so counting them would invent a mix that isn't there.
 */
function isShorthandPropertyValue(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (!isPlainObject(value)) return Array.isArray(value) ? value.length > 0 : true
  const keys = Object.keys(value)
  return keys.length > 0 && !keys.some((k) => PROPERTY_TYPE_KEYS.has(k))
}

/**
 * Notion accepts a page's `properties` map in two forms — wrapped
 * (`{"Tokens": {"number": 4}}`) and shorthand (`{"Tokens": 4}`) — and validates
 * the *whole map* in one of them. Mixing them in a single `API-patch-page` or
 * `API-post-page` call therefore fails, and the failure lands on a **wrapped**
 * entry with the shorthand union's discriminating keys listed as the
 * alternatives: `body.properties.Status ... Expected one of: id, name, start,
 * lat, state`. That list belongs to a select option, a date and a location; it
 * says nothing about the property that was sent, and nothing at all about the
 * shorthand entry that actually caused it. Verified against the live API
 * 2026-08-13: wrapped + wrapped succeeds, shorthand + shorthand succeeds, the
 * mix 400s and names whichever entry is wrapped.
 *
 * Returns the two-line replacement when the sent arguments show exactly that
 * mix, otherwise `null` so the generic summary stands.
 */
function explainMixedPropertyForms(prefix: string, params: unknown, accepted: string[]): string | null {
  const segments = prefix.split('.')
  if (segments.length !== 3 || segments[0] !== 'body' || segments[1] !== 'properties') return null
  const key = segments[2]

  const properties = valueAtPath(params, 'body.properties')
  if (!isPlainObject(properties)) return null

  const failing = properties[key]
  if (!isWrappedPropertyValue(failing)) return null

  const shorthand = Object.keys(properties).filter((k) => k !== key && isShorthandPropertyValue(properties[k]))
  if (shorthand.length === 0) return null

  const type = Object.keys(failing as Record<string, unknown>).find((k) => PROPERTY_TYPE_KEYS.has(k))
  const others = shorthand.join(', ')
  const verb = shorthand.length === 1 ? 'is' : 'are'

  return [
    `body failed validation: ${prefix} was sent in the wrapped form ({"${type}": ...}), while ${others} in the same ` +
      `\`properties\` map ${verb} in Notion's shorthand form. Notion validates the whole map in one form or the other, ` +
      `so the wrapped entry is the one it rejected — the mix is the mistake, not ${key} itself.`,
    `Fix: use one form for every entry — wrap the shorthand ones ("${shorthand[0]}": {"<its property type>": ...}), ` +
      `or send ${key} shorthand instead (one of: ${accepted.join(', ')}).`,
  ].join('\n')
}

/**
 * Rewrite a Notion `validation_error` message so the specific mismatch comes
 * first. Any message that is not the multi-alternative shape is returned
 * unchanged — single-mismatch messages are already precise.
 *
 * @param message the `message` field of Notion's error body
 * @param params  the arguments sent for the call, used to say what the
 *                offending value actually was; omitted, the summary just
 *                drops that clause
 */
export function formatValidationErrorMessage(message: string, params?: unknown): string {
  if (typeof message !== 'string' || !message.startsWith(FIX_ONE_PREFIX)) return message

  const lines = message
    .slice(FIX_ONE_PREFIX.length)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  const alternatives = parseAlternatives(lines)
  if (!alternatives || alternatives.length < 2) return message

  const specific = alternatives.filter((a) => !a.missingKey)

  if (specific.length > 0) {
    // Notion got furthest into the branch with the deepest reported path —
    // that is the variant closest to what was actually sent.
    const closest = specific.reduce((best, a) => (a.path.split('.').length > best.path.split('.').length ? a : best))
    const rest = alternatives.filter((a) => a !== closest)
    const head = `body failed validation: ${closest.line}`
    return rest.length > 0
      ? `${head}\nThat is the closest match of ${alternatives.length} alternatives Notion tried; the others wanted: ${rest
          .map((a) => a.path)
          .join(', ')}.`
      : head
  }

  // Every branch was abandoned for a missing discriminating key, so none of
  // them names the mistake: the key that WAS sent is not a known one.
  const prefix = commonPrefix(alternatives.map((a) => a.path))
  const accepted = alternatives.map((a) => a.path.slice(prefix.length + 1)).filter(Boolean)

  const mixedForms = explainMixedPropertyForms(prefix, params, accepted)
  if (mixedForms) return mixedForms

  const sent = describeSent(valueAtPath(params, prefix))
  const target = prefix || 'the request body'

  return [
    `body failed validation: ${target} matches none of the ${alternatives.length} accepted variants — exactly one of these keys must be present, and none was.${
      sent ? ` ${sent}.` : ''
    }`,
    `Expected one of: ${accepted.join(', ')}.`,
  ].join('\n')
}

/**
 * Apply {@link formatValidationErrorMessage} to a Notion error body, leaving
 * every other error body — and every other field of this one — untouched.
 */
export function formatValidationError<T>(data: T, params?: unknown): T {
  if (typeof data !== 'object' || data === null) return data
  const body = data as { code?: unknown; message?: unknown }
  if (body.code !== 'validation_error' || typeof body.message !== 'string') return data
  const message = formatValidationErrorMessage(body.message, params)
  return message === body.message ? data : { ...data, message }
}
