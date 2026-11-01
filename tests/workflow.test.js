import test from 'node:test'
import assert from 'node:assert/strict'
import { workflowToPrompt, inferBindings, applyBindings } from '../lib/workflow.js'

const info = {
  LoadImage: {
    input: { required: { image: ['COMBO', { options: ['a.png'] }] } },
    input_order: { required: ['image'] },
    output: ['IMAGE', 'MASK'],
  },
  CLIPTextEncode: {
    input: { required: { clip: ['CLIP'], text: ['STRING', { multiline: true }] } },
    input_order: { required: ['clip', 'text'] },
    output: ['CONDITIONING'],
  },
  KSampler: {
    input: { required: { model: ['MODEL'], positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'], seed: ['INT', { default: 0 }], steps: ['INT', { default: 20 }], cfg: ['FLOAT', { default: 7 }], sampler_name: ['COMBO', { options: ['euler'] }], scheduler: ['COMBO', { options: ['normal'] }], denoise: ['FLOAT', { default: 1 }] } },
    input_order: { required: ['model', 'positive', 'negative', 'latent_image', 'seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'] },
    output: ['LATENT'],
  },
  EmptyLatentImage: {
    input: { required: { width: ['INT', { default: 512 }], height: ['INT', { default: 512 }], batch_size: ['INT', { default: 1 }] } },
    input_order: { required: ['width', 'height', 'batch_size'] },
    output: ['LATENT'],
  },
  MOSSImageLayoutPrompt: {
    input: { required: { prompt: ['STRING', { multiline: true }], element: ['ARRAY'], width: ['INT', { default: 1024 }], height: ['INT', { default: 1024 }], character_boxes: ['STRING', { default: '' }] } },
    input_order: { required: ['prompt', 'element', 'width', 'height', 'character_boxes'] },
    output: ['STRING'],
  },
  CreateBoundingBoxes: {
    input: { required: { width: ['INT', { default: 1024 }], height: ['INT', { default: 1024 }] }, optional: { bboxes: [['BOUNDING_BOX', 'ARRAY', 'STRING'], { default: null }] } },
    input_order: { required: ['width', 'height'], optional: ['bboxes'] },
    output: ['IMAGE', 'BOUNDING_BOX', 'ARRAY'],
  },
}

function baseWorkflow() {
  return {
    nodes: [
      { id: 1, type: 'LoadImage', pos: [0, 0], size: [200, 100], mode: 0, inputs: [{ name: 'image', type: 'COMBO', widget: { name: 'image' }, link: null }], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [1] }, { name: 'MASK', type: 'MASK', links: [] }], widgets_values: ['a.png'], widgets_values_named: { image: 'a.png' } },
      { id: 2, type: 'CLIPTextEncode', pos: [300, 0], size: [200, 100], mode: 0, inputs: [{ name: 'clip', type: 'CLIP', link: null }, { name: 'text', type: 'STRING', widget: { name: 'text' }, link: null }], widgets_values: ['hello'], widgets_values_named: { text: 'hello' } },
      { id: 3, type: 'EmptyLatentImage', pos: [300, 200], size: [200, 100], mode: 0, inputs: [{ name: 'width', type: 'INT', widget: { name: 'width' }, link: null }, { name: 'height', type: 'INT', widget: { name: 'height' }, link: null }, { name: 'batch_size', type: 'INT', widget: { name: 'batch_size' }, link: null }], widgets_values: [512, 512, 1], widgets_values_named: { width: 512, height: 512, batch_size: 1 } },
      { id: 4, type: 'KSampler', pos: [600, 0], size: [240, 200], mode: 0, inputs: [
        { name: 'model', type: 'MODEL', link: null },
        { name: 'positive', type: 'CONDITIONING', link: 2 },
        { name: 'negative', type: 'CONDITIONING', link: null },
        { name: 'latent_image', type: 'LATENT', link: 3 },
        { name: 'seed', type: 'INT', widget: { name: 'seed' }, link: null },
        { name: 'steps', type: 'INT', widget: { name: 'steps' }, link: null },
        { name: 'cfg', type: 'FLOAT', widget: { name: 'cfg' }, link: null },
        { name: 'sampler_name', type: 'COMBO', widget: { name: 'sampler_name' }, link: null },
        { name: 'scheduler', type: 'COMBO', widget: { name: 'scheduler' }, link: null },
        { name: 'denoise', type: 'FLOAT', widget: { name: 'denoise' }, link: null },
      ], widgets_values: [42, 'randomize', 20, 7, 'euler', 'normal', 1], widgets_values_named: { seed: 42, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1 } },
      { id: 5, type: 'Reroute', pos: [500, 100], inputs: [{ name: '', type: '*', link: null }], mode: 0 },
    ],
    links: [[1, 1, 0, 2, 0, 'IMAGE'], [2, 2, 0, 4, 1, 'CONDITIONING'], [3, 3, 0, 4, 3, 'LATENT']],
  }
}

