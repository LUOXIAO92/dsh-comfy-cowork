import test from 'node:test'
import assert from 'node:assert/strict'
import { describe, discover, dispatchEntry, validateArguments } from '../lib/tools.js'

function feature(name, group, description, aliases, parameters = { type: 'object', properties: {}, required: [], additionalProperties: false }) {
  return {
    name,
    group,
    description,
    aliases,
    parameters,
    execute: async (args) => ({ feature: name, args }),
  }
}

const FEATURES = new Map([
  ['run', feature('run', 'runs', 'Queue a ComfyUI run with the canvas inputs.', ['跑图', '生成'], {
    type: 'object',
    properties: {
      seed: { type: 'number', description: 'Optional seed override.' },
      wait_seconds: { type: 'number' },
    },
    required: [],
    additionalProperties: false,
  })],
  ['run_status', feature('run_status', 'runs', 'Read one run by id or the latest.', ['状态', '进度'])],
  ['list_nodes', feature('list_nodes', 'catalog', 'Browse the node type tree.', ['节点', 'node'], {
    type: 'object',
    properties: { category: { type: 'string' } },
    required: ['category'],
    additionalProperties: false,
  })],
])

test('discover with no arguments lists the feature groups', () => {
  const result = discover(FEATURES)
  assert.equal(result.action, 'discover')
  assert.deepEqual(result.groups.map((entry) => entry.group), ['canvas', 'workflow', 'runs', 'catalog', 'misc'])
  assert.equal(result.groups.find((entry) => entry.group === 'runs').features, 2)
  assert.equal(result.groups.find((entry) => entry.group === 'catalog').features, 1)
})

test('discover with a group lists only that group features and their descriptions', () => {
  const result = discover(FEATURES, '', 'runs')
  assert.deepEqual(result.features.map((entry) => entry.feature), ['run', 'run_status'])
  assert.match(result.features[0].description, /Queue/)
  assert.throws(() => discover(FEATURES, '', 'nope'), /request\.group: unknown group "nope"/)
})

test('discover with a Chinese query matches aliases', () => {
  const result = discover(FEATURES, '节点')
  assert.ok(result.features.some((entry) => entry.feature === 'list_nodes'))
  assert.ok(result.groups.some((entry) => entry.group === 'catalog'))
  assert.equal(result.query, '节点')
})

test('describe returns the input schema of the requested features only', () => {
  const result = describe(FEATURES, ['run', 'run_status'])
  assert.equal(result.features.length, 2)
  assert.equal(result.features[0].feature, 'run')
  assert.equal(result.features[0].group, 'runs')
  assert.deepEqual(result.features[0].input_schema.properties.seed.type, 'number')
  assert.throws(() => describe(FEATURES, 'nope'), /unknown feature "nope"/)
  assert.throws(() => describe(FEATURES, []), /provide one or more feature names/)
})

test('arguments are validated field by field', () => {
  const schema = FEATURES.get('list_nodes').parameters
  assert.throws(() => validateArguments(schema, {}, 'arguments'), /arguments\.category: required/)
  assert.throws(() => validateArguments(schema, { category: 3 }, 'arguments'), /arguments\.category: expected a string/)
  assert.throws(() => validateArguments(schema, { category: 'a', extra: 1 }, 'arguments'), /arguments\.extra: not a declared argument/)
  assert.deepEqual(validateArguments(schema, { category: 'KJNodes' }, 'arguments'), { category: 'KJNodes' })
})

test('dispatch executes a feature with validated arguments', async () => {
  const called = await dispatchEntry(FEATURES, { action: 'execute', feature: 'run', arguments: { seed: 7 } }, {})
  assert.deepEqual(called, { feature: 'run', args: { seed: 7 } })
  await assert.rejects(() => dispatchEntry(FEATURES, { action: 'execute', feature: 'nope' }, {}), /unknown feature/)
  await assert.rejects(() => dispatchEntry(FEATURES, { action: 'execute' }, {}), /request\.feature: required/)
  await assert.rejects(() => dispatchEntry(FEATURES, { action: 'nope' }, {}), /request\.action: expected/)
})
