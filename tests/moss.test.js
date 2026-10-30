import test from 'node:test'
import assert from 'node:assert/strict'
import {
  compileMossLayout,
  validateLayout,
  layoutToElements,
  parseCompiledMossPrompt,
  isCompiledMossPrompt,
} from '../lib/moss.js'

const base = {
  width: 1536,
  height: 1024,
  summary: 'A warm studio campaign for a handmade ceramic cup.',
  items: [
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

test('floors top/left and ceils bottom/right pixel edges', () => {
  const layout = {
    width: 1024,
    height: 1024,
    summary: 's',
    items: [{ label: 'object', caption: 'c', bbox: [10.2, 20.7, 30.1, 40.9] }],
  }
  const parsed = JSON.parse(compileMossLayout(layout))
  assert.deepEqual(parsed.items[0].bbox, [20 - 512, 10 - 512, 41 - 512, 31 - 512])
})

test('keeps item key order label, caption, text, palette, bbox', () => {
  const layout = {
    width: 512,
    height: 512,
    summary: 's',
    items: [
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
  assert.deepEqual(validateLayout({ width: 1000, height: 1024, summary: '', items: [] }), [
    'width must be a multiple of 16 (MOSS-Image requirement)',
  ])
  assert.throws(() => compileMossLayout({ ...base, width: 1530 }), /multiple of 16/)
  assert.throws(
    () => compileMossLayout({ ...base, items: [{ ...base.items[0], bbox: [0, 0, 2000, 100] }] }),
    /exceeds the 1536x1024 canvas/,
  )
  assert.throws(
    () => compileMossLayout({ ...base, items: [{ ...base.items[0], label: 'text', text: '' }] }),
    /text is required/,
  )
})

test('normalized elements match CreateBoundingBoxes expectations', () => {
  const elements = layoutToElements({
    width: 1000,
    height: 500,
    summary: 's',
    items: [{ label: 'object', caption: 'cup', bbox: [100, 50, 400, 250], palette: ['#ff0000'] }],
  })
  assert.deepEqual(elements, [
    { type: 'obj', bbox: [100, 100, 500, 400], desc: 'cup', color_palette: ['#ff0000'] },
  ])
})

test('parses a compiled prompt back to an editable layout', () => {
  const text = compileMossLayout(base)
  assert.equal(isCompiledMossPrompt(text), true)
  const parsed = parseCompiledMossPrompt(text, 1536, 1024)
  assert.equal(parsed.summary, base.summary)
  assert.deepEqual(parsed.items[0].bbox, [176, 224, 800, 864])
})
