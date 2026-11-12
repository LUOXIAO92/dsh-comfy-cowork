import React from 'react'
import { createRoot } from 'react-dom/client'
import { CanvasTab } from '../../src/client/CanvasTab.jsx'
import { WorkflowView } from '../../src/client/WorkflowView.jsx'
import { en, ja, zh } from '../../src/client/locales.js'
import { compileMossLayout } from '../../lib/moss.js'

const requestedLang = new URLSearchParams(location.search).get('lang')
const lang = requestedLang === 'en' ? 'en' : requestedLang === 'ja' ? 'ja' : 'zh'
if (typeof document !== 'undefined') document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang
const dict = lang === 'en' ? en : lang === 'ja' ? ja : zh
const t = (key, vars) => {
  const text = dict[key] ?? key
  if (vars === undefined) return text
  return text.replace(/\{(\w+)\}/g, (match, name) => (vars[name] === undefined ? match : String(vars[name])))
}

const items = [
  { id: 'box-1', label: 'object', caption: 'A glossy red apple on the linen surface.', text: '', bbox: [120, 320, 460, 760], palette: ['#b3121b'] },
  { id: 'box-2', label: 'object', caption: 'A matte blue ceramic cup with a rounded handle.', text: '', bbox: [560, 360, 900, 760], palette: ['#245a8d'] },
  { id: 'box-3', label: 'text', caption: 'Small dark-green Chinese caption in the lower left.', text: '安静的午后', bbox: [120, 800, 520, 900], palette: [] },
  { id: 'box-4', label: 'object', caption: '', text: '', bbox: [620, 800, 900, 940], palette: [] },
]
const summaryCaption = 'A clean product layout on a pale linen backdrop: a red apple on the left and a blue ceramic cup on the right, soft window light.'
const summaryItem = { id: 'box-summary', label: 'summary', caption: summaryCaption, text: '', bbox: [16, 16, 336, 156], palette: [] }
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
  { id: 10, type: 'MOSSImageLayoutPrompt', pos: [0, 620], size: [320, 220], mode: 0, inputs: [], widgets_values: [], widgets_values_named: {} },
  { id: 6, type: 'KSampler', pos: [760, 220], size: [320, 260], mode: 0, inputs: [{ name: 'model', type: 'MODEL', link: 6 }, { name: 'positive', type: 'CONDITIONING', link: 7 }, { name: 'negative', type: 'CONDITIONING', link: 8 }, { name: 'latent_image', type: 'LATENT', link: 9 }, { name: 'seed', type: 'INT', widget: { name: 'seed' }, link: null }], widgets_values: [123, 'fixed', 20, 6, 'euler', 'normal', 1], widgets_values_named: { seed: 123, steps: 20, cfg: 6, sampler_name: 'euler', scheduler: 'normal', denoise: 1 } },
]
const links = [[1, 2, 0, 3, 0, 'IMAGE'], [2, 1, 2, 3, 1, 'VAE'], [3, 2, 1, 3, 2, 'MASK'], [4, 1, 1, 4, 0, 'CLIP'], [5, 1, 1, 5, 0, 'CLIP'], [6, 1, 0, 6, 0, 'MODEL'], [7, 4, 0, 6, 1, 'CONDITIONING'], [8, 5, 0, 6, 2, 'CONDITIONING'], [9, 3, 0, 6, 3, 'LATENT']]

const doc = {
  version: 1,
  sessionId: 'session-test',
  rev: 7,
  enabled: true,
  toolsPinned: true,
  mode: 'layout',
  canvas: {
    width: 1024,
    height: 1024,
    image: { asset: 'canvas.png', name: 'linen-still-life.png', width: 1024, height: 1024, rev: 1 },
  },
  mask: {
    feather: 8,
    grow: 0,
    color: '#ff3b30',
    opacity: 0.45,
    denoise: 0.85,
    hasMask: true,
    rev: 1,
    prompt: 'A glossy red pear instead of the apple, keep the linen table and soft window light.',
    promptSource: 'agent',
    shapes: [{ id: 'ms-1', kind: 'rect', bbox: [620, 520, 900, 760] }],
  },
  prompt,
  promptSource: 'layout',
  promptManual: false,
  promptError: null,
  layout: { items: [summaryItem, ...items] },
  comments: [
    { id: 'cm-1', bbox: [120, 320, 460, 760], text: '这个苹果可以改成绿色的', source: 'user', createdAt: 1, updatedAt: 1 },
    { id: 'cm-2', bbox: [560, 120, 900, 320], text: '', source: 'agent', createdAt: 2, updatedAt: 2 },
  ],
  selected: { kind: 'box', id: 'box-1' },
  workflow: { name: 'coworking_inpaint.json', json: { nodes, links }, bindings: { prompt: '4', image: '2', mask: '2', width: '', height: '', seed: '6', bboxes: '' }, dirty: false, loadedAt: 1 },
  runs: [],
  ui: { openSeq: 0, notice: null },
}