test('converts UI workflow to API prompt and skips control_after_generate', () => {
  const { prompt, warnings } = workflowToPrompt(baseWorkflow(), info)
  assert.deepEqual(warnings, [])
  assert.equal(prompt['1'].class_type, 'LoadImage')
  assert.deepEqual(prompt['1'].inputs, { image: 'a.png' })
  assert.equal(prompt['2'].inputs.text, 'hello')
  assert.equal(prompt['4'].inputs.seed, 42)
  assert.equal(prompt['4'].inputs.steps, 20)
  assert.deepEqual(prompt['4'].inputs.positive, ['2', 0])
  assert.equal(prompt['3'].inputs.width, 512)
  assert.equal(prompt['5'], undefined)
})

test('resolves bypassed nodes by matching input/output types', () => {
  const wf = baseWorkflow()
  wf.nodes.push({ id: 6, type: 'LoraLoader', pos: [0, 0], mode: 4, inputs: [{ name: 'model', type: 'MODEL', link: 10 }, { name: 'clip', type: 'CLIP', link: null }], outputs: [{ name: 'MODEL', type: 'MODEL' }], widgets_values: [] })
  wf.nodes.push({ id: 7, type: 'KSampler', pos: [0, 0], mode: 0, inputs: [{ name: 'model', type: 'MODEL', link: 11 }, { name: 'positive', type: 'CONDITIONING', link: null }, { name: 'negative', type: 'CONDITIONING', link: null }, { name: 'latent_image', type: 'LATENT', link: null }], widgets_values: [1, 20, 7, 'euler', 'normal', 1] })
  wf.nodes.push({ id: 8, type: 'CheckpointLoaderSimple', pos: [0, 0], mode: 0, inputs: [], widgets_values: ['model.safetensors'], outputs: [{ type: 'MODEL' }] })
  wf.links.push([10, 8, 0, 6, 0, 'MODEL'], [11, 6, 0, 7, 0, 'MODEL'])
  const { prompt } = workflowToPrompt(wf, { ...info, LoraLoader: { input: { required: { model: ['MODEL'], clip: ['CLIP'], lora_name: ['COMBO', { options: ['x'] }], strength_model: ['FLOAT', { default: 1 }], strength_clip: ['FLOAT', { default: 1 }] } }, input_order: { required: ['model', 'clip', 'lora_name', 'strength_model', 'strength_clip'] }, output: ['MODEL', 'CLIP'] } })
  assert.equal(prompt['6'], undefined)
  assert.deepEqual(prompt['7'].inputs.model, ['8', 0])
})

