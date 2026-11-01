import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { RunManager } from '../lib/run.js'
import { normalizeConfig } from '../lib/config.js'
import { decodePng } from '../lib/png.js'

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
function inpaintWorkflow() {
  const widget = (name) => ({ name, type: 'STRING', widget: { name }, link: null })
  return {
    nodes: [
      { id: 1, type: 'CheckpointLoaderSimple', pos: [0, 0], mode: 0, inputs: [], widgets_values: ['model.safetensors'], widgets_values_named: { ckpt_name: 'model.safetensors' } },
      { id: 2, type: 'LoadImage', pos: [0, 200], mode: 0, inputs: [{ name: 'image', type: 'COMBO', widget: { name: 'image' }, link: null }], widgets_values: ['a.png'], widgets_values_named: { image: 'a.png' } },
      { id: 9, type: 'LoadImageMask', pos: [0, 400], mode: 0, inputs: [{ name: 'image', type: 'COMBO', widget: { name: 'image' }, link: null }, { name: 'channel', type: 'COMBO', widget: { name: 'channel' }, link: null }], widgets_values: ['mask.png', 'alpha'], widgets_values_named: { image: 'mask.png', channel: 'alpha' } },
      { id: 3, type: 'VAEEncode', pos: [300, 200], mode: 0, inputs: [{ name: 'pixels', type: 'IMAGE', link: 1 }, { name: 'vae', type: 'VAE', link: 2 }], widgets_values: [] },
      { id: 10, type: 'SetLatentNoiseMask', pos: [500, 200], mode: 0, inputs: [{ name: 'samples', type: 'LATENT', link: 3 }, { name: 'mask', type: 'MASK', link: 4 }], widgets_values: [] },
      { id: 4, type: 'CLIPTextEncode', pos: [300, 0], mode: 0, inputs: [{ name: 'clip', type: 'CLIP', link: 5 }, widget('text')], widgets_values: ['canvas prompt'], widgets_values_named: { text: 'canvas prompt' } },
      { id: 5, type: 'CLIPTextEncode', pos: [300, 100], mode: 0, inputs: [{ name: 'clip', type: 'CLIP', link: 6 }, widget('text')], widgets_values: ['negative'], widgets_values_named: { text: 'negative' } },
      { id: 6, type: 'KSampler', pos: [700, 200], mode: 0, inputs: [
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
      { id: 7, type: 'VAEDecode', pos: [1000, 200], mode: 0, inputs: [{ name: 'samples', type: 'LATENT', link: 11 }, { name: 'vae', type: 'VAE', link: 12 }], widgets_values: [] },
      { id: 8, type: 'SaveImage', pos: [1200, 200], mode: 0, inputs: [{ name: 'images', type: 'IMAGE', link: 13 }], widgets_values: ['out'], widgets_values_named: { filename_prefix: 'out' } },
    ],
    links: [
      [1, 2, 0, 3, 0, 'IMAGE'],
      [2, 1, 2, 3, 1, 'VAE'],
      [3, 3, 0, 10, 0, 'LATENT'],
      [4, 9, 0, 10, 1, 'MASK'],
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
}

async function makeRunManager(overrides = {}) {
  const [canvas, mask] = await Promise.all([
    fs.readFile(new URL('./fixtures/edit-canvas.png', import.meta.url)),
    fs.readFile(new URL('./fixtures/edit-mask.png', import.meta.url)),
  ])
  const uploads = []
  const queued = { prompt: null }
  const runs = []
  const doc = {
    workflow: { name: 'inpaint.json', json: inpaintWorkflow(), bindings: {} },
    layout: { items: [] },
    canvas: { width: 1024, height: 1024 },
    prompt: 'canvas prompt',
    negative: 'negative',
    mask: { prompt: 'local repaint prompt' },
    runs: [],
    ...overrides,
  }
  const store = {
    load: async () => doc,
    readAsset: async (_sessionId, name) => (name === 'canvas.png' ? canvas : name === 'mask.png' ? mask : null),
    addRun: async (_sessionId, run) => { runs.push(run) },
    updateRun: async (_sessionId, id, patch) => ({ ...runs[0], ...patch }),
  }
  const comfy = {
    objectInfo: async () => info,
    uploadImage: async (buffer, name) => { uploads.push({ buffer, name }); return { name } },
    queuePrompt: async (prompt) => { queued.prompt = prompt; return { prompt_id: 'pid' } },
    history: async () => ({}),
    queue: async () => ({ queue_running: [], queue_pending: [] }),
  }
  const ctx = { logger: { warn() {} } }
  const manager = new RunManager({ ctx, store, comfy, config: normalizeConfig({}), activate: async () => {} })
  return { manager, doc, uploads, queued, runs }
}

test('a painted mask sends the mask prompt as the positive text', async () => {
  const { manager, queued, runs, uploads } = await makeRunManager()
  try {
    await manager.start('session-run', {}, { agent: true })
    assert.equal(queued.prompt['4'].inputs.text, 'local repaint prompt')
    assert.equal(runs[0].promptKind, 'mask')
    // The mask upload is the cutout (painted = transparent), not mask.png.
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

test('without a mask prompt the canvas prompt drives the run', async () => {
  const { manager, queued, runs } = await makeRunManager({ mask: { prompt: '' } })
  try {
    await manager.start('session-run', {}, { agent: true })
    assert.equal(queued.prompt['4'].inputs.text, 'canvas prompt')
    assert.equal(runs[0].promptKind, 'canvas')
  } finally {
    manager.dispose()
  }
})