// ?run=regions seeds the run panel with a two-region run in flight, so the
// per-pass list can be inspected without queueing against a real ComfyUI.
if (new URLSearchParams(location.search).get('run') === 'regions') {
  doc.runs = [{
    id: 'run-demo-regions',
    status: 'running',
    promptId: 'prompt-pass-1',
    passCount: 2,
    passIndex: 2,
    promptKind: 'mask',
    maskDenoise: 0.85,
    createdAt: 10,
    updatedAt: 20,
    passes: [
      { index: 1, regionId: 'mr-demo-1', promptId: 'prompt-pass-1', promptKind: 'mask', prompt: 'a white feather wing', status: 'completed', outputs: [], error: null },
      { index: 2, regionId: 'mr-demo-2', promptId: 'prompt-pass-2', promptKind: 'empty', prompt: '', status: 'running', outputs: [], error: null },
    ],
    outputs: [{ asset: 'canvas.png', type: 'output' }],
    notes: [],
    error: null,
  }]
}

// ?noimage=1 previews the blank-canvas state (size controls, no artboard image).
if (new URLSearchParams(location.search).get('noimage') === '1') {
  doc.canvas.image = null
  doc.mode = 'layout'
}

// Mask-shape previews are an image-mode tool, so that mode starts in image mode.
if (new URLSearchParams(location.search).get('shape')) doc.mode = 'image'

// ?guard=1 opens a chat that already has history with the tools off, so the
// enable warning can be exercised without a real session log.
const guard = new URLSearchParams(location.search).get('guard') === '1'
if (guard) {
  doc.enabled = false
  doc.toolsPinned = false
}