test('infers bindings and injects prompt/image/size/seed', () => {
  const wf = baseWorkflow()
  const bindings = inferBindings(wf, info)
  assert.equal(bindings.prompt, '2')
  assert.equal(bindings.image, '1')
  assert.equal(bindings.width, '3')
  assert.equal(bindings.seed, '4')
  assert.equal(bindings.denoise, '4')
  const { prompt, notes } = applyBindings(workflowToPrompt(wf, info).prompt, bindings, {
    prompt: 'new prompt', imageName: 'uploaded.png', width: 768, height: 1024, seed: 7, denoise: 0.7,
  })
  assert.equal(prompt['2'].inputs.text, 'new prompt')
  assert.equal(prompt['1'].inputs.image, 'uploaded.png')
  assert.equal(prompt['3'].inputs.width, 768)
  assert.equal(prompt['3'].inputs.height, 1024)
  assert.equal(prompt['4'].inputs.seed, 7)
  assert.equal(prompt['4'].inputs.denoise, 0.7)
  assert.deepEqual(notes, [])
})

test('accepts API-format prompts unchanged', () => {
  const api = { '1': { class_type: 'CLIPTextEncode', inputs: { text: 'x', clip: ['2', 0] } } }
  const out = workflowToPrompt(api, info)
  assert.equal(out.api, true)
  assert.deepEqual(out.prompt, api)
})

test('rejects subgraphs with a clear message', () => {
  assert.throws(() => workflowToPrompt({ nodes: [], links: [], definitions: { subgraphs: [{}] } }, info), /subgraph/)
})

test('sends a list-typed BOUNDING_BOXES default as JSON text and skips empty optional widgets', () => {
  const wf = {
    nodes: [
      { id: 1, type: 'CreateBoundingBoxes', pos: [0, 0], mode: 0, inputs: [
        { name: 'width', type: 'INT', widget: { name: 'width' }, link: null },
        { name: 'height', type: 'INT', widget: { name: 'height' }, link: null },
        { name: 'editor_state', type: 'BOUNDING_BOXES', link: null },
        { name: 'bboxes', type: 'BOUNDING_BOX,ARRAY,STRING', link: null },
      ], widgets_values: [1024, 1024], widgets_values_named: { width: 1024, height: 1024 } },
      { id: 2, type: 'DiffusionModelLoaderKJ', pos: [0, 0], mode: 0, inputs: [
        { name: 'extra_state_dict', type: 'STRING', widget: { name: 'extra_state_dict' }, link: null },
        { name: 'model_name', type: 'COMBO', widget: { name: 'model_name' }, link: null },
      ], widgets_values: ['', 'x.safetensors'], widgets_values_named: { model_name: 'x.safetensors' } },
    ],
    links: [],
  }
  const localInfo = {
    CreateBoundingBoxes: { input: { required: { width: ['INT', { default: 1024 }], height: ['INT', { default: 1024 }], editor_state: ['BOUNDING_BOXES', { default: [] }] }, optional: { bboxes: [['BOUNDING_BOX', 'ARRAY', 'STRING'], {}] } }, input_order: { required: ['width', 'height', 'editor_state'], optional: ['bboxes'] } },
    DiffusionModelLoaderKJ: { input: { required: { model_name: ['COMBO', { options: ['x.safetensors'] }] }, optional: { extra_state_dict: ['STRING', {}] } }, input_order: { required: ['model_name'], optional: ['extra_state_dict'] } },
  }
  const { prompt } = workflowToPrompt(wf, localInfo)
  assert.equal(prompt['1'].inputs.editor_state, '[]')
  assert.equal(prompt['2'].inputs.extra_state_dict, undefined)
})

test('binds the negative prompt to the text node wired into the sampler', () => {
  const workflow = {
    nodes: [
      { id: 1, type: 'KSampler', inputs: [{ name: 'positive' }, { name: 'negative' }], outputs: [] },
      { id: 2, type: 'CLIPTextEncode', title: 'positive', inputs: [], outputs: [{ type: 'CONDITIONING' }] },
      { id: 3, type: 'CLIPTextEncode', title: 'negative', inputs: [], outputs: [{ type: 'CONDITIONING' }] },
    ],
    links: [[7, 3, 0, 1, 1, 'CONDITIONING']],
  }
  const bindings = inferBindings(workflow, {})
  assert.equal(bindings.negative, '3')
  const injected = applyBindings({
    3: { class_type: 'CLIPTextEncode', inputs: { text: 'old negative' } },
  }, bindings, { negative: 'greyscale, lowres' })
  assert.equal(injected.prompt['3'].inputs.text, 'greyscale, lowres')
})

