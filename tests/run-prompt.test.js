import test from 'node:test'
import assert from 'node:assert/strict'
import { runPromptText } from '../lib/run.js'

test('a painted mask with a mask prompt drives the run', () => {
  const plan = runPromptText({
    prompt: 'a whole-image description',
    maskPrompt: 'yellow hair, single ponytail',
    maskPainted: true,
  })
  assert.deepEqual(plan, { text: 'yellow hair, single ponytail', kind: 'mask' })
})

test('a painted mask without a mask prompt falls back to the canvas prompt', () => {
  const plan = runPromptText({ prompt: 'a whole-image description', maskPrompt: '   ', maskPainted: true })
  assert.deepEqual(plan, { text: 'a whole-image description', kind: 'canvas' })
})

test('the mask prompt is ignored while no mask is painted', () => {
  const plan = runPromptText({
    prompt: 'a whole-image description',
    maskPrompt: 'yellow hair',
    maskPainted: false,
  })
  assert.deepEqual(plan, { text: 'a whole-image description', kind: 'canvas' })
})

test('a MOSS layout run always sends the whole-image description', () => {
  const plan = runPromptText({
    prompt: 'a whole-image description',
    maskPrompt: 'yellow hair',
    summaryCaption: 'the user summary',
    maskPainted: true,
  })
  assert.deepEqual(plan, { text: 'the user summary', kind: 'layout' })
})

test('missing prompts normalize to an empty string', () => {
  assert.deepEqual(runPromptText({}), { text: '', kind: 'canvas' })
})