// ?demo=<flow> starts each recorded demo from a clean, enabled canvas: no
// sample comments or boxes, an empty prompt, and the mode that flow needs.
const demo = new URLSearchParams(location.search).get('demo')
if (demo !== null) {
  doc.enabled = true
  doc.comments = []
  doc.layout.items = demo === 'layout'
    ? [{ id: 'box-summary', label: 'summary', caption: 'A clean still life on pale linen, soft window light.', text: '', bbox: [16, 16, 336, 156], palette: [] }]
    : []
  doc.selected = null
  doc.prompt = ''
  // The layout flow demonstrates the compiler: box edits own the prompt box.
  doc.promptManual = demo !== 'layout'
  doc.promptSource = doc.promptManual ? 'user' : 'layout'
  doc.mask = { ...doc.mask, hasMask: false, shapes: [], prompt: '', regions: [] }
  doc.mode = demo === 'layout' ? 'layout' : 'image'
  if (demo === 'layout') doc.canvas.image = null
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

const realSession = new URLSearchParams(location.search).get('realdoc')
const nativeFetch = window.fetch.bind(window)
// The mock keeps a mutable document so interactions (select / delete / write)
// behave like the host instead of echoing the initial state forever.
let current = JSON.parse(JSON.stringify(doc))
// Mirror the host: any layout edit that leaves the prompt unmanaged recompiles it.
const compileCurrentLayout = () => {
  if (current.promptManual === true) return
  if (current.layout.items.length === 0) {
    current.promptError = null
    current.promptSource = 'layout'
    return
  }
  try {
    current.prompt = compileMossLayout({
      width: current.canvas.width,
      height: current.canvas.height,
      items: current.layout.items,
    })
    current.promptError = null
  } catch (error) {
    current.promptError = String(error?.message ?? error)
  }
  current.promptSource = 'layout'
}
const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
const bodyOf = (options) => {
  try {
    return JSON.parse(options?.body ?? '{}')
  } catch {
    return {}
  }
}

window.EventSource = MockEventSource
// Test hook: every mocked request is recorded so a driver can assert on writes.
window.__ccwFetchLog = []
window.fetch = async (url, options = {}) => {
  try {
    window.__ccwFetchLog.push({ method: (options.method ?? 'GET').toUpperCase(), url: String(url), body: options.body ?? null })
    if (window.__ccwFetchLog.length > 200) window.__ccwFetchLog.shift()
    window.__ccwDoc = current
  } catch {}
  const text = String(url)
  const method = (options.method ?? 'GET').toUpperCase()
  if (realSession !== null && method === 'GET' && text.includes('/api/comfy-cowork/asset')) {
    const name = new URL(text, location.href).searchParams.get('name')
    return nativeFetch(`/.comfy-cowork/${realSession}/assets/${encodeURIComponent(name)}`)
  }
  if (method === 'PUT' && text.includes('/doc/selection')) {
    current.selected = bodyOf(options).selection ?? null
    return json({ doc: current })
  }
  if (method === 'DELETE' && text.includes('/doc/box/')) {
    const id = decodeURIComponent(text.split('/doc/box/')[1].split('?')[0])
    current.layout.items = current.layout.items.filter((item) => item.id !== id)
    if (current.selected?.id === id) current.selected = null
    compileCurrentLayout()
    return json({ doc: current })
  }
  if (method === 'PUT' && text.includes('/doc/box')) {
    const box = bodyOf(options).box
    const index = current.layout.items.findIndex((item) => item.id === box.id)
    if (index === -1) current.layout.items = [...current.layout.items, { ...box, id: box.id ?? `box-${current.layout.items.length + 1}` }]
    else current.layout.items[index] = { ...current.layout.items[index], ...box }
    current.selected = { kind: 'box', id: box.id }
    compileCurrentLayout()
    return json({ doc: current })
  }
  if (method === 'PUT' && text.includes('/doc/comment')) {
    const input = bodyOf(options).comment ?? {}
    const index = current.comments.findIndex((item) => item.id === input.id)
    if (index === -1) {
      const id = input.id ?? `cm-${current.comments.length + 1}`
      current.comments = [...current.comments, { id, bbox: input.bbox, text: input.text ?? '', source: 'user', createdAt: Date.now(), updatedAt: Date.now() }]
    } else {
      current.comments[index] = { ...current.comments[index], ...input }
    }
    return json({ doc: current })
  }
  if (method === 'DELETE' && text.includes('/doc/comment/')) {
    const id = decodeURIComponent(text.split('/doc/comment/')[1].split('?')[0])
    current.comments = current.comments.filter((item) => item.id !== id)
    return json({ doc: current })
  }
  if (method === 'PUT' && text.includes('/doc/canvas')) {
    const patch = bodyOf(options)
    if (patch.mode) current.mode = patch.mode
    if (Number.isInteger(patch.width)) current.canvas.width = patch.width
    if (Number.isInteger(patch.height)) current.canvas.height = patch.height
    if (patch.mask) current.mask = { ...current.mask, ...patch.mask }
    if (patch.image !== undefined) current.canvas.image = patch.image
    return json({ doc: current })
  }
  if (text.includes('/config') && method === 'GET') return json({ baseUrl: 'http://127.0.0.1:8188' })
  if (text.includes('/config') && method === 'PUT') return json({ baseUrl: bodyOf(options).baseUrl ?? 'http://127.0.0.1:8188' })
  if (method === 'PUT' && text.includes('/doc/enabled')) {
    const body = bodyOf(options)
    if (body.enabled === true && guard && current.toolsPinned !== true && body.confirm !== true) {
      return json({ doc: current, needsConfirmation: true, messages: 24 })
    }
    current.enabled = body.enabled === true
    if (current.enabled) current.toolsPinned = true
    return json({ doc: current })
  }
  if (method === 'PUT' && text.includes('/doc/unload')) {
    current.enabled = false
    current.toolsPinned = false
    return json({ doc: current })
  }
  if (method === 'PUT' && text.includes('/doc/prompt')) {
    current.prompt = bodyOf(options).prompt ?? current.prompt
    current.promptSource = 'agent'
    return json({ doc: current })
  }
  if (method === 'PUT' && text.includes('/doc/mask-prompt')) {
    current.mask = { ...current.mask, prompt: bodyOf(options).prompt ?? '', promptSource: 'user' }
    return json({ doc: current })
  }
  if (method === 'PUT' && text.includes('/doc/layout')) {
    const body = bodyOf(options)
    if (Array.isArray(body.items)) current.layout.items = body.items
    compileCurrentLayout()
    return json({ doc: current })
  }
  if (method === 'GET' && text.includes('/doc') && !text.includes('/doc/')) return json({ doc: current })
  if (text.includes('/health')) return json({ ok: true, comfy: { connected: true, version: '0.41.0' } })
  if (text.includes('/workflows') && !text.includes('/load') && !text.includes('/save')) {
    return json({ workflows: [{ path: 'coworking_inpaint.json' }, { path: 'upscale_detail.json' }] })
  }
  if (text.includes('/object_info')) return json({ nodes: infos })
  if (text.includes('/models/')) return json({ folders: ['checkpoints', 'vae'], files: ['Illustrious/miaomiaoHarem_v20.safetensors', 'flux1-dev-fp8.safetensors'] })
  if (text.includes('/models')) return json({ folders: ['checkpoints', 'vae', 'loras'], files: [] })
  if (method === 'PUT' && text.includes('/asset')) return json({ name: 'ok' })
  if (text.includes('/asset')) return new Response('', { status: 404 })
  return json({ doc: current })
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

// A stored document is loaded before the app mounts, so the first render sees
// the same document a real page would; otherwise the demo doc is enough.
if (realSession === null) mountApp()

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

// `?smoke=1` drives the real CanvasTab through a brush/eraser/shape mask and a
// layout box, then reports what the mocks saw. Read the result from the
// `data-smoke` attribute or `#smoke-report` text after --dump-dom.
if (new URLSearchParams(location.search).get('smoke') === '1') runSmoke()

function runSmoke() {
  const calls = []
  const originalFetch = window.fetch
  window.fetch = async (url, options = {}) => {
    calls.push(`${options.method ?? 'GET'} ${String(url).replace('http://127.0.0.1:8766', '')}`)
    return originalFetch(url, options)
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const waitFor = async (read, timeout = 4000) => {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      const value = read()
      if (value) return value
      await sleep(50)
    }
    return null
  }
  const q = (selector) => document.querySelector(`#canvas-root ${selector}`)
  const byLabel = (label, scope = '#canvas-root') => Array.from(document.querySelectorAll(`${scope} [aria-label], ${scope} button`))
    .find((element) => element.getAttribute('aria-label') === label || element.textContent.trim() === label)
  const maskPixels = () => {
    const canvas = q('canvas.ccw-stage-mask')
    if (canvas === null || canvas.width === 0) return -1
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    let painted = 0
    for (let i = 3; i < data.length; i += 4) if (data[i] > 8) painted += 1
    return painted
  }
  const fire = (wrap, type, x, y) => wrap.dispatchEvent(new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    pointerId: 1,
    isPrimary: true,
  }))
  const drag = async (wrap, from, to) => {
    fire(wrap, 'pointerdown', from[0], from[1])
    await sleep(30)
    fire(wrap, 'pointermove', (from[0] + to[0]) / 2, (from[1] + to[1]) / 2)
    await sleep(30)
    fire(wrap, 'pointermove', to[0], to[1])
    await sleep(30)
    fire(wrap, 'pointerup', to[0], to[1])
    await sleep(300)
  }

  const evaluateMaskLayout = async () => {
    const controls = document.querySelector('#canvas-root .ccw-mask-controls')
    if (controls === null) return { found: false }
    const groups = []
    const sliders = []
    const walk = (node) => {
      for (const child of node.children) {
        if (child.classList.contains('ccw-group-label')) groups.push(child.textContent.trim())
        else if (child.classList.contains('ccw-range')) sliders.push((child.querySelector('.ccw-range-label')?.textContent ?? '').trim())
        else if (child.classList.contains('ccw-toggle-row')) sliders.push(`toggle:${child.textContent.trim()}`)
        else walk(child)
      }
    }
    walk(controls)
    const regions = window.__ccwDoc?.mask?.regions ?? []
    const assets = (window.__ccwFetchLog ?? [])
      .filter((entry) => String(entry.url).includes('/asset') && String(entry.url).includes('mask-mr-'))
      .map((entry) => String(entry.url).split('name=')[1]?.split('&')[0])
    return {
      found: true,
      groups,
      sliders,
      regions: regions.length,
      regionPrompts: regions.map((region) => String(region.prompt ?? '')),
      regionAssets: assets.length,
      legacy: {
        visible: 'visible' in (window.__ccwDoc?.mask ?? {}),
        inverted: 'inverted' in (window.__ccwDoc?.mask ?? {}),
      },
    }
  }

  const run = async () => {
    const report = { steps: [], calls, errors: [] }
    const wrap = await waitFor(() => q('.ccw-stage-wrap'))
    if (wrap === null) {
      report.errors.push('stage never mounted')
      return report
    }
    const rect = wrap.getBoundingClientRect()
    const center = [rect.left + rect.width / 2, rect.top + rect.height / 2]

    const imageTab = byLabel('画布')
    if (imageTab) imageTab.click()
    await sleep(300)

    report.steps.push({ step: 'mount', maskPixels: maskPixels() })

    byLabel('画笔')?.click()
    await sleep(100)
    await drag(wrap, [center[0] - 90, center[1]], [center[0] + 90, center[1]])
    report.steps.push({ step: 'brush', maskPixels: maskPixels() })

    byLabel('橡皮')?.click()
    await sleep(100)
    await drag(wrap, [center[0] - 40, center[1]], [center[0] + 40, center[1]])
    report.steps.push({ step: 'eraser', maskPixels: maskPixels() })

    byLabel('矩形')?.click()
    await sleep(100)
    await drag(wrap, [center[0] - 160, center[1] - 90], [center[0] - 20, center[1] + 60])
    report.steps.push({ step: 'rect', maskPixels: maskPixels() })

    byLabel('椭圆')?.click()
    await sleep(100)
    await drag(wrap, [center[0] + 40, center[1] - 90], [center[0] + 170, center[1] + 40])
    report.steps.push({ step: 'ellipse', maskPixels: maskPixels() })

    const findRange = (text) => Array.from(document.querySelectorAll('#canvas-root .ccw-range'))
      .find((element) => element.textContent.includes(text))
    const featherInput = findRange('羽化')?.querySelector('input[type=range]')
    if (featherInput) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(featherInput, '24')
      featherInput.dispatchEvent(new Event('input', { bubbles: true }))
      featherInput.dispatchEvent(new Event('change', { bubbles: true }))
      await sleep(700)
      report.steps.push({ step: 'feather', value: featherInput.value, maskPixels: maskPixels() })
    }

    // The mask strength is the repaint knob: it must reach the saved document
    // (and from there the sampler's denoise), while overlay opacity must not.
    const setRange = async (text, value) => {
      const input = findRange(text)?.querySelector('input[type=range]')
      if (!input) return null
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, String(value))
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await sleep(700)
      return input.value
    }
    // The mask panel is down to brush size + overlay opacity and the repaint
    // numbers: no hardness, no show/invert toggles.
    const maskLayout = await evaluateMaskLayout()
    report.steps.push({ step: 'mask-layout', ...maskLayout })
    const strengthValue = await setRange('重绘强度', 50)
    if (strengthValue !== null) {
      report.steps.push({ step: 'mask-strength', value: strengthValue, denoise: window.__ccwDoc?.mask?.denoise })
    }
    const overlayValue = await setRange('显示不透明度', 80)
    if (overlayValue !== null) {
      report.steps.push({
        step: 'mask-overlay-opacity',
        value: overlayValue,
        denoise: window.__ccwDoc?.mask?.denoise,
        overlay: document.querySelector('#canvas-root .ccw-stage-mask')?.style.opacity ?? null,
      })
    }

    byLabel('布局')?.click()
    await sleep(500)
    byLabel('框')?.click()
    await sleep(150)
    await drag(wrap, [center[0] - 100, center[1] - 100], [center[0] + 100, center[1] + 60])
    report.steps.push({ step: 'layout-box' })

    const workflowTab = Array.from(document.querySelectorAll('#canvas-root [role=tab], #canvas-root button'))
      .find((element) => element.textContent.trim() === '工作流')
    workflowTab?.click()
    await sleep(500)
    report.steps.push({ step: 'workflow', nodes: document.querySelectorAll('#canvas-root .ccw-gnode').length })

    report.error = q('.ccw-error')?.textContent ?? null
    report.calls = calls.filter((line) => !line.includes('/health'))
    return report
  }

  run().then((report) => {
    const text = JSON.stringify(report, null, 1)
    document.body.setAttribute('data-smoke', 'done')
    const pre = document.createElement('pre')
    pre.id = 'smoke-report'
    pre.textContent = text
    pre.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;max-width:100%;max-height:100%;overflow:auto;background:#000;color:#0f0;font-size:10px'
    document.body.appendChild(pre)
  }).catch((error) => {
    document.body.setAttribute('data-smoke', `failed: ${error?.message ?? error}`)
  })
}

