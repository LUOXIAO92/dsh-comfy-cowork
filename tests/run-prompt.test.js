import test from 'node:test'
import assert from 'node:assert/strict'
import { runPassPrompt } from '../lib/run.js'

test('a mask region with a prompt sends exactly that prompt', () => {
  const plan = runPassPrompt({ regionPrompt: 'white feather wing', maskPass: true })
  assert.deepEqual(plan, { text: 'white feather wing', kind: 'mask' })
})

test('an empty region prompt is an empty local repaint, never the canvas prompt', () => {
  const plan = runPassPrompt({ prompt: 'a whole-image description', regionPrompt: '', maskPass: true })
  assert.deepEqual(plan, { text: '', kind: 'empty' })
})

test('a whitespace-only region prompt counts as empty', () => {
  const plan = runPassPrompt({ prompt: 'a whole-image description', regionPrompt: '   ', maskPass: true })
  assert.deepEqual(plan, { text: '   ', kind: 'empty' })
})

test('the mask prompt is ignored while no mask is painted', () => {
  const plan = runPassPrompt({ prompt: 'a whole-image description', regionPrompt: 'yellow hair' })
  assert.deepEqual(plan, { text: 'a whole-image description', kind: 'canvas' })
})

test('a MOSS layout run always sends the whole-image description', () => {
  const plan = runPassPrompt({ prompt: 'a whole-image description', regionPrompt: 'yellow hair', summaryCaption: 'the user summary', maskPass: true })
  assert.deepEqual(plan, { text: 'the user summary', kind: 'layout' })
})

test('missing prompts normalize to an empty canvas prompt', () => {
  assert.deepEqual(runPassPrompt({}), { text: '', kind: 'canvas' })
})
