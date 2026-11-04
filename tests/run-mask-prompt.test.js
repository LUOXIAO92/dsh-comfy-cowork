import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { RunManager } from '../lib/run.js'
import { normalizeConfig } from '../lib/config.js'
import { decodePng, encodePng } from '../lib/png.js'

const info = {
  CheckpointLoaderSimple: {
    input: { required: { ckpt_name: ['COMBO', { options: ['model.safetensors'] }] } },
    input_order: { required: ['ckpt_name'] },
    output: ['MODEL', 'CLIP', 'VAE'],
  },
  LoadImage: {
    input: { required: { image: ['COMBO', { options: ['a.png'] }] } },
    input_order: { required: ['image'] },
    output: ['IMAGE', 'MASK'],
  },
  LoadImageMask: {
    input: { required: { image: ['COMBO', { options: ['mask.png'] }], channel: ['COMBO', { options: ['alpha'] }] } },
    input_order: { required: ['image', 'channel'] },
    output: ['MASK'],
  },
  CLIPTextEncode: {
    input: { required: { clip: ['CLIP'], text: ['STRING', { multiline: true }] } },
    input_order: { required: ['clip', 'text'] },
    output: ['CONDITIONING'],
  },
  VAEEncode: {
    input: { required: { pixels: ['IMAGE'], vae: ['VAE'] } },
    input_order: { required: ['pixels', 'vae'] },
    output: ['LATENT'],
  },
  SetLatentNoiseMask: {
    input: { required: { samples: ['LATENT'], mask: ['MASK'] } },
    input_order: { required: ['samples', 'mask'] },
    output: ['LATENT'],
  },
  KSampler: {
    input: { required: { model: ['MODEL'], positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'], seed: ['INT', { default: 0 }], steps: ['INT', { default: 20 }], cfg: ['FLOAT', { default: 7 }], sampler_name: ['COMBO', { options: ['euler'] }], scheduler: ['COMBO', { options: ['normal'] }], denoise: ['FLOAT', { default: 1 }] } },
    input_order: { required: ['model', 'positive', 'negative', 'latent_image', 'seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'] },
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

/** A minimal inpaint graph: LoadImage → VAEEncode → SetLatentNoiseMask → KSampler → VAEDecode → SaveImage. */
function inpaintWorkflow(maskNode = 9) {
  const widget = (name) => ({ name, type: 'STRING', widget: { name }, link: null })
  const payload = {
    nodes: [
      { id: 1, type: 'CheckpointLoaderSimple', pos: [0, 0], mode: 0, inputs: [], outputs: [{ name: 'MODEL', type: 'MODEL' }, { name: 'CLIP', type: 'CLIP' }, { name: 'VAE', type: 'VAE' }], widgets_values: ['model.safetensors'], widgets_values_named: { ckpt_name: 'model.safetensors' } },
      { id: 2, type: 'LoadImage', pos: [0, 200], mode: 0, inputs: [{ name: 'image', type: 'COMBO', widget: { name: 'image' }, link: null }], outputs: [{ name: 'IMAGE', type: 'IMAGE' }, { name: 'MASK', type: 'MASK' }], widgets_values: ['a.png'], widgets_values_named: { image: 'a.png' } },
      { id: 9, type: 'LoadImageMask', pos: [0, 400], mode: 0, inputs: [{ name: 'image', type: 'COMBO', widget: { name: 'image' }, link: null }, { name: 'channel', type: 'COMBO', widget: { name: 'channel' }, link: null }], outputs: [{ name: 'MASK', type: 'MASK' }], widgets_values: ['mask.png', 'alpha'], widgets_values_named: { image: 'mask.png', channel: 'alpha' } },
      { id: 3, type: 'VAEEncode', pos: [300, 200], mode: 0, inputs: [{ name: 'pixels', type: 'IMAGE', link: 1 }, { name: 'vae', type: 'VAE', link: 2 }], outputs: [{ name: 'LATENT', type: 'LATENT' }], widgets_values: [] },
      { id: 10, type: 'SetLatentNoiseMask', pos: [500, 200], mode: 0, inputs: [{ name: 'samples', type: 'LATENT', link: 3 }, { name: 'mask', type: 'MASK', link: 4 }], outputs: [{ name: 'LATENT', type: 'LATENT' }], widgets_values: [] },
      { id: 4, type: 'CLIPTextEncode', pos: [300, 0], mode: 0, inputs: [{ name: 'clip', type: 'CLIP', link: 5 }, widget('text')], outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING' }], widgets_values: ['canvas prompt'], widgets_values_named: { text: 'canvas prompt' } },
      { id: 5, type: 'CLIPTextEncode', pos: [300, 100], mode: 0, inputs: [{ name: 'clip', type: 'CLIP', link: 6 }, widget('text')], outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING' }], widgets_values: ['negative'], widgets_values_named: { text: 'negative' } },
      { id: 6, type: 'KSampler', pos: [700, 200], mode: 0, outputs: [{ name: 'LATENT', type: 'LATENT' }], inputs: [
        { name: 'model', type: 'MODEL', link: 7 },
        { name: 'positive', type: 'CONDITIONING', link: 8 },
        { name: 'negative', type: 'CONDITIONING', link: 9 },
        { name: 'latent_image', type: 'LATENT', link: 10 },
        { name: 'seed', type: 'INT', widget: { name: 'seed' }, link: null },
        { name: 'steps', type: 'INT', widget: { name: 'steps' }, link: null },
        { name: 'cfg', type: 'FLOAT', widget: { name: 'cfg' }, link: null },
        { name: 'sampler_name', type: 'COMBO', widget: { name: 'sampler_name' }, link: null },
        { name: 'scheduler', type: 'COMBO', widget: { name: 'scheduler' }, link: null },
        { name: 'denoise', type: 'FLOAT', widget: { name: 'denoise' }, link: null },
      ], widgets_values: [42, 'fixed', 20, 7, 'euler', 'normal', 1], widgets_values_named: { seed: 42, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1 } },
      { id: 7, type: 'VAEDecode', pos: [1000, 200], mode: 0, inputs: [{ name: 'samples', type: 'LATENT', link: 11 }, { name: 'vae', type: 'VAE', link: 12 }], outputs: [{ name: 'IMAGE', type: 'IMAGE' }], widgets_values: [] },
      { id: 8, type: 'SaveImage', pos: [1200, 200], mode: 0, inputs: [{ name: 'images', type: 'IMAGE', link: 13 }], outputs: [], widgets_values: ['out'], widgets_values_named: { filename_prefix: 'out' } },
    ],
    links: [
      [1, 2, 0, 3, 0, 'IMAGE'],
      [2, 1, 2, 3, 1, 'VAE'],
      [3, 3, 0, 10, 0, 'LATENT'],
      [4, maskNode, 0, 10, 1, 'MASK'],
      [5, 1, 1, 4, 0, 'CLIP'],
      [6, 1, 1, 5, 0, 'CLIP'],
      [7, 1, 0, 6, 0, 'MODEL'],
      [8, 4, 0, 6, 1, 'CONDITIONING'],
      [9, 5, 0, 6, 2, 'CONDITIONING'],
      [10, 10, 0, 6, 3, 'LATENT'],
      [11, 6, 0, 7, 0, 'LATENT'],
      [12, 1, 2, 7, 1, 'VAE'],
      [13, 7, 0, 8, 0, 'IMAGE'],
    ],
  }
  return payload
}

/** A region's canonical mask cutout: white where painted, alpha = 255 - painted. */
function regionCutout({ x1 = 100, y1 = 100, x2 = 300, y2 = 300 }, size = 1024) {
  const data = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const painted = x >= x1 && x < x2 && y >= y1 && y < y2 ? 255 : 0
      const at = (y * size + x) * 4
      data[at] = painted
      data[at + 1] = painted
      data[at + 2] = painted
      data[at + 3] = 255 - painted
    }
  }
  return encodePng(size, size, 4, data)
}

/** A small opaque PNG, standing in for a sampler's output between passes. */
function outputPng(size = 16) {
  const data = Buffer.alloc(size * size * 4, 255)
  return encodePng(size, size, 4, data)
}

function region(id, prompt, bbox = [100, 100, 300, 300], promptSource = 'user') {
  return { id, prompt, promptSource, bbox, createdAt: 1 }
}

async function makeRunManager(overrides = {}) {
  const [canvas, mask] = await Promise.all([
    fs.readFile(new URL('./fixtures/edit-canvas.png', import.meta.url)),
    fs.readFile(new URL('./fixtures/edit-mask.png', import.meta.url)),
  ])
  const uploads = []
  const queueCalls = []
  const runs = []
  const saved = new Map()
  const regionAssets = new Map(overrides.regionAssets ?? [])
  const viewBuffers = new Map(overrides.viewBuffers ?? [])
  const interrupted = []
  // Every pass succeeds by default with one image output named after the pass.
  const historyFor = overrides.historyFor ?? ((promptId) => ({
    status: { status_str: 'success', messages: [] },
    outputs: { 8: { images: [{ filename: `${promptId}.png`, subfolder: '', type: 'output' }] } },
  }))
  const doc = {
    workflow: {
      name: 'inpaint.json',
      json: inpaintWorkflow(overrides.workflowBindings?.mask === '2' ? 2 : 9),
      bindings: overrides.workflowBindings ?? {},
    },
    layout: { items: [] },
    canvas: { width: 1024, height: 1024 },
    prompt: 'canvas prompt',
    negative: 'negative',
    mask: { prompt: 'local repaint prompt', denoise: 0.85, regions: [] },
    runs: [],
    ...overrides,
  }
  if (overrides.mask !== undefined) doc.mask = { prompt: 'local repaint prompt', denoise: 0.85, regions: [], ...overrides.mask }
  doc.runs = runs
  const store = {
    load: async () => doc,
    readAsset: async (_sessionId, name) => {
      if (name === 'canvas.png') return canvas
      if (name === 'mask.png') return overrides.dropMask === true ? null : mask
      if (name === 'canvas_rgba.png') return null
      if (regionAssets.has(name)) return regionAssets.get(name)
      return saved.get(name) ?? null
    },
    saveAsset: async (_sessionId, name, data) => { saved.set(name, data) },
    addRun: async (_sessionId, run) => { runs.unshift(run) },
    updateRun: async (_sessionId, id, patch) => {
      const run = runs.find((entry) => entry.id === id)
      if (run !== undefined) Object.assign(run, patch)
      return { runs }
    },
  }
  const comfy = {
    objectInfo: async () => info,
    uploadImage: async (buffer, name) => { uploads.push({ buffer, name }); return { name } },
    queuePrompt: async (prompt) => {
      queueCalls.push(prompt)
      return { prompt_id: `pid-${queueCalls.length}` }
    },
    history: async (promptId) => ({ [promptId]: historyFor(promptId) }),
    queue: async () => ({ queue_running: [], queue_pending: [] }),
    view: async (file) => ({ buffer: viewBuffers.get(file.filename) ?? outputPng(), contentType: 'image/png' }),
    interrupt: async (promptId) => { interrupted.push(promptId) },
  }
  const ctx = { logger: { warn() {} } }
  const manager = new RunManager({
    ctx,
    store,
    comfy,
    config: normalizeConfig({}),
    activate: async () => {},
    pollIntervalMs: 5,
  })
  return { manager, doc, uploads, queueCalls, runs, interrupted, saved }
}

/** Wait for the run — and any chained passes — to settle. */
async function settle(runs, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const run = runs[0]
    if (run !== undefined && ['completed', 'failed', 'cancelled'].includes(run.status)) return run
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return runs[0]
}

test('a painted mask with no regions runs one implicit pass with the legacy prompt', async () => {
  const { manager, queueCalls, runs, uploads } = await makeRunManager()
  try {
    await manager.start('session-run', {}, { agent: true })
    const run = await settle(runs)
    assert.equal(run.status, 'completed')
    assert.equal(run.passCount, 1)
    assert.equal(run.passIndex, 1)
    assert.equal(run.passes.length, 1)
    assert.equal(run.passes[0].regionId, null)
    assert.equal(run.promptKind, 'mask')
    assert.equal(queueCalls[0]['4'].inputs.text, 'local repaint prompt')
    // The uploaded mask is the cutout (painted = transparent), not mask.png.
    const uploaded = uploads.find((entry) => entry.name.endsWith('-mask.png'))
    const decoded = decodePng(uploaded.buffer)
    assert.equal(decoded.channels, 4)
    let transparent = 0
    for (let index = 3; index < decoded.data.length; index += 4) if (decoded.data[index] === 0) transparent += 1
    assert.ok(transparent > 0, 'the painted region is transparent in the uploaded mask')
  } finally {
    manager.dispose()
  }
})

test('an empty legacy mask prompt is an empty local repaint, not the canvas prompt', async () => {
  const { manager, queueCalls, runs } = await makeRunManager({ mask: { prompt: '' } })
  try {
    await manager.start('session-run', {}, { agent: true })
    const run = await settle(runs)
    assert.equal(queueCalls[0]['4'].inputs.text, '')
    assert.equal(run.passes[0].promptKind, 'empty')
    assert.equal(run.promptKind, 'empty')
  } finally {
    manager.dispose()
  }
})

test('each mask region is its own pass and the image chains through them', async () => {
  const regions = [region('mr-a', 'white feather wing'), region('mr-b', 'black leather glove', [400, 400, 600, 600])]
  const regionAssets = [
    ['mask-mr-a.png', regionCutout({ x1: 100, y1: 100, x2: 300, y2: 300 })],
    ['mask-mr-b.png', regionCutout({ x1: 400, y1: 400, x2: 600, y2: 600 })],
  ]
  const { manager, queueCalls, runs, uploads, saved } = await makeRunManager({ mask: { regions }, regionAssets })
  try {
    await manager.start('session-run', {}, { agent: true })
    // The first pass is queued before start() returns.
    assert.equal(queueCalls.length, 1)
    const run = await settle(runs)
    assert.equal(run.status, 'completed')
    assert.equal(run.passCount, 2)
    assert.equal(run.passIndex, 2)
    assert.equal(run.promptId, 'pid-1')
    assert.deepEqual(run.passes.map((pass) => pass.status), ['completed', 'completed'])
    assert.deepEqual(run.passes.map((pass) => pass.regionId), ['mr-a', 'mr-b'])
    assert.deepEqual(run.passes.map((pass) => pass.prompt), ['white feather wing', 'black leather glove'])
    assert.deepEqual(run.passes.map((pass) => pass.promptKind), ['mask', 'mask'])
    // Each pass sends its own prompt.
    assert.equal(queueCalls.length, 2)
    assert.equal(queueCalls[0]['4'].inputs.text, 'white feather wing')
    assert.equal(queueCalls[1]['4'].inputs.text, 'black leather glove')
    // Each pass uploads its own region mask.
    const masks = uploads.filter((entry) => entry.name.endsWith('-mask.png')).map((entry) => entry.name)
    assert.deepEqual(masks, [`${run.id}-p1-mask.png`, `${run.id}-p2-mask.png`])
    // The second pass's image is the first pass's downloaded output.
    const chained = uploads.find((entry) => entry.name === `${run.id}-p2-canvas.png`)
    assert.ok(chained)
    assert.deepEqual(chained.buffer, saved.get(run.passes[0].outputs[0].asset))
    // The final pass's outputs are the run's outputs; intermediate passes keep
    // their downloads on their own pass entry.
    assert.equal(run.outputs.length, 1)
    assert.match(run.outputs[0].asset, /-p2-0-pid-2\.png$/)
    assert.match(run.passes[0].outputs[0].asset, /-p1-0-pid-1\.png$/)
  } finally {
    manager.dispose()
  }
})

test('a failing pass stops the chain and cancels the passes it never reached', async () => {
  const regions = [region('mr-a', 'one'), region('mr-b', 'two', [400, 400, 600, 600]), region('mr-c', 'three', [700, 700, 900, 900])]
  const regionAssets = [
    ['mask-mr-a.png', regionCutout({ x1: 100, y1: 100, x2: 300, y2: 300 })],
    ['mask-mr-b.png', regionCutout({ x1: 400, y1: 400, x2: 600, y2: 600 })],
    ['mask-mr-c.png', regionCutout({ x1: 700, y1: 700, x2: 900, y2: 900 })],
  ]
  let calls = 0
  const historyFor = (promptId) => {
    calls += 1
    if (promptId === 'pid-2') {
      return { status: { status_str: 'error', messages: [['execution_error', { node_id: '6', exception_message: 'sampler exploded' }]] }, outputs: {} }
    }
    return { status: { status_str: 'success', messages: [] }, outputs: { 8: { images: [{ filename: `${promptId}.png`, subfolder: '', type: 'output' }] } } }
  }
  const { manager, queueCalls, runs } = await makeRunManager({ mask: { regions }, regionAssets, historyFor })
  try {
    await manager.start('session-run', {}, { agent: true })
    const run = await settle(runs)
    assert.equal(run.status, 'failed')
    assert.match(run.error, /sampler exploded/)
    assert.equal(queueCalls.length, 2)
    assert.deepEqual(run.passes.map((pass) => pass.status), ['completed', 'failed', 'cancelled'])
    assert.match(run.passes[1].error, /sampler exploded/)
    assert.ok(calls >= 2)
  } finally {
    manager.dispose()
  }
})

test('a region without its mask asset fails before anything is queued', async () => {
  const regions = [region('mr-a', 'one'), region('mr-missing', 'two', [400, 400, 600, 600])]
  const regionAssets = [['mask-mr-a.png', regionCutout({ x1: 100, y1: 100, x2: 300, y2: 300 })]]
  const { manager, queueCalls } = await makeRunManager({ mask: { regions }, regionAssets })
  try {
    await assert.rejects(
      () => manager.start('session-run', {}, { agent: true }),
      (error) => error.status === 409 && /mr-missing/.test(error.message),
    )
    assert.equal(queueCalls.length, 0)
  } finally {
    manager.dispose()
  }
})

test('the mask strength applies to every pass and a run override wins', async () => {
  const regions = [region('mr-a', 'one'), region('mr-b', 'two', [400, 400, 600, 600])]
  const regionAssets = [
    ['mask-mr-a.png', regionCutout({ x1: 100, y1: 100, x2: 300, y2: 300 })],
    ['mask-mr-b.png', regionCutout({ x1: 400, y1: 400, x2: 600, y2: 600 })],
  ]
  const { manager, queueCalls, runs } = await makeRunManager({ mask: { denoise: 0.6, regions }, regionAssets })
  const override = await makeRunManager({ mask: { denoise: 0.6, regions }, regionAssets })
  try {
    await manager.start('session-run', {}, { agent: true })
    const run = await settle(runs)
    assert.deepEqual(queueCalls.map((prompt) => prompt['6'].inputs.denoise), [0.6, 0.6])
    assert.deepEqual(run.passes.map((pass) => pass.denoise), [0.6, 0.6])
    assert.equal(run.maskDenoise, 0.6)
    await override.manager.start('session-run', { denoise: 0.25 }, { agent: true })
    await settle(override.runs)
    assert.deepEqual(override.queueCalls.map((prompt) => prompt['6'].inputs.denoise), [0.25, 0.25])
  } finally {
    manager.dispose()
    override.manager.dispose()
  }
})

test('a region prompt keeps the raw text and an empty one is sent as an empty string', async () => {
  const regions = [region('mr-a', '  padded prompt  '), region('mr-b', '', [400, 400, 600, 600])]
  const regionAssets = [
    ['mask-mr-a.png', regionCutout({ x1: 100, y1: 100, x2: 300, y2: 300 })],
    ['mask-mr-b.png', regionCutout({ x1: 400, y1: 400, x2: 600, y2: 600 })],
  ]
  const { manager, queueCalls, runs } = await makeRunManager({ mask: { regions }, regionAssets })
  try {
    await manager.start('session-run', {}, { agent: true })
    const run = await settle(runs)
    assert.equal(queueCalls[0]['4'].inputs.text, '  padded prompt  ')
    assert.equal(queueCalls[1]['4'].inputs.text, '')
    assert.deepEqual(run.passes.map((pass) => pass.promptKind), ['mask', 'empty'])
  } finally {
    manager.dispose()
  }
})

test('a full-image run keeps the workflow denoise and runs one canvas pass', async () => {
  // A generation graph: no mask binding, no painted mask.
  const { manager, queueCalls, runs } = await makeRunManager({ dropMask: true, workflowBindings: { mask: '' } })
  try {
    await manager.start('session-run', {}, { agent: true })
    const run = await settle(runs)
    assert.equal(queueCalls[0]['6'].inputs.denoise, 1)
    assert.equal(run.maskDenoise, null)
    assert.equal(run.promptKind, 'canvas')
    assert.equal(run.passCount, 1)
    assert.equal(run.passes[0].promptKind, 'canvas')
    assert.equal(run.passes[0].denoise, null)
  } finally {
    manager.dispose()
  }
})

test('the same-node legacy shape composes each region into the image alpha', async () => {
  const regions = [region('mr-a', 'wing', [100, 100, 300, 300])]
  const regionAssets = [['mask-mr-a.png', regionCutout({ x1: 100, y1: 100, x2: 300, y2: 300 })]]
  const { manager, uploads, runs } = await makeRunManager({ mask: { regions }, regionAssets, workflowBindings: { mask: '2' } })
  try {
    await manager.start('session-run', {}, { agent: true })
    await settle(runs)
    const composed = uploads.find((entry) => entry.name.endsWith('-rgba.png'))
    assert.ok(composed, 'an RGBA image carries the region mask')
    const decoded = decodePng(composed.buffer)
    assert.equal(decoded.channels, 4)
    // Painted region: transparent (LoadImage reads MASK = 1 - alpha); outside: opaque.
    const alphaAt = (x, y) => decoded.data[(y * decoded.width + x) * 4 + 3]
    assert.equal(alphaAt(200, 200), 0)
    assert.equal(alphaAt(50, 50), 255)
  } finally {
    manager.dispose()
  }
})

test('interrupt cancels the running pass and leaves the rest unqueued', async () => {
  const regions = [region('mr-a', 'one'), region('mr-b', 'two', [400, 400, 600, 600])]
  const regionAssets = [
    ['mask-mr-a.png', regionCutout({ x1: 100, y1: 100, x2: 300, y2: 300 })],
    ['mask-mr-b.png', regionCutout({ x1: 400, y1: 400, x2: 600, y2: 600 })],
  ]
  // Nothing ever settles: the run waits on its first pass.
  const { manager, queueCalls, runs, interrupted } = await makeRunManager({
    mask: { regions },
    regionAssets,
    historyFor: () => undefined,
  })
  try {
    const { run } = await manager.start('session-run', {}, { agent: true })
    const stopped = await manager.interrupt('session-run', run.id)
    assert.equal(stopped.status, 'cancelled')
    assert.deepEqual(interrupted, ['pid-1'])
    assert.deepEqual(stopped.passes.map((pass) => pass.status), ['cancelled', 'cancelled'])
    assert.equal(queueCalls.length, 1)
    assert.equal(manager.pollers.size, 0)
  } finally {
    manager.dispose()
  }
})