// ?shape=rect|ellipse leaves a mask drag in progress so a screenshot shows the
// live preview (dashed mask tint, no layout-box badge).
const shapeMode = new URLSearchParams(location.search).get('shape')
if (shapeMode === 'rect' || shapeMode === 'ellipse') {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const runShape = async () => {
    let wrap = null
    for (let i = 0; i < 60; i += 1) {
      wrap = document.querySelector('#canvas-root .ccw-stage-wrap')
      if (wrap !== null) break
      await sleep(100)
    }
    if (wrap === null) return
    const scriptTab = Array.from(document.querySelectorAll('#canvas-root .ccw-viewtab')).find((el) => el.textContent.trim() === '画布')
    scriptTab?.click()
    await sleep(300)
    const toolButton = Array.from(document.querySelectorAll('#canvas-root button'))
      .find((el) => (el.getAttribute('aria-label') || '') === (shapeMode === 'rect' ? '矩形' : '椭圆'))
    toolButton?.click()
    await sleep(300)
    const rect = wrap.getBoundingClientRect()
    const fire = (type, x, y) => wrap.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 3, isPrimary: true,
    }))
    fire('pointerdown', rect.left + 120, rect.top + 190)
    await sleep(60)
    fire('pointermove', rect.left + 430, rect.top + 470)
  }
  runShape()
}

