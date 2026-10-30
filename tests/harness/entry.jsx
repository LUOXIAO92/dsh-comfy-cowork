import React from 'react'
import { createRoot } from 'react-dom/client'
import { CanvasTab } from '../../src/client/CanvasTab.jsx'
import { WorkflowView } from '../../src/client/WorkflowView.jsx'
import { zh } from '../../src/client/locales.js'

const t = (key, vars) => {
  const text = zh[key] ?? key
  if (vars === undefined) return text
  return text.replace(/\{(\w+)\}/g, (match, name) => (vars[name] === undefined ? match : String(vars[name])))
}

const items = [
  { id: 'box-1', label: 'object', caption: 'A glossy red apple on the linen surface.', text: '', bbox: [120, 320, 460, 760], palette: ['#b3121b'] },
  { id: 'box-2', label: 'object', caption: 'A matte blue ceramic cup with a rounded handle.', text: '', bbox: [560, 360, 900, 760], palette: ['#245a8d'] },
  { id: 'box-3', label: 'text', caption: 'Small dark-green Chinese caption in the lower left.', text: '安静的午后', bbox: [120, 800, 520, 900], palette: [] },
]
const prompt = JSON.stringify({
  summary: { caption: 'A clean product layout on a pale linen backdrop: a red apple on the left and a blue ceramic cup on the right, soft window light.' },
  items: [
    { label: 'object', caption: items[0].caption, palette: ['#b3121b'], bbox: [-192, -392, 248, -52] },
    { label: 'object', caption: items[1].caption, palette: ['#245a8d'], bbox: [-152, 48, 248, 388] },
    { label: 'text', caption: items[2].caption, text: '安静的午后', bbox: [288, -392, 388, 8] },
  ],
  bbox_coord_space: 'abs_centralized',
  bbox_format: 'yxyx',
})

const nodes = [
  { id: 1, type: 'CheckpointLoaderSimple', pos: [0, 0], size: [300, 100], mode: 0, inputs: [{ name: 'ckpt_name', type: 'COMBO', widget: { name: 'ckpt_name' }, link: null }], widgets_values: ['Illustrious/miaomiaoHarem_v20.safetensors'], widgets_values_named: { ckpt_name: 'Illustrious/miaomiaoHarem_v20.safetensors' } },
  { id: 2, type: 'LoadImage', pos: [0, 220], size: [300, 320], mode: 0, inputs: [{ name: 'image', type: 'COMBO', widget: { name: 'image' }, link: null }], widgets_values: ['canvas.png'], widgets_values_named: { image: 'canvas.png' } },
  { id: 3, type: 'VAEEncodeForInpaint', pos: [380, 220], size: [280, 130], mode: 0, inputs: [{ name: 'pixels', type: 'IMAGE', link: 1 }, { name: 'vae', type: 'VAE', link: 2 }, { name: 'mask', type: 'MASK', link: 3 }, { name: 'grow_mask_by', type: 'INT', widget: { name: 'grow_mask_by' }, link: null }], widgets_values: [8], widgets_values_named: { grow_mask_by: 8 } },
  { id: 4, type: 'CLIPTextEncode', pos: [380, 0], size: [300, 140], mode: 0, title: 'positive', inputs: [{ name: 'clip', type: 'CLIP', link: 4 }, { name: 'text', type: 'STRING', widget: { name: 'text' }, link: null }], widgets_values: ['Replace the apple with a glossy red pear, keep the linen table and soft window light.'], widgets_values_named: { text: 'Replace the apple with a glossy red pear, keep the linen table and soft window light.' } },
  { id: 5, type: 'CLIPTextEncode', pos: [760, 0], size: [300, 140], mode: 0, title: 'negative', inputs: [{ name: 'clip', type: 'CLIP', link: 5 }, { name: 'text', type: 'STRING', widget: { name: 'text' }, link: null }], widgets_values: ['lowres, blurry, watermark'], widgets_values_named: { text: 'lowres, blurry, watermark' } },
  { id: 6, type: 'KSampler', pos: [760, 220], size: [320, 260], mode: 0, inputs: [{ name: 'model', type: 'MODEL', link: 6 }, { name: 'positive', type: 'CONDITIONING', link: 7 }, { name: 'negative', type: 'CONDITIONING', link: 8 }, { name: 'latent_image', type: 'LATENT', link: 9 }, { name: 'seed', type: 'INT', widget: { name: 'seed' }, link: null }], widgets_values: [123, 'fixed', 20, 6, 'euler', 'normal', 1], widgets_values_named: { seed: 123, steps: 20, cfg: 6, sampler_name: 'euler', scheduler: 'normal', denoise: 1 } },
]
const links = [[1, 2, 0, 3, 0, 'IMAGE'], [2, 1, 2, 3, 1, 'VAE'], [3, 2, 1, 3, 2, 'MASK'], [4, 1, 1, 4, 0, 'CLIP'], [5, 1, 1, 5, 0, 'CLIP'], [6, 1, 0, 6, 0, 'MODEL'], [7, 4, 0, 6, 1, 'CONDITIONING'], [8, 5, 0, 6, 2, 'CONDITIONING'], [9, 3, 0, 6, 3, 'LATENT']]

