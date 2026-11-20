import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canSetSeedControl,
  isSeedWidget,
  seedControlOf,
  setNodeWidget,
  setSeedControl,
  widgetIndex,
  widgetSlots,
} from '../src/client/workflow-ui.js'

const widget = (name, type = 'INT', link = null) => ({ name, type, widget: { name }, link })

function sampler(overrides = {}) {
  return {
    id: 6,
    type: 'KSampler',
    mode: 0,
    outputs: [{ name: 'LATENT', type: 'LATENT' }],
    inputs: [
      { name: 'model', type: 'MODEL', link: 1 },
      widget('seed'),
      widget('steps'),
      widget('cfg', 'FLOAT'),
      widget('sampler_name', 'COMBO'),
      widget('scheduler', 'COMBO'),
      widget('denoise', 'FLOAT'),
    ],
    widgets_values: [123, 'fixed', 20, 6, 'euler', 'normal', 0.85],
    widgets_values_named: { seed: 123, steps: 20, cfg: 6, sampler_name: 'euler', scheduler: 'normal', denoise: 0.85 },
    ...overrides,
  }
}

const info = {
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

test('the client slot walk keeps the control token out of the next widget', () => {
  const slots = widgetSlots(sampler())
  assert.equal(slots.get('seed').index, 0)
  assert.equal(slots.get('seed').control, 'fixed')
  assert.equal(slots.get('steps').index, 2)
  assert.equal(widgetIndex(sampler(), 'steps'), 2)
  assert.equal(widgetIndex(sampler(), 'denoise'), 6)
})

test('a seed is controllable only while its input is not linked', () => {
  assert.equal(isSeedWidget(sampler(), 'seed'), true)
  assert.equal(isSeedWidget(sampler(), 'steps'), false)
  assert.equal(canSetSeedControl(sampler(), 'seed'), true)
  const linked = sampler({ inputs: sampler().inputs.map((input) => (input.name === 'seed' ? { ...input, link: 9 } : input)) })
  assert.equal(isSeedWidget(linked, 'seed'), false)
  assert.equal(canSetSeedControl(linked, 'seed'), false)
  assert.equal(canSetSeedControl(sampler({ widgets_values: undefined }), 'seed'), false)
})

test('seedControlOf reads the stored mode and falls back to ComfyUI default', () => {
  assert.equal(seedControlOf(sampler(), 'seed'), 'fixed')
  const old = sampler({ widgets_values: [123, 20, 6, 'euler', 'normal', 0.85] })
  assert.equal(seedControlOf(old, 'seed'), 'randomize')
})

test('setSeedControl replaces the mode without moving other widgets', () => {
  const next = setSeedControl({ nodes: [sampler()] }, 6, 'seed', 'randomize')
  assert.deepEqual(next.nodes[0].widgets_values.slice(0, 3), [123, 'randomize', 20])
  assert.equal(next.nodes[0].widgets_values[6], 0.85)
  assert.equal(next.nodes[0].widgets_values_named.seed, 123)
})

test('setSeedControl inserts the token into an older workflow', () => {
  const old = { nodes: [sampler({ widgets_values: [123, 20, 6, 'euler', 'normal', 0.85] })] }
  const next = setSeedControl(old, 6, 'seed', 'increment')
  assert.deepEqual(next.nodes[0].widgets_values, [123, 'increment', 20, 6, 'euler', 'normal', 0.85])
  assert.equal(widgetIndex(next.nodes[0], 'denoise'), 6)
})

test('editing the seed value leaves the mode alone', () => {
  const next = setNodeWidget({ nodes: [sampler()] }, 6, 'seed', 500, info)
  assert.equal(next.nodes[0].widgets_values[0], 500)
  assert.equal(next.nodes[0].widgets_values[1], 'fixed')
  assert.equal(seedControlOf(next.nodes[0], 'seed'), 'fixed')
})
