import test from 'node:test'
import assert from 'node:assert/strict'
import {
  compileMossLayout,
  validateLayout,
  layoutToElements,
  parseCompiledMossPrompt,
  isCompiledMossPrompt,
} from '../lib/moss.js'

const summary = {
  id: 'summary',
  label: 'summary',
  caption: 'A warm studio campaign for a handmade ceramic cup.',
  text: '',
  bbox: [0, 0, 1536, 1024],
  palette: [],
}

const base = {
  width: 1536,
  height: 1024,
  items: [
    summary,
    {
      id: 'a',
      label: 'object',
      caption: 'An ivory ceramic cup with a rounded handle.',
      bbox: [176, 224, 800, 864],
      text: '',
      palette: [],
    },
  ],
}

test('compiles the same byte string as ComfyUI MOSSImageLayoutPrompt', () => {
  const out = compileMossLayout(base)
  assert.equal(
    out,
    '{"summary":{"caption":"A warm studio campaign for a handmade ceramic cup."},"items":[{"label":"object","caption":"An ivory ceramic cup with a rounded handle.","bbox":[-288,-592,352,32]}],"bbox_coord_space":"abs_centralized","bbox_format":"yxyx"}',
  )
})

test('the summary item is the summary caption, never a layout item', () => {
  const parsed = JSON.parse(compileMossLayout(base))
  assert.equal(parsed.items.length, 1)
  assert.equal(parsed.items[0].label, 'object')
  assert.equal(parsed.summary.caption, summary.caption)
  // Its bbox is a canvas handle only; an out-of-canvas one must not fail.
  const loose = { ...base, items: [{ ...summary, bbox: [0, 0, 99999, 99999] }, base.items[1]] }
  assert.doesNotThrow(() => compileMossLayout(loose))
})

test('floors top/left and ceils bottom/right pixel edges', () => {
  const layout = {
    width: 1024,
    height: 1024,
    items: [
      { label: 'summary', caption: 's', bbox: [0, 0, 1024, 1024] },
      { label: 'object', caption: 'c', bbox: [10.2, 20.7, 30.1, 40.9] },
    ],
  }
  const parsed = JSON.parse(compileMossLayout(layout))
  assert.deepEqual(parsed.items[0].bbox, [20 - 512, 10 - 512, 41 - 512, 31 - 512])
})

test('keeps item key order label, caption, text, palette, bbox', () => {
  const layout = {
    width: 512,
    height: 512,
    items: [
      { label: 'summary', caption: 's', bbox: [0, 0, 512, 512] },
      {
        label: 'text',
        caption: 'title',
        text: '你好',
        palette: ['#ffffff'],
        bbox: [0, 0, 100, 50],
      },
    ],
  }
  const out = compileMossLayout(layout)
  assert.equal(
    out,
    '{"summary":{"caption":"s"},"items":[{"label":"text","caption":"title","text":"你好","palette":["#ffffff"],"bbox":[-256,-256,-206,-156]}],"bbox_coord_space":"abs_centralized","bbox_format":"yxyx"}',
  )
})

test('rejects invalid layouts with concrete reasons', () => {
  assert.deepEqual(validateLayout({ width: 1000, height: 1024, items: [] }), [
    'width must be a multiple of 16 (MOSS-Image requirement)',
  ])
  assert.throws(() => compileMossLayout({ ...base, width: 1530 }), /multiple of 16/)
  assert.throws(
    () => compileMossLayout({ ...base, items: [summary, { ...base.items[1], bbox: [0, 0, 2000, 100] }] }),
    /exceeds the 1536x1024 canvas/,
  )
  assert.throws(
    () => compileMossLayout({ ...base, items: [summary, { ...base.items[1], label: 'text', text: '' }] }),
    /text is required/,
  )
})

test('requires exactly one non-empty summary item when boxes exist', () => {
  assert.throws(
    () => compileMossLayout({ width: 512, height: 512, items: [base.items[1]] }),
    /needs one whole-image description item/,
  )
  assert.throws(
    () => compileMossLayout({ width: 512, height: 512, items: [{ ...summary, caption: '  ' }, base.items[1]] }),
    /whole-image description item \(label summary\) must not be empty/,
  )
  assert.throws(
    () => compileMossLayout({ width: 512, height: 512, items: [summary, { ...summary, id: 's2' }, base.items[1]] }),
    /only one whole-image description item/,
  )
})

test('normalized elements match CreateBoundingBoxes expectations', () => {
  const elements = layoutToElements({
    width: 1000,
    height: 500,
    items: [
      { label: 'summary', caption: 's', bbox: [0, 0, 1000, 500] },
      { label: 'object', caption: 'cup', bbox: [100, 50, 400, 250], palette: ['#ff0000'] },
    ],
  })
  assert.deepEqual(elements, [
    { type: 'obj', bbox: [100, 100, 500, 400], desc: 'cup', color_palette: ['#ff0000'] },
  ])
})

test('parses a compiled prompt back to an editable layout', () => {
  const text = compileMossLayout(base)
  assert.equal(isCompiledMossPrompt(text), true)
  const parsed = parseCompiledMossPrompt(text, 1536, 1024)
  assert.equal(parsed.items[0].label, 'summary')
  assert.equal(parsed.items[0].caption, summary.caption)
  assert.deepEqual(parsed.items[1].bbox, [176, 224, 800, 864])
})