test('binds the mask to a LoadImage alpha output for legacy inpaint graphs', () => {
  const workflow = {
    nodes: [
      { id: 1, type: 'LoadImage', mode: 0, inputs: [{ name: 'image', type: 'COMBO', link: null }], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [1] }, { name: 'MASK', type: 'MASK', links: [2] }] },
      { id: 2, type: 'VAEEncodeForInpaint', mode: 0, inputs: [{ name: 'pixels', type: 'IMAGE', link: 1 }, { name: 'vae', type: 'VAE', link: null }, { name: 'mask', type: 'MASK', link: 2 }, { name: 'grow_mask_by', type: 'INT', link: null }], outputs: [{ name: 'LATENT', type: 'LATENT', links: [3] }] },
      { id: 10, type: 'SaveImage', mode: 0, inputs: [{ name: 'images', type: 'IMAGE', link: 3 }], outputs: [] },
    ],
    links: [[1, 1, 0, 2, 0, 'IMAGE'], [2, 1, 1, 2, 2, 'MASK'], [3, 2, 0, 10, 0, 'LATENT']],
  }
  const bindings = inferBindings(workflow, {})
  assert.equal(bindings.image, '1')
  assert.equal(bindings.mask, '1')
})

test('binds the mask to a LoadImageMask node when the graph uses native mask nodes', () => {
  const workflow = {
    nodes: [
      { id: 1, type: 'LoadImage', mode: 0, inputs: [{ name: 'image', type: 'COMBO', link: null }], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [1] }, { name: 'MASK', type: 'MASK', links: [] }] },
      { id: 9, type: 'LoadImageMask', mode: 0, inputs: [{ name: 'image', type: 'COMBO', link: null }, { name: 'channel', type: 'COMBO', link: null }], outputs: [{ name: 'MASK', type: 'MASK', links: [2] }] },
      { id: 2, type: 'VAEEncodeForInpaint', mode: 0, inputs: [{ name: 'pixels', type: 'IMAGE', link: 1 }, { name: 'vae', type: 'VAE', link: null }, { name: 'mask', type: 'MASK', link: 2 }, { name: 'grow_mask_by', type: 'INT', link: null }], outputs: [{ name: 'LATENT', type: 'LATENT', links: [3] }] },
      { id: 10, type: 'SaveImage', mode: 0, inputs: [{ name: 'images', type: 'IMAGE', link: 3 }], outputs: [] },
    ],
    links: [[1, 1, 0, 2, 0, 'IMAGE'], [2, 9, 0, 2, 2, 'MASK'], [3, 2, 0, 10, 0, 'LATENT']],
  }
  const bindings = inferBindings(workflow, {})
  assert.equal(bindings.image, '1')
  assert.equal(bindings.mask, '9')
})

test('traces an ImageToMask back to the image that carries the mask', () => {
  const workflow = {
    nodes: [
      { id: 1, type: 'LoadImage', mode: 0, inputs: [{ name: 'image', type: 'COMBO', link: null }], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [1] }] },
      { id: 5, type: 'LoadImage', mode: 0, inputs: [{ name: 'image', type: 'COMBO', link: null }], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [3] }] },
      { id: 6, type: 'ImageToMask', mode: 0, inputs: [{ name: 'image', type: 'IMAGE', link: 3 }, { name: 'channel', type: 'COMBO', link: null }], outputs: [{ name: 'MASK', type: 'MASK', links: [2] }] },
      { id: 2, type: 'VAEEncodeForInpaint', mode: 0, inputs: [{ name: 'pixels', type: 'IMAGE', link: 1 }, { name: 'vae', type: 'VAE', link: null }, { name: 'mask', type: 'MASK', link: 2 }], outputs: [{ name: 'LATENT', type: 'LATENT', links: [4] }] },
      { id: 10, type: 'SaveImage', mode: 0, inputs: [{ name: 'images', type: 'IMAGE', link: 4 }], outputs: [] },
    ],
    links: [[1, 1, 0, 2, 0, 'IMAGE'], [2, 6, 0, 2, 2, 'MASK'], [3, 5, 0, 6, 0, 'IMAGE'], [4, 2, 0, 10, 0, 'LATENT']],
  }
  const bindings = inferBindings(workflow, {})
  assert.equal(bindings.image, '1')
  assert.equal(bindings.mask, '5')
})