// ?keytest=1 verifies Delete/Backspace removes the selected box.
if (new URLSearchParams(location.search).get('keytest') === '1') {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const run = async () => {
    for (let i = 0; i < 60 && document.querySelectorAll('#canvas-root .ccw-box-row').length === 0; i += 1) await sleep(100)
    const rows = () => document.querySelectorAll('#canvas-root .ccw-box-row').length
    const report = { before: rows(), calls: [] }
    const second = document.querySelectorAll('#canvas-root .ccw-box-row')[1]
    second?.click()
    await sleep(500)
    const stage = document.querySelector('#canvas-root .ccw-stage-wrap')
    stage?.focus?.()
    stage?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }))
    await sleep(700)
    report.afterStageDelete = rows()
    const first = document.querySelector('#canvas-root .ccw-box-row')
    first?.focus?.()
    first?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }))
    await sleep(700)
    report.afterRowBackspace = rows()
    const pre = document.createElement('pre')
    pre.id = 'keytest-report'
    pre.textContent = JSON.stringify(report)
    pre.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;background:#000;color:#0f0;font-size:12px'
    document.body.appendChild(pre)
  }
  run()
}

// ?errortest=1 compiles with an empty caption and reports the message the user sees.
if (new URLSearchParams(location.search).get('errortest') === '1') {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const run = async () => {
    for (let i = 0; i < 60 && document.querySelector('#canvas-root .ccw-btn-compile') === null; i += 1) await sleep(100)
    document.querySelector('#canvas-root .ccw-btn-compile')?.click()
    await sleep(900)
    const pre = document.createElement('pre')
    pre.id = 'errortest-report'
    pre.textContent = JSON.stringify({
      error: document.querySelector('#canvas-root .ccw-error')?.textContent ?? null,
      selectedRow: document.querySelector('#canvas-root .ccw-box-item.is-selected .ccw-box-index')?.textContent ?? null,
    })
    document.body.appendChild(pre)
  }
  run()
}

