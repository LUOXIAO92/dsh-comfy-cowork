import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SEED_MAX,
  advanceSeedValue,
  applySeedValues,
  seedWidgetsOf,
  widgetSlots,
} from '../lib/seed.js'
import { workflowToPrompt } from '../lib/workflow.js'

const widget = (name, type = 'INT') => ({ name, type, widget: { name }, link: null })

function samplerWidgets() {
  return [
    { id: 6, type: 'KSampler', mode: 0, outputs: [{ name: 'LATENT', type: 'LATENT' }], inputs: [
      { name: 'model', type: 'MODEL', link: 1 },
      { name: 'positive', type: 'CONDITIONING', link: 2 },
      { name: 'negative', type: 'CONDITIONING', link: 3 },
      { name: 'latent_image', type: 'LATENT', link: 4 },
      widget('seed'),
      widget('steps'),
      widget('cfg', 'FLOAT'),
      widget('sampler_name', 'COMBO'),
      widget('scheduler', 'COMBO'),
      widget('denoise', 'FLOAT'),
    ] }
  ]
}

const samplerNode = (overrides = {}) => ({
  ...samplerWidgets()[0],
  widgets_values: [123, 'fixed', 20, 6, 'euler', 'normal', 0.85],
  widgets_values_named: { seed: 123, steps: 20, cfg: 6, sampler_name: 'euler', scheduler: 'normal', denoise: 0.85 },
  ...overrides,
})

test('widgetSlots reads the control token that follows a seed widget', () => {
  const node = samplerNode({ widgets_values: [123, 'randomize', 20, 6, 'euler', 'normal', 0.85] })
  const slots = widgetSlots(node)
  assert.equal(slots.get('seed').index, 0)
  assert.equal(slots.get('seed').value, 123)
  assert.equal(slots.get('seed').control, 'randomize')
  assert.equal(slots.get('seed').controlIndex, 1)
  // The token must not shift the widgets after it.
  assert.equal(slots.get('steps').index, 2)
  assert.equal(slots.get('steps').value, 20)
  assert.equal(slots.get('denoise').index, 6)
  assert.equal(slots.get('denoise').value, 0.85)
})

test('seedWidgetsOf finds seed and noise_seed, and defaults to randomize', () => {
  const nodes = [
    samplerNode(),
    { id: 20, type: 'SamplerCustom', mode: 0, inputs: [widget('noise_seed')], widgets_values: [7, 'increment'], outputs: [] },
    { id: 21, type: 'OldSampler', mode: 0, inputs: [widget('seed')], widgets_values: [5], outputs: [] },
  ]
  const widgets = seedWidgetsOf({ nodes })
  assert.deepEqual(widgets, [
    { nodeId: '6', name: 'seed', value: 123, control: 'fixed', valueIndex: 0, controlIndex: 1 },
    { nodeId: '20', name: 'noise_seed', value: 7, control: 'increment', valueIndex: 0, controlIndex: 1 },
    { nodeId: '21', name: 'seed', value: 5, control: 'randomize', valueIndex: 0, controlIndex: -1 },
  ])
})

test('seedWidgetsOf skips linked, muted and bypassed seed widgets', () => {
  const linked = samplerNode({ inputs: samplerNode().inputs.map((input) => (input.name === 'seed' ? { ...input, link: 9 } : input)) })
  const muted = samplerNode({ mode: 2 })
  const bypassed = samplerNode({ mode: 4 })
  assert.deepEqual(seedWidgetsOf({ nodes: [linked, muted, bypassed] }), [])
})

test('the named copy wins for the value while the control stays positional', () => {
  const node = samplerNode({ widgets_values_named: { seed: 900, steps: 33, cfg: 9.5 } })
  assert.equal(seedWidgetsOf({ nodes: [node] })[0].value, 900)
})

test('advanceSeedValue follows ComfyUI: clamp, never wrap, randomize below 2^50', () => {
  assert.equal(advanceSeedValue(123, 'fixed'), 123)
  assert.equal(advanceSeedValue(123, 'increment'), 124)
  assert.equal(advanceSeedValue(SEED_MAX, 'increment'), SEED_MAX)
  assert.equal(advanceSeedValue(123, 'decrement'), 122)
  assert.equal(advanceSeedValue(0, 'decrement'), 0)
  assert.equal(advanceSeedValue(123, 'randomize', () => 0.5), SEED_MAX / 2)
  assert.equal(advanceSeedValue(123, 'randomize', () => 0), 0)
  assert.ok(advanceSeedValue(123, 'randomize') < SEED_MAX)
})

test('applySeedValues writes the positional and named copies, not the control token', () => {
  const workflow = { nodes: [samplerNode({ widgets_values: [123, 'randomize', 20, 6, 'euler', 'normal', 0.85] })] }
  const applied = applySeedValues(workflow, [{ nodeId: '6', name: 'seed', value: 456 }])
  assert.equal(applied, 1)
  const node = workflow.nodes[0]
  assert.deepEqual(node.widgets_values.slice(0, 3), [456, 'randomize', 20])
  assert.equal(node.widgets_values_named.seed, 456)
  assert.equal(node.widgets_values_named.steps, 20)
})

test('applySeedValues ignores a node that is gone', () => {
  const workflow = { nodes: [samplerNode()] }
  assert.equal(applySeedValues(workflow, [{ nodeId: '99', name: 'seed', value: 1 }]), 0)
  assert.equal(workflow.nodes[0].widgets_values[0], 123)
})

test('a partial named map does not erase the positional widgets on conversion', () => {
  // The node editor adds named values for the widget it edits; an older
  // workflow may have had none. Steps/cfg must still come from the array.
  const objectInfo = {
    KSampler: {
      input: { required: {
        seed: ['INT', { default: 0 }],
        steps: ['INT', { default: 20 }],
        cfg: ['FLOAT', { default: 7 }],
        sampler_name: ['COMBO', { options: ['euler'] }],
        scheduler: ['COMBO', { options: ['normal'] }],
        denoise: ['FLOAT', { default: 1 }],
      } },
      input_order: { required: ['seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'] },
      output: ['LATENT'],
    },
  }
  const node = samplerNode({ widgets_values: [42, 'randomize', 33, 9.5, 'euler', 'normal', 0.7], widgets_values_named: { seed: 42 } })
  const { prompt } = workflowToPrompt({ nodes: [node], links: [] }, objectInfo)
  assert.deepEqual(prompt['6'].inputs, {
    seed: 42,
    steps: 33,
    cfg: 9.5,
    sampler_name: 'euler',
    scheduler: 'normal',
    denoise: 0.7,
  })
})