test('leaves the mask unbound when the inpaint node cannot reach an output', () => {
  const workflow = {
    nodes: [
      { id: 1, type: 'LoadImage', mode: 0, inputs: [{ name: 'image', type: 'COMBO', link: null }], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [1, 2] }, { name: 'MASK', type: 'MASK', links: [] }] },
      { id: 3, type: 'LoadImageMask', mode: 0, inputs: [{ name: 'image', type: 'COMBO', link: null }], outputs: [{ name: 'MASK', type: 'MASK', links: [3] }] },
      { id: 2, type: 'VAEEncodeForInpaint', mode: 0, inputs: [{ name: 'pixels', type: 'IMAGE', link: 2 }, { name: 'vae', type: 'VAE', link: null }, { name: 'mask', type: 'MASK', link: 3 }], outputs: [{ name: 'LATENT', type: 'LATENT', links: [] }] },
      { id: 10, type: 'SaveImage', mode: 0, inputs: [{ name: 'images', type: 'IMAGE', link: 1 }], outputs: [] },
    ],
    links: [[1, 1, 0, 10, 0, 'IMAGE'], [2, 1, 0, 2, 0, 'IMAGE'], [3, 3, 0, 2, 2, 'MASK']],
  }
  const bindings = inferBindings(workflow, {})
  assert.equal(bindings.image, '1')
  assert.equal(bindings.mask, '')
})

test('does not bind an image loader that feeds no output', () => {
  const workflow = {
    nodes: [
      { id: 1, type: 'LoadImage', mode: 0, inputs: [{ name: 'image', type: 'COMBO', link: null }], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [] }, { name: 'MASK', type: 'MASK', links: [] }] },
      { id: 10, type: 'SaveImage', mode: 0, inputs: [], outputs: [] },
    ],
    links: [],
  }
  assert.equal(inferBindings(workflow, {}).image, '')
})

test('ignores a mask input on a compositing node', () => {
  const workflow = {
    nodes: [
      { id: 1, type: 'LoadImage', mode: 0, inputs: [{ name: 'image', type: 'COMBO', link: null }], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [1] }] },
      { id: 3, type: 'LoadImageMask', mode: 0, inputs: [{ name: 'image', type: 'COMBO', link: null }], outputs: [{ name: 'MASK', type: 'MASK', links: [2] }] },
      { id: 5, type: 'ImageCompositeMasked', mode: 0, inputs: [{ name: 'destination', type: 'IMAGE', link: 1 }, { name: 'source', type: 'IMAGE', link: null }, { name: 'mask', type: 'MASK', link: 2 }], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [3] }] },
      { id: 10, type: 'SaveImage', mode: 0, inputs: [{ name: 'images', type: 'IMAGE', link: 3 }], outputs: [] },
    ],
    links: [[1, 1, 0, 5, 0, 'IMAGE'], [2, 3, 0, 5, 2, 'MASK'], [3, 5, 0, 10, 0, 'IMAGE']],
  }
  const bindings = inferBindings(workflow, {})
  assert.equal(bindings.image, '1')
  assert.equal(bindings.mask, '')
})

