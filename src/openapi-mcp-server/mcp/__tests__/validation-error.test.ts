import { describe, it, expect } from 'vitest'
import { formatValidationError, formatValidationErrorMessage } from '../validation-error'

/**
 * Verbatim body returned by Notion (request 6afdaebe-2879-4c24-9139-adf803caff89)
 * for `API-patch-block-children` with `{"type": "note", "note": {...}}` — a block
 * type that does not exist. 34 alternatives, none of which mentions `note`.
 */
const UNKNOWN_BLOCK_TYPE_MESSAGE = [
  'body failed validation. Fix one:',
  ...[
    'embed',
    'bookmark',
    'image',
    'video',
    'pdf',
    'file',
    'audio',
    'code',
    'equation',
    'divider',
    'breadcrumb',
    'tab',
    'table_of_contents',
    'link_to_page',
    'table_row',
    'ai_block',
    'meeting_notes',
    'custom_block',
    'table',
    'column_list',
    'column',
    'heading_1',
    'heading_2',
    'heading_3',
    'heading_4',
    'paragraph',
    'bulleted_list_item',
    'numbered_list_item',
    'quote',
    'to_do',
    'toggle',
    'template',
    'callout',
    'synced_block',
  ].map((key) => `body.children[0].${key} should be defined, instead was \`undefined\`.`),
].join('\n')

const SENT_PARAMS = {
  block_id: '3b2152ed-8271-8187-8e73-d21be2176197',
  children: [{ object: 'block', type: 'note', note: { rich_text: [{ type: 'text', text: { content: 'x' } }] } }],
}

describe('formatValidationErrorMessage', () => {
  describe('a union failure where no variant matched', () => {
    const formatted = formatValidationErrorMessage(UNKNOWN_BLOCK_TYPE_MESSAGE, SENT_PARAMS)
    const firstLine = formatted.split('\n')[0]

    it('names the failing field and what was actually sent in the first line', () => {
      expect(firstLine).toContain('body.children[0]')
      expect(firstLine).toContain('"note"')
      expect(firstLine).toContain('Sent keys: object, type, note')
    })

    it('does not open with an undifferentiated dump of alternatives', () => {
      expect(firstLine).not.toContain('Fix one')
      expect(firstLine).not.toContain('should be defined, instead was')
    })

    it('collapses 34 lines into two', () => {
      expect(UNKNOWN_BLOCK_TYPE_MESSAGE.split('\n')).toHaveLength(35)
      expect(formatted.split('\n')).toHaveLength(2)
    })

    it('still says which keys are accepted, after the mismatch', () => {
      expect(formatted.split('\n')[1]).toBe(
        'Expected one of: embed, bookmark, image, video, pdf, file, audio, code, equation, divider, breadcrumb, tab, ' +
          'table_of_contents, link_to_page, table_row, ai_block, meeting_notes, custom_block, table, column_list, column, ' +
          'heading_1, heading_2, heading_3, heading_4, paragraph, bulleted_list_item, numbered_list_item, quote, to_do, ' +
          'toggle, template, callout, synced_block.',
      )
    })

    it('omits the sent-value clause when the arguments are unavailable', () => {
      const withoutParams = formatValidationErrorMessage(UNKNOWN_BLOCK_TYPE_MESSAGE)
      expect(withoutParams.split('\n')[0]).toContain('body.children[0] matches none of the 34 accepted variants')
      expect(withoutParams).not.toContain('Sent keys')
    })
  })

  describe('a union failure where one variant got further than the rest', () => {
    const message = [
      'body failed validation. Fix one:',
      'body.children[0].embed should be defined, instead was `undefined`.',
      'body.children[0].paragraph.rich_text[0].text.content should be a string, instead was `12345`.',
      'body.children[0].callout should be defined, instead was `undefined`.',
    ].join('\n')

    it('leads with that variant’s specific mismatch', () => {
      expect(formatValidationErrorMessage(message).split('\n')[0]).toBe(
        'body failed validation: body.children[0].paragraph.rich_text[0].text.content should be a string, instead was `12345`.',
      )
    })

    it('keeps the remaining alternatives to one trailing line', () => {
      const formatted = formatValidationErrorMessage(message)
      expect(formatted.split('\n')).toHaveLength(2)
      expect(formatted.split('\n')[1]).toBe(
        'That is the closest match of 3 alternatives Notion tried; the others wanted: body.children[0].embed, body.children[0].callout.',
      )
    })
  })

  describe('messages that are already precise', () => {
    it.each([
      'body failed validation: body.children[0].to_do.checked should be a boolean or `undefined`, instead was `"yes"`.',
      'body failed validation: body.children[0].callout.rich_text should be defined, instead was `undefined`.',
      'Could not find block with ID: 1234. Make sure the relevant pages and databases are shared with your integration.',
    ])('leaves them untouched: %s', (message) => {
      expect(formatValidationErrorMessage(message, SENT_PARAMS)).toBe(message)
    })
  })

  it('leaves a union message untouched when its lines are not the expected shape', () => {
    const message = 'body failed validation. Fix one:\nsomething entirely different'
    expect(formatValidationErrorMessage(message)).toBe(message)
  })
})

describe('formatValidationError', () => {
  it('rewrites only the message of a validation_error body', () => {
    const body = { object: 'error', status: 400, code: 'validation_error', message: UNKNOWN_BLOCK_TYPE_MESSAGE, request_id: 'abc' }
    const formatted = formatValidationError(body, SENT_PARAMS)
    expect(formatted.message).not.toBe(UNKNOWN_BLOCK_TYPE_MESSAGE)
    expect(formatted).toMatchObject({ object: 'error', status: 400, code: 'validation_error', request_id: 'abc' })
  })

  it.each([
    { code: 'object_not_found', message: UNKNOWN_BLOCK_TYPE_MESSAGE },
    { code: 'validation_error', message: 'body failed validation: body.parent should be defined, instead was `undefined`.' },
    { code: 'validation_error' },
    'not an object',
    null,
  ])('returns other bodies unchanged: %j', (body) => {
    expect(formatValidationError(body)).toBe(body)
  })
})