// ?realdoc=<session> loads a stored document (plus its assets) for debugging.
if (realSession !== null) {
  const boot = async () => {
    try {
      const stored = await nativeFetch(`/.comfy-cowork/${realSession}/document.json`).then((r) => (r.ok ? r.json() : null))
      if (stored !== null) {
        Object.assign(current, stored)
        window.dispatchEvent(new CustomEvent('ccw-realdoc', { detail: stored }))
      }
    } catch {}
    mountApp()
  }
  boot()
}

// ?sizetest=1 picks the 3:4 ratio and reports the canvas size the host saw.
if (new URLSearchParams(location.search).get('sizetest') === '1') {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const run = async () => {
    for (let i = 0; i < 60 && document.querySelector('#canvas-root .ccw-ratio-field select') === null; i += 1) await sleep(100)
    const select = document.querySelector('#canvas-root .ccw-ratio-field select')
    if (select !== null) {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
      setter.call(select, '3:4')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    }
    await sleep(900)
    const inputs = document.querySelectorAll('#canvas-root .ccw-size-grid input')
    const pre = document.createElement('pre')
    pre.id = 'sizetest-report'
    pre.textContent = JSON.stringify({
      clicked: select !== null,
      ratio: select?.value ?? null,
      widthField: inputs[0]?.value ?? null,
      heightField: inputs[1]?.value ?? null,
      status: document.querySelector('#canvas-root .ccw-statusbar')?.textContent?.slice(0, 30) ?? null,
    })
    document.body.appendChild(pre)
  }
  run()
}