test('recognizes SetLatentNoiseMask as an inpaint consumer', () => {
  const workflow = {
    nodes: [
      { id: 1, type: 'LoadImage', mode: 0, inputs: [{ name: 'image', type: 'COMBO', link: null }], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [] }, { name: 'MASK', type: 'MASK', links: [1] }] },
      { id: 2, type: 'SetLatentNoiseMask', mode: 0, inputs: [{ name: 'samples', type: 'LATENT', link: null }, { name: 'mask', type: 'MASK', link: 1 }], outputs: [{ name: 'LATENT', type: 'LATENT', links: [2] }] },
      { id: 10, type: 'SaveImage', mode: 0, inputs: [{ name: 'images', type: 'IMAGE', link: 2 }], outputs: [] },
    ],
    links: [[1, 1, 1, 2, 1, 'MASK'], [2, 2, 0, 10, 0, 'LATENT']],
  }
  const bindings = inferBindings(workflow, {})
  assert.equal(bindings.mask, '1')
})

test('binds width/height to the latent that sizes the output, not a layout helper', () => {
  const field = (name) => ({ name, type: 'INT', widget: { name }, link: null })
  const wf = {
    nodes: [
      { id: 1, type: 'MOSSImageLayoutPrompt', pos: [0, 0], mode: 0, inputs: [field('width'), field('height')], outputs: [{ name: 'prompt', type: 'STRING', links: [] }] },
      { id: 2, type: 'CreateBoundingBoxes', pos: [0, 0], mode: 0, inputs: [field('width'), field('height')], outputs: [{ name: 'image', type: 'IMAGE', links: [] }] },
      { id: 3, type: 'EmptyLatentImage', pos: [0, 0], mode: 0, inputs: [field('width'), field('height'), field('batch_size')], outputs: [{ name: 'LATENT', type: 'LATENT', links: [1] }] },
      { id: 4, type: 'KSampler', pos: [0, 0], mode: 0, inputs: [field('seed'), { name: 'latent_image', type: 'LATENT', link: 1 }], outputs: [{ name: 'LATENT', type: 'LATENT', links: [2] }] },
      { id: 5, type: 'SaveImage', pos: [0, 0], mode: 0, inputs: [{ name: 'images', type: 'IMAGE', link: 2 }], outputs: [] },
    ],
    links: [[1, 3, 0, 4, 1, 'LATENT'], [2, 4, 0, 5, 0, 'LATENT']],
  }
  const bindings = inferBindings(wf, info)
  assert.equal(bindings.width, '3')
  assert.equal(bindings.height, '3')
  assert.equal(bindings.seed, '4')
})

const a1111Info = {
  CheckpointLoaderSimple: {
    input: { required: { ckpt_name: ['COMBO', { options: ['model.safetensors'] }] } },
    input_order: { required: ['ckpt_name'] },
    output: ['MODEL', 'CLIP', 'VAE'],
  },
  LoadImage: info.LoadImage,
  LoadImageMask: {
    input: { required: { image: ['COMBO', { options: ['mask.png'] }], channel: ['COMBO', { options: ['alpha', 'red'] }] } },
    input_order: { required: ['image', 'channel'] },
    output: ['MASK'],
  },
  CLIPTextEncode: info.CLIPTextEncode,
  KSampler: info.KSampler,
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
  ImageCropByMaskAndResize: {
    input: { required: { image: ['IMAGE'], mask: ['MASK'], base_resolution: ['INT', { default: 1024 }], padding: ['INT', { default: 32 }], min_crop_resolution: ['INT', { default: 512 }], max_crop_resolution: ['INT', { default: 1024 }] } },
    input_order: { required: ['image', 'mask', 'base_resolution', 'padding', 'min_crop_resolution', 'max_crop_resolution'] },
    output: ['IMAGE', 'MASK', 'BBOX'],
  },
  GrowMaskWithBlur: {
    input: { required: { mask: ['MASK'], expand: ['INT', { default: 0 }], incremental_expandrate: ['FLOAT', { default: 0 }], tapered_corners: ['BOOLEAN', { default: true }], flip_input: ['BOOLEAN', { default: false }], blur_radius: ['FLOAT', { default: 0 }], lerp_alpha: ['FLOAT', { default: 1 }], decay_factor: ['FLOAT', { default: 1 }] }, optional: { fill_holes: ['BOOLEAN', { default: false }] } },
    input_order: { required: ['mask', 'expand', 'incremental_expandrate', 'tapered_corners', 'flip_input', 'blur_radius', 'lerp_alpha', 'decay_factor'], optional: ['fill_holes'] },
    output: ['MASK', 'MASK'],
  },
  VAEDecode: {
    input: { required: { samples: ['LATENT'], vae: ['VAE'] } },
    input_order: { required: ['samples', 'vae'] },
    output: ['IMAGE'],
  },
  ImageUncropByMask: {
    input: { required: { destination: ['IMAGE'], source: ['IMAGE'], mask: ['MASK'], bbox: ['BBOX,BOUNDING_BOX'] } },
    input_order: { required: ['destination', 'source', 'mask', 'bbox'] },
    output: ['IMAGE'],
  },
  SaveImage: {
    input: { required: { images: ['IMAGE'], filename_prefix: ['STRING', { default: 'ComfyUI' }] } },
    input_order: { required: ['images', 'filename_prefix'] },
    output: [],
  },
}