const doc = {
  version: 1,
  sessionId: 'session-test',
  rev: 7,
  mode: 'layout',
  canvas: {
    width: 1024,
    height: 1024,
    image: { asset: 'canvas.png', name: 'linen-still-life.png', width: 1024, height: 1024, rev: 1 },
  },
  mask: { feather: 8, grow: 0, inverted: false, visible: true, color: '#ff3b30', opacity: 0.45, hasMask: false, rev: 0 },
  prompt,
  promptSource: 'layout',
  promptManual: false,
  promptError: null,
  layout: { summary: 'A clean product layout on a pale linen backdrop: a red apple on the left and a blue ceramic cup on the right, soft window light.', items },
  selected: { kind: 'box', id: 'box-1' },
  workflow: { name: 'coworking_inpaint.json', json: { nodes, links }, bindings: { prompt: '4', image: '2', mask: '2', width: '', height: '', seed: '6', bboxes: '' }, dirty: false, loadedAt: 1 },
  runs: [],
  ui: { openSeq: 0, notice: null },
}

const infos = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['Illustrious/miaomiaoHarem_v20.safetensors'], {}] } }, input_order: { required: ['ckpt_name'] } },
  LoadImage: { input: { required: { image: [['canvas.png'], {}] } }, input_order: { required: ['image'] } },
  VAEEncodeForInpaint: { input: { required: { pixels: ['IMAGE'], vae: ['VAE'], mask: ['MASK'], grow_mask_by: ['INT', { default: 6 }] } }, input_order: { required: ['pixels', 'vae', 'mask', 'grow_mask_by'] } },
  CLIPTextEncode: { input: { required: { clip: ['CLIP'], text: ['STRING', { multiline: true }] } }, input_order: { required: ['clip', 'text'] } },
  KSampler: { input: { required: { model: ['MODEL'], positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'], seed: ['INT'], steps: ['INT'], cfg: ['FLOAT'], sampler_name: [['euler'], {}], scheduler: [['normal'], {}], denoise: ['FLOAT'] } }, input_order: { required: ['model', 'positive', 'negative', 'latent_image', 'seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'] } },
}

class MockEventSource {
  constructor() {
    this.listeners = {}
    setTimeout(() => {
      this.listeners.open?.({})
      this.listeners.hello?.({ data: JSON.stringify({ doc }) })
    }, 0)
  }

  addEventListener(type, fn) { this.listeners[type] = fn }
  close() {}
}

const nativeFetch = window.fetch.bind(window)
window.EventSource = MockEventSource
window.fetch = async (url, options) => {
  const text = String(url)
  const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
  if (text.includes('/doc') && !text.includes('/doc/')) return json({ doc })
  if (text.includes('/health')) return json({ ok: true, comfy: { connected: true, version: '0.41.0' } })
  if (text.includes('/workflows') && !text.includes('/load') && !text.includes('/save')) {
    return json({ workflows: [{ path: 'coworking_inpaint.json' }, { path: 'upscale_detail.json' }] })
  }
  if (text.includes('/object_info')) return json({ nodes: infos })
  if (text.includes('/models/')) return json({ folders: ['checkpoints', 'vae'], files: ['Illustrious/miaomiaoHarem_v20.safetensors', 'flux1-dev-fp8.safetensors'] })
  if (text.includes('/models')) return json({ folders: ['checkpoints', 'vae', 'loras'], files: [] })
  if (text.includes('/asset')) {
    return new Response('', { status: 404, statusText: 'not found' })
  }
  if (text.includes('/workflows/load') || text.includes('/workflows/save') || text.includes('/doc/')) return json({ doc })
  return json({})
}


function mountApp() {
  createRoot(document.getElementById('canvas-root')).render(
    React.createElement(CanvasTab, { sessionId: 'session-test', t }),
  )
  createRoot(document.getElementById('workflow-root')).render(
    React.createElement(WorkflowView, {
      sessionId: 'session-test',
      doc,
      setDoc: () => {},
      t,
      setError: () => {},
    }),
  )
}

mountApp()

// The mocked HTTP layer cannot answer browser <img> requests, so point the
// stage image at the checked-in demo art after React mounts it.
function patchDemoImage() {
  const image = document.querySelector('#canvas-root .ccw-stage-image')
  if (image === null || image.dataset.sample === '1') return
  image.dataset.sample = '1'
  image.src = 'sample.svg'
}

const imageObserver = new MutationObserver(patchDemoImage)
imageObserver.observe(document.body, { childList: true, subtree: true })
patchDemoImage()

// `view=workflow` screenshots the real app shell (the CanvasTab workflow tab);
// `view=workflow-direct` mounts the workflow browser on its own.
const harnessView = new URLSearchParams(location.search).get('view')
if (harnessView === 'workflow' || harnessView === 'workflow-direct') {
  let attempts = 0
  const root = harnessView === 'workflow' ? '#canvas-root' : '#workflow-root'
  const timer = setInterval(() => {
    if (harnessView === 'workflow') {
      const tab = document.querySelectorAll('#canvas-root .ccw-viewtab')[1]
      if (tab !== null && !tab.classList.contains('is-active')) tab.click()
    }
    const node = document.querySelector(`${root} .ccw-gnode`)
    if (node !== null) node.click()
    attempts += 1
    if ((node !== null && attempts > 2) || attempts > 40) clearInterval(timer)
  }, 100)
}

// Lightweight layout smoke signal for screenshot runs (`?debug=1`).
if (new URLSearchParams(location.search).get('debug') === '1') {
  setTimeout(() => {
    const report = (selector) => {
      const element = document.querySelector(selector)
      if (element === null) return null
      return { clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }
    }
    console.log('HARNESS_OVERFLOW', JSON.stringify({
      viewport: window.innerWidth,
      document: report('html'),
      canvas: report('#canvas-root .ccw-root'),
      workflow: report('#canvas-root .ccw-workflow, #workflow-root .ccw-workflow'),
      inspector: report('.ccw-inspector'),
    }))
  }, 1200)
}
