import test from 'node:test'
import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { RunManager } from '../lib/run.js'
import { normalizeConfig } from '../lib/config.js'
import { encodePng } from '../lib/png.js'
import { SEED_MAX, applySeedValues } from '../lib/seed.js'

const widget = (name, type = 'INT') => ({ name, type, widget: { name }, link: null })

const info = {
  CheckpointLoaderSimple: {
    input: { required: { ckpt_name: ['COMBO', { options: ['model.safetensors'] }] } },
    input_order: { required: ['ckpt_name'] },
    output: ['MODEL', 'CLIP', 'VAE'],
  },
  CLIPTextEncode: {
    input: { required: { clip: ['CLIP'], text: ['STRING', { multiline: true }] } },
    input_order: { required: ['clip', 'text'] },
    output: ['CONDITIONING'],
  },
  EmptyLatentImage: {
    input: { required: { width: ['INT', { default: 512 }], height: ['INT', { default: 512 }], batch_size: ['INT', { default: 1 }] } },
    input_order: { required: ['width', 'height', 'batch_size'] },
    output: ['LATENT'],
  },
  KSampler: {
    input: { required: {
      model: ['MODEL'],
      positive: ['CONDITIONING'],
      negative: ['CONDITIONING'],
      latent_image: ['LATENT'],
      seed: ['INT', { default: 0 }],
      steps: ['INT', { default: 20 }],
      cfg: ['FLOAT', { default: 7 }],
      sampler_name: ['COMBO', { options: ['euler'] }],
      scheduler: ['COMBO', { options: ['normal'] }],
      denoise: ['FLOAT', { default: 1 }],
    } },
    input_order: { required: ['model', 'positive', 'negative', 'latent_image', 'seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'] },
    output: ['LATENT'],
  },
  SamplerCustom: {
    input: { required: { noise_seed: ['INT', { default: 0 }] } },
    input_order: { required: ['noise_seed'] },
    output: ['LATENT'],
  },
  VAEDecode: {
    input: { required: { samples: ['LATENT'], vae: ['VAE'] } },
    input_order: { required: ['samples', 'vae'] },
    output: ['IMAGE'],
  },
  SaveImage: {
    input: { required: { images: ['IMAGE'], filename_prefix: ['STRING', { default: 'ComfyUI' }] } },
    input_order: { required: ['images', 'filename_prefix'] },
    output: [],
  },
}