/** An "inpaint at full resolution" graph: crop by mask, sample there, paste back. */
function a1111Workflow() {
  const w = (name) => ({ name, type: 'INT', widget: { name }, link: null })
  const n = (id, type, inputs, outputs) => ({ id, type, pos: [0, 0], size: [200, 100], mode: 0, inputs, outputs, widgets_values: [], widgets_values_named: {} })
  return {
    nodes: [
      n(1, 'CheckpointLoaderSimple', [], [{ name: 'MODEL', type: 'MODEL' }, { name: 'CLIP', type: 'CLIP' }, { name: 'VAE', type: 'VAE' }]),
      n(2, 'LoadImage', [{ name: 'image', type: 'COMBO', widget: { name: 'image' }, link: null }], [{ name: 'IMAGE', type: 'IMAGE' }, { name: 'MASK', type: 'MASK' }]),
      n(9, 'LoadImageMask', [{ name: 'image', type: 'COMBO', widget: { name: 'image' }, link: null }, { name: 'channel', type: 'COMBO', widget: { name: 'channel' }, link: null }], [{ name: 'MASK', type: 'MASK' }]),
      n(11, 'ImageCropByMaskAndResize', [{ name: 'image', type: 'IMAGE', link: 3 }, { name: 'mask', type: 'MASK', link: 4 }, w('base_resolution'), w('padding'), w('min_crop_resolution'), w('max_crop_resolution')], [{ name: 'images', type: 'IMAGE' }, { name: 'masks', type: 'MASK' }, { name: 'bbox', type: 'BBOX' }]),
      n(12, 'GrowMaskWithBlur', [{ name: 'mask', type: 'MASK', link: 5 }, w('expand'), w('incremental_expandrate'), w('tapered_corners'), w('flip_input'), w('blur_radius'), w('lerp_alpha'), w('decay_factor')], [{ name: 'mask', type: 'MASK' }, { name: 'mask_inverted', type: 'MASK' }]),
      n(3, 'VAEEncode', [{ name: 'pixels', type: 'IMAGE', link: 6 }, { name: 'vae', type: 'VAE', link: 7 }], [{ name: 'LATENT', type: 'LATENT' }]),
      n(10, 'SetLatentNoiseMask', [{ name: 'samples', type: 'LATENT', link: 8 }, { name: 'mask', type: 'MASK', link: 9 }], [{ name: 'LATENT', type: 'LATENT' }]),
      n(4, 'CLIPTextEncode', [{ name: 'clip', type: 'CLIP', link: 10 }, { name: 'text', type: 'STRING', widget: { name: 'text' }, link: null }], [{ name: 'CONDITIONING', type: 'CONDITIONING' }]),
      n(5, 'CLIPTextEncode', [{ name: 'clip', type: 'CLIP', link: 11 }, { name: 'text', type: 'STRING', widget: { name: 'text' }, link: null }], [{ name: 'CONDITIONING', type: 'CONDITIONING' }]),
      n(6, 'KSampler', [{ name: 'model', type: 'MODEL', link: 12 }, { name: 'positive', type: 'CONDITIONING', link: 13 }, { name: 'negative', type: 'CONDITIONING', link: 14 }, { name: 'latent_image', type: 'LATENT', link: 15 }, { name: 'seed', type: 'INT', widget: { name: 'seed' }, link: null }, { name: 'steps', type: 'INT', widget: { name: 'steps' }, link: null }, { name: 'cfg', type: 'FLOAT', widget: { name: 'cfg' }, link: null }, { name: 'sampler_name', type: 'COMBO', widget: { name: 'sampler_name' }, link: null }, { name: 'scheduler', type: 'COMBO', widget: { name: 'scheduler' }, link: null }, { name: 'denoise', type: 'FLOAT', widget: { name: 'denoise' }, link: null }], [{ name: 'LATENT', type: 'LATENT' }]),
      n(7, 'VAEDecode', [{ name: 'samples', type: 'LATENT', link: 16 }, { name: 'vae', type: 'VAE', link: 17 }], [{ name: 'IMAGE', type: 'IMAGE' }]),
      n(13, 'ImageUncropByMask', [{ name: 'destination', type: 'IMAGE', link: 18 }, { name: 'source', type: 'IMAGE', link: 19 }, { name: 'mask', type: 'MASK', link: 20 }, { name: 'bbox', type: 'BBOX,BOUNDING_BOX', link: 21 }], [{ name: 'image', type: 'IMAGE' }]),
      n(8, 'SaveImage', [{ name: 'images', type: 'IMAGE', link: 22 }, { name: 'filename_prefix', type: 'STRING', widget: { name: 'filename_prefix' }, link: null }], []),
    ],
    links: [
      [1, 1, 0, 6, 0, 'MODEL'],
      [2, 1, 1, 4, 0, 'CLIP'],
      [3, 2, 0, 11, 0, 'IMAGE'],
      [4, 9, 0, 11, 1, 'MASK'],
      [5, 11, 1, 12, 0, 'MASK'],
      [6, 11, 0, 3, 0, 'IMAGE'],
      [7, 1, 2, 3, 1, 'VAE'],
      [8, 3, 0, 10, 0, 'LATENT'],
      [9, 12, 0, 10, 1, 'MASK'],
      [10, 1, 1, 4, 0, 'CLIP'],
      [11, 1, 1, 5, 0, 'CLIP'],
      [12, 1, 0, 6, 0, 'MODEL'],
      [13, 4, 0, 6, 1, 'CONDITIONING'],
      [14, 5, 0, 6, 2, 'CONDITIONING'],
      [15, 10, 0, 6, 3, 'LATENT'],
      [16, 6, 0, 7, 0, 'LATENT'],
      [17, 1, 2, 7, 1, 'VAE'],
      [18, 2, 0, 13, 0, 'IMAGE'],
      [19, 7, 0, 13, 1, 'IMAGE'],
      [20, 12, 0, 13, 2, 'MASK'],
      [21, 11, 2, 13, 3, 'BBOX'],
      [22, 13, 0, 8, 0, 'IMAGE'],
    ],
  }
}

test('binds the canvas image and mask through an inpaint-at-full-resolution graph', () => {
  const bindings = inferBindings(a1111Workflow(), a1111Info)
  assert.equal(bindings.image, '2')
  assert.equal(bindings.mask, '9')
  assert.equal(bindings.prompt, '4')
  assert.equal(bindings.negative, '5')
  assert.equal(bindings.seed, '6')
})
