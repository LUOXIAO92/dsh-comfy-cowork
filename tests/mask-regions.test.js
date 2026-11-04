import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { DocStore } from '../lib/store.js'
import { MAX_MASK_REGIONS, normalizeDoc, normalizeMaskRegions } from '../lib/doc.js'
import { normalizeConfig } from '../lib/config.js'
import { registerTools } from '../lib/tools.js'

function region(id, prompt = '', bbox = [10, 10, 40, 40], promptSource = 'user') {
  return { id, prompt, promptSource, bbox, createdAt: 5 }
}

async function makeStore() {
  const root = await fs.mkdtemp(path.join(process.cwd(), 'tests/.tmp-regions-'))
  const ctx = {
    sessions: { get: () => undefined },
    workingDirectory: { defaultDirectory: root },
    logger: { warn() {} },
  }
  const store = new DocStore(ctx, normalizeConfig({}))
  return { store, root, cleanup: () => fs.rm(root, { recursive: true, force: true }) }
}

test('normalizes mask regions in paint order and drops unusable ones', () => {
  const regions = normalizeMaskRegions([
    region('mr-a', 'wing', [0, 0, 10, 10], 'agent'),
    { id: 'bad id!', prompt: 'x', bbox: [0, 0, 1, 1] },
    { id: 'mr-b', prompt: 'no bbox' },
    { id: 'mr-c', prompt: 'short bbox', bbox: [0, 0, 1] },
    region('mr-a', 'duplicate id'),
    'not an object',
    region('mr-d', '', [5, 5, 10, 10]),
  ])
  assert.deepEqual(regions.map((entry) => entry.id), ['mr-a', 'mr-d'])
  assert.deepEqual(regions[0], { id: 'mr-a', prompt: 'wing', promptSource: 'agent', bbox: [0, 0, 10, 10], createdAt: 5 })
  assert.equal(regions[1].prompt, '')
})

test('caps the number of mask regions', () => {
  const many = Array.from({ length: MAX_MASK_REGIONS + 5 }, (_, index) => region(`mr-${index}`, `p${index}`))
  assert.equal(normalizeMaskRegions(many).length, MAX_MASK_REGIONS)
})

test('normalizeDoc keeps regions and defaults them to an empty list', () => {
  const doc = normalizeDoc({
    mask: { prompt: 'legacy', regions: [region('mr-a', 'wing'), region('bad!', 'x')] },
  }, 'session-doc')
  assert.deepEqual(doc.mask.regions.map((entry) => entry.id), ['mr-a'])
  assert.equal(doc.mask.prompt, 'legacy')
  const empty = normalizeDoc({ mask: {} }, 'session-doc')
  assert.deepEqual(empty.mask.regions, [])
})

test('setCanvas normalizes a regions patch instead of storing it raw', async () => {
  const { store, cleanup } = await makeStore()
  try {
    const session = 'session-regions-canvas'
    const doc = await store.setCanvas(session, {
      mask: {
        rev: 3,
        regions: [region('mr-a', 'wing'), { id: 'nope!', prompt: 'dropped', bbox: [0, 0, 1, 1] }],
      },
    })
    assert.deepEqual(doc.mask.regions.map((entry) => entry.id), ['mr-a'])
    assert.equal(doc.mask.rev, 3)
    const reloaded = await store.snapshot(session)
    assert.deepEqual(reloaded.mask.regions.map((entry) => entry.id), ['mr-a'])
  } finally {
    await cleanup()
  }
})

test('setMaskRegionPrompt writes one region by id or 1-based index', async () => {
  const { store, cleanup } = await makeStore()
  try {
    const session = 'session-region-prompt'
    await store.setCanvas(session, {
      mask: { rev: 1, regions: [region('mr-a', 'wing'), region('mr-b', 'glove')] },
    })
    let doc = await store.setMaskRegionPrompt(session, 'mr-b', 'black glove', { source: 'agent' })
    assert.deepEqual(doc.mask.regions.map((entry) => entry.prompt), ['wing', 'black glove'])
    assert.deepEqual(doc.mask.regions.map((entry) => entry.promptSource), ['user', 'agent'])
    doc = await store.setMaskRegionPrompt(session, 1, 'white wing', { source: 'agent' })
    assert.deepEqual(doc.mask.regions.map((entry) => entry.prompt), ['white wing', 'black glove'])
    doc = await store.setMaskRegionPrompt(session, '2', 'black leather glove')
    assert.equal(doc.mask.regions[1].prompt, 'black leather glove')
    assert.equal(doc.mask.regions[1].promptSource, 'user')
    const reloaded = await store.snapshot(session)
    assert.deepEqual(reloaded.mask.regions.map((entry) => entry.prompt), ['white wing', 'black leather glove'])
  } finally {
    await cleanup()
  }
})

