import test from 'node:test'
import assert from 'node:assert/strict'
import { workflowToPrompt, inferBindings, applyBindings, bindingsFromWorkflow } from '../lib/workflow.js'

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
      { id: 1, type: 'LoadImage', pos: [0, 0], size: [200, 100], mode: 0, inputs: [{ name: 'image', type: 'COMBO', widget: { name: 'image' }, link: null }], widgets_values: ['a.png'], widgets_values_named: { image: 'a.png' } },
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
  const { prompt, notes } = applyBindings(workflowToPrompt(wf, info).prompt, bindings, {
    prompt: 'new prompt', imageName: 'uploaded.png', width: 768, height: 1024, seed: 7,
  })
  assert.equal(prompt['2'].inputs.text, 'new prompt')
  assert.equal(prompt['1'].inputs.image, 'uploaded.png')
  assert.equal(prompt['3'].inputs.width, 768)
  assert.equal(prompt['3'].inputs.height, 1024)
  assert.equal(prompt['4'].inputs.seed, 7)
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

test('node declarations override inferred bindings', () => {
  const nodes = [
    { id: 1, type: 'CLIPTextEncode', title: 'positive', inputs: [], outputs: [{ type: 'CONDITIONING' }] },
    { id: 2, type: 'LoadImage', inputs: [], outputs: [{ type: 'IMAGE' }, { type: 'MASK' }] },
    { id: 3, type: 'CLIPTextEncode', title: 'negative', inputs: [], outputs: [{ type: 'CONDITIONING' }] },
  ]
  const inferred = bindingsFromWorkflow({ nodes, links: [] }, {})
  assert.equal(inferred.prompt, '1')
  assert.equal(inferred.image, '2')

  const declared = bindingsFromWorkflow({
    nodes: nodes.map((node) => (node.id === 3 ? { ...node, ccw: 'prompt' } : node)),
    links: [],
  }, {})
  assert.equal(declared.prompt, '3', 'the declared node wins over inference')
  assert.equal(declared.image, '2')
})

test('a size declaration feeds width and height from one node', () => {
  const bindings = bindingsFromWorkflow({
    nodes: [
      { id: 5, type: 'EmptyLatentImage', ccw: 'size', inputs: [{ name: 'width' }, { name: 'height' }], outputs: [] },
      { id: 6, type: 'KSampler', inputs: [{ name: 'seed' }], outputs: [] },
    ],
    links: [],
  }, {})
  assert.equal(bindings.width, '5')
  assert.equal(bindings.height, '5')
  assert.equal(bindings.seed, '6')
})

test('a none declaration keeps a node out of injection', () => {
  const bindings = bindingsFromWorkflow({
    nodes: [{ id: 2, type: 'LoadImage', ccw: 'none', inputs: [], outputs: [{ type: 'IMAGE' }, { type: 'MASK' }] }],
    links: [],
  }, {})
  assert.equal(bindings.image, '')
  assert.equal(bindings.mask, '')
})

test('an image declaration keeps the inferred mask on the same node', () => {
  const bindings = bindingsFromWorkflow({
    nodes: [{ id: 2, type: 'LoadImage', ccw: 'image', inputs: [], outputs: [{ type: 'IMAGE' }, { type: 'MASK' }] }],
    links: [],
  }, {})
  assert.equal(bindings.image, '2')
  assert.equal(bindings.mask, '2')
})