/** A minimal text-to-image graph: checkpoint → prompts → KSampler → decode → save. */
function workflowWith(seedControl = 'increment', extraNodes = []) {
  return {
    nodes: [
      { id: 1, type: 'CheckpointLoaderSimple', mode: 0, inputs: [], outputs: [{ name: 'MODEL', type: 'MODEL' }, { name: 'CLIP', type: 'CLIP' }, { name: 'VAE', type: 'VAE' }], widgets_values: ['model.safetensors'], widgets_values_named: { ckpt_name: 'model.safetensors' } },
      { id: 2, type: 'CLIPTextEncode', mode: 0, inputs: [{ name: 'clip', type: 'CLIP', link: 2 }, widget('text', 'STRING')], outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING' }], widgets_values: ['canvas prompt'], widgets_values_named: { text: 'canvas prompt' } },
      { id: 3, type: 'CLIPTextEncode', mode: 0, inputs: [{ name: 'clip', type: 'CLIP', link: 3 }, widget('text', 'STRING')], outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING' }], widgets_values: ['negative'], widgets_values_named: { text: 'negative' } },
      { id: 4, type: 'EmptyLatentImage', mode: 0, inputs: [widget('width'), widget('height'), widget('batch_size')], outputs: [{ name: 'LATENT', type: 'LATENT' }], widgets_values: [512, 512, 1], widgets_values_named: { width: 512, height: 512, batch_size: 1 } },
      { id: 6, type: 'KSampler', mode: 0, inputs: [
        { name: 'model', type: 'MODEL', link: 1 },
        { name: 'positive', type: 'CONDITIONING', link: 5 },
        { name: 'negative', type: 'CONDITIONING', link: 6 },
        { name: 'latent_image', type: 'LATENT', link: 7 },
        widget('seed'),
        widget('steps'),
        widget('cfg', 'FLOAT'),
        widget('sampler_name', 'COMBO'),
        widget('scheduler', 'COMBO'),
        widget('denoise', 'FLOAT'),
      ], outputs: [{ name: 'LATENT', type: 'LATENT' }], widgets_values: [123, seedControl, 20, 6, 'euler', 'normal', 0.85], widgets_values_named: { seed: 123, steps: 20, cfg: 6, sampler_name: 'euler', scheduler: 'normal', denoise: 0.85 } },
      { id: 7, type: 'VAEDecode', mode: 0, inputs: [{ name: 'samples', type: 'LATENT', link: 8 }, { name: 'vae', type: 'VAE', link: 4 }], outputs: [{ name: 'IMAGE', type: 'IMAGE' }], widgets_values: [] },
      { id: 8, type: 'SaveImage', mode: 0, inputs: [{ name: 'images', type: 'IMAGE', link: 9 }], outputs: [], widgets_values: ['out'], widgets_values_named: { filename_prefix: 'out' } },
      ...extraNodes,
    ],
    links: [
      [1, 1, 0, 6, 0, 'MODEL'],
      [2, 1, 1, 2, 0, 'CLIP'],
      [3, 1, 1, 3, 0, 'CLIP'],
      [4, 1, 2, 7, 1, 'VAE'],
      [5, 2, 0, 6, 1, 'CONDITIONING'],
      [6, 3, 0, 6, 2, 'CONDITIONING'],
      [7, 4, 0, 6, 3, 'LATENT'],
      [8, 6, 0, 7, 0, 'LATENT'],
      [9, 7, 0, 8, 0, 'IMAGE'],
    ],
  }
}

function opaquePng(size = 8) {
  return encodePng(size, size, 4, Buffer.alloc(size * size * 4, 255))
}

async function makeManager({ seedControl = 'increment', extraNodes = [], json, api } = {}) {
  const queueCalls = []
  const doc = {
    workflow: {
      name: 'seed.json',
      json: json === undefined ? workflowWith(seedControl, extraNodes) : json,
      api,
      bindings: { prompt: '2', negative: '3', image: '', mask: '', width: '4', height: '4', seed: '6', denoise: '6' },
    },
    layout: { items: [] },
    canvas: { width: 512, height: 512 },
    prompt: 'canvas prompt',
    negative: 'negative',
    mask: { prompt: '', denoise: 0.85, regions: [] },
    runs: [],
  }
  const store = {
    load: async () => doc,
    readAsset: async () => null,
    saveAsset: async () => {},
    addRun: async (_sessionId, run) => { doc.runs.unshift(run) },
    updateRun: async (_sessionId, id, patch) => {
      const run = doc.runs.find((entry) => entry.id === id)
      if (run !== undefined) Object.assign(run, patch)
      return { runs: doc.runs }
    },
    applySeedAdvances: async (_sessionId, updates) => { applySeedValues(doc.workflow.json, updates) },
  }
  const comfy = {
    objectInfo: async () => info,
    uploadImage: async (_buffer, name) => ({ name }),
    queuePrompt: async (prompt) => {
      queueCalls.push(prompt)
      return { prompt_id: `pid-${queueCalls.length}` }
    },
    history: async (promptId) => ({
      [promptId]: {
        status: { status_str: 'success', messages: [] },
        outputs: { 8: { images: [{ filename: `${promptId}.png`, subfolder: '', type: 'output' }] } },
      },
    }),
    queue: async () => ({ queue_running: [], queue_pending: [] }),
    view: async () => ({ buffer: opaquePng(), contentType: 'image/png' }),
    interrupt: async () => {},
  }
  const manager = new RunManager({
    ctx: { logger: { warn() {} } },
    store,
    comfy,
    config: normalizeConfig({}),
    activate: async () => {},
    pollIntervalMs: 5,
  })
  return { manager, doc, queueCalls }
}

async function settle(runs, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const run = runs[0]
    if (run !== undefined && ['completed', 'failed', 'cancelled'].includes(run.status)) return run
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return runs[0]
}

const seedOf = (workflow) => workflow.nodes.find((node) => node.id === 6).widgets_values[0]
const namedSeedOf = (workflow) => workflow.nodes.find((node) => node.id === 6).widgets_values_named.seed

test('an increment seed run uses the stored value, then advances it', async () => {
  const { manager, doc, queueCalls } = await makeManager()
  try {
    await manager.start('session-seed', {}, {})
    const run = await settle(doc.runs)
    assert.equal(queueCalls[0]['6'].inputs.seed, 123)
    assert.equal(run.seed, 123)
    assert.equal(run.seedControl, 'increment')
    assert.equal(seedOf(doc.workflow.json), 124)
    assert.equal(namedSeedOf(doc.workflow.json), 124)
    // The control token is untouched, so the next run increments again.
    assert.equal(doc.workflow.json.nodes.find((node) => node.id === 6).widgets_values[1], 'increment')
  } finally {
    manager.dispose()
  }
})

test('a fixed seed stays fixed across runs', async () => {
  const { manager, doc } = await makeManager({ seedControl: 'fixed' })
  try {
    await manager.start('session-seed', {}, {})
    await settle(doc.runs)
    assert.equal(seedOf(doc.workflow.json), 123)
    assert.equal(namedSeedOf(doc.workflow.json), 123)
    assert.equal(doc.runs[0].seedControl, 'fixed')
  } finally {
    manager.dispose()
  }
})

test('randomize draws a new seed from ComfyUI\u2019s range after the queued one', async () => {
  const random = mock.method(Math, 'random', () => 0.5)
  const { manager, doc, queueCalls } = await makeManager({ seedControl: 'randomize' })
  try {
    await manager.start('session-seed', {}, {})
    await settle(doc.runs)
    assert.equal(queueCalls[0]['6'].inputs.seed, 123)
    assert.equal(seedOf(doc.workflow.json), SEED_MAX / 2)
    assert.equal(namedSeedOf(doc.workflow.json), SEED_MAX / 2)
    assert.equal(doc.runs[0].seedControl, 'randomize')
  } finally {
    manager.dispose()
    random.mock.restore()
  }
})

test('an explicit seed pins this run without changing the workflow sequence', async () => {
  const { manager, doc, queueCalls } = await makeManager()
  try {
    await manager.start('session-seed', { seed: 7 }, { agent: true })
    const run = await settle(doc.runs)
    assert.equal(queueCalls[0]['6'].inputs.seed, 7)
    assert.equal(run.seed, 7)
    assert.equal(seedOf(doc.workflow.json), 124)
  } finally {
    manager.dispose()
  }
})

test('every seed widget advances, not only the bound one', async () => {
  const extra = [{
    id: 30,
    type: 'SamplerCustom',
    mode: 0,
    inputs: [widget('noise_seed')],
    outputs: [],
    widgets_values: [7, 'increment'],
    widgets_values_named: { noise_seed: 7 },
  }]
  const { manager, doc } = await makeManager({ extraNodes: extra })
  try {
    await manager.start('session-seed', {}, {})
    await settle(doc.runs)
    assert.equal(seedOf(doc.workflow.json), 124)
    const node = doc.workflow.json.nodes.find((entry) => entry.id === 30)
    assert.equal(node.widgets_values[0], 8)
    assert.equal(node.widgets_values_named.noise_seed, 8)
    assert.equal(node.widgets_values[1], 'increment')
  } finally {
    manager.dispose()
  }
})

test('an API-format workflow has no widgets to advance, but keeps the seed override', async () => {
  const api = {
    6: { class_type: 'KSampler', inputs: { seed: 123, steps: 20, cfg: 6, sampler_name: 'euler', scheduler: 'normal', denoise: 1 } },
  }
  const { manager, doc, queueCalls } = await makeManager({ json: null, api })
  try {
    await manager.start('session-seed', { seed: 9 }, { agent: true })
    const run = await settle(doc.runs)
    assert.equal(queueCalls[0]['6'].inputs.seed, 9)
    assert.equal(run.seed, 9)
    assert.equal(doc.workflow.json, null)
  } finally {
    manager.dispose()
  }
})