test('setMaskRegionPrompt refuses an unknown reference or a canvas without regions', async () => {
  const { store, cleanup } = await makeStore()
  try {
    const session = 'session-region-miss'
    await store.setCanvas(session, { mask: { rev: 1, regions: [region('mr-a')] } })
    await assert.rejects(
      () => store.setMaskRegionPrompt(session, 'mr-nope', 'x'),
      (error) => error.status === 404 && /mr-nope/.test(error.message),
    )
    await assert.rejects(
      () => store.setMaskRegionPrompt(session, 3, 'x'),
      (error) => error.status === 404,
    )
    const empty = 'session-region-none'
    await assert.rejects(() => store.setMaskRegionPrompt(empty, 'mr-a', 'x'), /no mask regions/)
  } finally {
    await cleanup()
  }
})

async function makeToolHarness() {
  const root = await fs.mkdtemp(path.join(process.cwd(), 'tests/.tmp-tools-regions-'))
  const ctx = {
    sessions: { get: () => undefined },
    // Both the store and load_image's workspace guard read the project dir.
    workingDirectory: { defaultDirectory: root, get: () => root },
    logger: { warn() {} },
  }
  const config = normalizeConfig({})
  const store = new DocStore(ctx, config)
  let entry = null
  registerTools({
    ctx,
    store,
    comfy: {
      objectInfo: async () => ({}),
      systemStats: async () => ({}),
      nodeInfo: async () => ({}),
    },
    config,
    log: () => {},
    runManager: {start: async () => ({ run: null }), waitFor: async () => null, interrupt: async () => null},
    diagnostics: {},
    register: (definition) => { entry = definition },
    activate: async () => {},
    modelCatalog: null,
    nodeCatalog: null,
    workflowIndex: null,
  })
  const sessionId = 'session-tools-regions'
  const exec = { agent: { session: { id: sessionId } } }
  const execute = (feature, args) => entry.execute({ action: 'execute', feature, arguments: args }, exec)
  return { store, sessionId, execute, cleanup: () => fs.rm(root, { recursive: true, force: true }) }
}

test('state lists the mask regions with their prompts and 1-based indexes', async () => {
  const { store, sessionId, execute, cleanup } = await makeToolHarness()
  try {
    await store.setCanvas(sessionId, {
      mask: { rev: 2, regions: [region('mr-a', 'white wing'), region('mr-b', '', [200, 200, 260, 260], 'agent')] },
    })
    const state = await execute('state', {})
    assert.deepEqual(state.mask.regions, [
      { id: 'mr-a', index: 1, prompt: 'white wing', promptSource: 'user', bbox: [10, 10, 40, 40] },
      { id: 'mr-b', index: 2, prompt: '', promptSource: 'agent', bbox: [200, 200, 260, 260] },
    ])
    assert.equal(state.mask.prompt, '')
  } finally {
    await cleanup()
  }
})

test('state summarizes a multi-pass run', async () => {
  const { store, sessionId, execute, cleanup } = await makeToolHarness()
  try {
    await store.addRun(sessionId, {
      id: 'run-pass',
      status: 'running',
      promptId: 'pid-1',
      promptKind: 'mask',
      maskDenoise: 0.8,
      passCount: 2,
      passIndex: 2,
      passes: [
        { index: 1, regionId: 'mr-a', promptId: 'pid-1', promptKind: 'mask', prompt: 'wing', denoise: 0.8, status: 'completed', outputs: [], error: null },
        { index: 2, regionId: 'mr-b', promptId: 'pid-2', promptKind: 'empty', prompt: '', denoise: 0.8, status: 'running', outputs: [], error: null },
      ],
      outputs: [],
      error: null,
    })
    const state = await execute('state', {})
    assert.equal(state.runs[0].passCount, 2)
    assert.equal(state.runs[0].passIndex, 2)
    assert.deepEqual(state.runs[0].passes, [
      { index: 1, promptKind: 'mask', prompt: 'wing', status: 'completed', error: null },
      { index: 2, promptKind: 'empty', prompt: '', status: 'running', error: null },
    ])
  } finally {
    await cleanup()
  }
})

test('set_prompt on several regions requires region and writes only that one', async () => {
  const { store, sessionId, execute, cleanup } = await makeToolHarness()
  try {
    await store.setCanvas(sessionId, {
      mask: { rev: 1, regions: [region('mr-a', 'wing'), region('mr-b', 'glove', [200, 200, 260, 260])] },
    })
    await assert.rejects(
      () => execute('set_prompt', { target: 'mask', prompt: 'shiny leather' }),
      (error) => error.status === 409 && /mr-a/.test(error.message) && /mr-b/.test(error.message),
    )
    const byIndex = await execute('set_prompt', { target: 'mask', prompt: 'shiny leather', region: 2 })
    assert.equal(byIndex.regionId, 'mr-b')
    assert.equal(byIndex.prompt, 'shiny leather')
    const byId = await execute('set_prompt', { target: 'mask', prompt: 'white wing', region: 'mr-a' })
    assert.equal(byId.regionId, 'mr-a')
    const doc = await store.snapshot(sessionId)
    assert.deepEqual(doc.mask.regions.map((entry) => entry.prompt), ['white wing', 'shiny leather'])
    assert.deepEqual(doc.mask.regions.map((entry) => entry.promptSource), ['agent', 'agent'])
    // The legacy single prompt is untouched by region writes.
    assert.equal(doc.mask.prompt, '')
  } finally {
    await cleanup()
  }
})

test('set_prompt on one region writes it without a region reference', async () => {
  const { store, sessionId, execute, cleanup } = await makeToolHarness()
  try {
    await store.setCanvas(sessionId, { mask: { rev: 1, regions: [region('mr-a', 'wing')] } })
    const result = await execute('set_prompt', { target: 'mask', prompt: 'white feather wing' })
    assert.equal(result.regionId, 'mr-a')
    assert.equal(result.prompt, 'white feather wing')
  } finally {
    await cleanup()
  }
})

test('set_prompt without regions keeps writing the legacy mask prompt', async () => {
  const { store, sessionId, execute, cleanup } = await makeToolHarness()
  try {
    await store.setCanvas(sessionId, { mask: { rev: 1, regions: [] } })
    const result = await execute('set_prompt', { target: 'mask', prompt: 'local repaint text' })
    assert.equal(result.regionId, undefined)
    assert.equal((await store.snapshot(sessionId)).mask.prompt, 'local repaint text')
  } finally {
    await cleanup()
  }
})

test('load_image drops the previous regions and their assets', async () => {
  const { store, sessionId, execute, cleanup } = await makeToolHarness()
  try {
    await store.setCanvas(sessionId, { mask: { rev: 1, regions: [region('mr-a'), region('mr-b', '', [200, 200, 260, 260])] } })
    await store.saveAsset(sessionId, 'mask-mr-a.png', Buffer.from('a'))
    await store.saveAsset(sessionId, 'mask-mr-b.png', Buffer.from('b'))
    // load_image resolves against the session workspace; copy a fixture in.
    const workspace = path.dirname(path.dirname(store.sessionDir(sessionId)))
    await fs.copyFile(new URL('./fixtures/edit-canvas.png', import.meta.url), path.join(workspace, 'next-image.png'))
    await execute('load_image', { path: 'next-image.png' })
    const doc = await store.snapshot(sessionId)
    assert.deepEqual(doc.mask.regions, [])
    assert.equal(await store.assetExists(sessionId, 'mask-mr-a.png'), false)
    assert.equal(await store.assetExists(sessionId, 'mask-mr-b.png'), false)
  } finally {
    await cleanup()
  }
})
