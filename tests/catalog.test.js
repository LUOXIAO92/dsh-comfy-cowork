import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { isModelFile, ModelCatalog } from '../lib/model-catalog.js'
import { NodeCatalog } from '../lib/node-catalog.js'
import { WorkflowIndex } from '../lib/workflow-index.js'
import { normalizeConfig } from '../lib/config.js'

async function makeRoot() {
  const root = await fs.mkdtemp(path.join(process.cwd(), 'tests/.tmp-catalog-'))
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) }
}

/** A slice of object_info: node metadata plus schemas the node cache must not keep. */
const OBJECT_INFO = {
  CheckpointLoaderSimple: {
    display_name: 'Load Checkpoint',
    category: 'loaders',
    description: 'Loads a diffusion model checkpoint.',
    input: { required: { ckpt_name: [['Illustrious/a.safetensors'], {}] } },
  },
  KSampler: {
    display_name: 'KSampler',
    category: 'sampling',
    description: 'Samples latent noise with a model.',
  },
  MOSSImageLayout: {
    display_name: 'MOSS Image Layout',
    category: 'moss',
    description: 'Compiles layout boxes into a prompt.',
  },
}

function fakeComfy(overrides = {}) {
  return {
    async models() {
      // ComfyUI also lists folders that hold no model at all.
      return ['checkpoints', 'loras', 'custom_nodes', 'configs']
    },
    async modelFiles(folder) {
      return {
        checkpoints: ['Illustrious/a.safetensors', 'Illustrious/b.ckpt'],
        loras: ['style/c.safetensors'],
        custom_nodes: ['SomeNode.py', 'SomeNode.pyc'],
        configs: ['anything_v3.yaml'],
      }[folder] ?? []
    },
    async objectInfo() {
      return OBJECT_INFO
    },
    async listWorkflows() {
      return [{ path: 'workflows/moss.json', size: 10, modified: 123 }]
    },
    async readWorkflow(name) {
      return { nodes: [{ id: 1, type: 'KSampler' }], name }
    },
    async saveWorkflow(name) {
      return { name }
    },
    ...overrides,
  }
}

test('only model files count as models', () => {
  assert.equal(isModelFile('Illustrious/a.safetensors'), true)
  assert.equal(isModelFile('Illustrious/b.ckpt'), true)
  assert.equal(isModelFile('anima/x.gguf'), true)
  assert.equal(isModelFile('SomeNode.pyc'), false)
  assert.equal(isModelFile('anything_v3.yaml'), false)
  assert.equal(isModelFile('FreeMono.ttf'), false)
  assert.equal(isModelFile('pixel_space'), false)
})

test('the model catalog keeps model folders and drops the rest', async () => {
  const { root, cleanup } = await makeRoot()
  try {
    const config = normalizeConfig({})
    const catalog = new ModelCatalog(config)
    const comfy = fakeComfy()
    const { snapshot } = await catalog.ensure(root, comfy)
    // custom_nodes (python) and configs (yaml) hold nothing a loader can load.
    assert.deepEqual(catalog.folders(snapshot), [
      { folder: 'checkpoints', count: 2 },
      { folder: 'loras', count: 1 },
    ])
    const file = JSON.parse(await fs.readFile(path.join(root, '.comfy-cowork', 'models.json'), 'utf8'))
    assert.equal(file.version, 3)
    assert.deepEqual(file.folders.checkpoints, ['Illustrious/a.safetensors', 'Illustrious/b.ckpt'])

    const page = catalog.files(snapshot, 'checkpoints', { limit: 1 })
    assert.equal(page.total, 2)
    assert.deepEqual(page.files, ['Illustrious/a.safetensors'])
    assert.equal(page.truncated, true)

    const searched = catalog.files(snapshot, 'checkpoints', { query: 'b.ck' })
    assert.deepEqual(searched.files, ['Illustrious/b.ckpt'])
  } finally {
    await cleanup()
  }
})

test('a stale model snapshot refreshes, and a failed refresh keeps the last one', async () => {
  const { root, cleanup } = await makeRoot()
  try {
    const config = normalizeConfig({ modelCacheTtlMs: 60_000 })
    const catalog = new ModelCatalog(config)
    const first = await catalog.ensure(root, fakeComfy())
    assert.equal(catalog.stale(root, first.snapshot), false)
    // Age the snapshot instead of racing the clock: one millisecond of TTL made
    // the "fresh" assertion fail whenever the write happened to take longer.
    assert.equal(catalog.stale(root, { ...first.snapshot, updatedAt: Date.now() - 120_000 }), true)

    const failing = fakeComfy({
      async models() {
        throw new Error('server down')
      },
    })
    await assert.rejects(() => catalog.ensure(root, failing, { force: true }))
    const kept = await catalog.read(root)
    assert.deepEqual(catalog.folders(kept), [
      { folder: 'checkpoints', count: 2 },
      { folder: 'loras', count: 1 },
    ])
  } finally {
    await cleanup()
  }
})

test('the node directory keeps names and descriptions, not input schemas', async () => {
  const { root, cleanup } = await makeRoot()
  try {
    const config = normalizeConfig({})
    const catalog = new NodeCatalog(config)
    const { snapshot } = await catalog.ensure(root, fakeComfy())
    assert.deepEqual(snapshot.nodes.map((node) => node.type), ['CheckpointLoaderSimple', 'KSampler', 'MOSSImageLayout'])

    const found = catalog.list(snapshot, { query: 'checkpoint' })
    assert.equal(found.total, 1)
    assert.equal(found.nodes[0].display, 'Load Checkpoint')
    assert.equal(found.nodes[0].category, 'loaders')

    const stored = JSON.parse(await fs.readFile(path.join(root, '.comfy-cowork', 'nodes.json'), 'utf8'))
    assert.equal(stored.version, 1)
    assert.equal(stored.nodes[0].type, 'CheckpointLoaderSimple')
    // A widget's options belong to the request that needs them, not to this file.
    assert.equal(stored.nodes[0].input, undefined)
    assert.equal(JSON.stringify(stored).includes('ckpt_name'), false)

    const byCategory = catalog.list(snapshot, { query: 'sampling' })
    assert.deepEqual(byCategory.nodes.map((node) => node.type), ['KSampler'])
  } finally {
    await cleanup()
  }
})

test('the node directory survives a failure and reports it', async () => {
  const { root, cleanup } = await makeRoot()
  try {
    const config = normalizeConfig({})
    const catalog = new NodeCatalog(config)
    await catalog.ensure(root, fakeComfy())
    const broken = fakeComfy({
      async objectInfo() {
        throw new Error('connection refused')
      },
    })
    await assert.rejects(() => catalog.ensure(root, broken, { force: true }))
    const kept = await catalog.read(root)
    assert.equal(kept.nodes.length, 3)
  } finally {
    await cleanup()
  }
})

test('the workflow index lists all three sources with explicit paths', async () => {
  const { root, cleanup } = await makeRoot()
  try {
    const config = normalizeConfig({})
    const index = new WorkflowIndex(config)
    await fs.mkdir(path.join(root, 'fragments'), { recursive: true })
    await fs.writeFile(path.join(root, 'fragments', 't2i.json'), JSON.stringify({ nodes: [{ id: 1 }] }))
    await fs.mkdir(path.join(root, 'blueprints'), { recursive: true })
    await fs.writeFile(path.join(root, 'blueprints', 'film.compiled.json'), JSON.stringify({ 1: { class_type: 'KSampler' } }))

    const comfy = fakeComfy()
    const built = await index.build(root, comfy)
    const sources = built.entries.map((entry) => entry.source).sort()
    assert.deepEqual(sources, ['comfyui', 'project', 'project'])
    const project = built.entries.find((entry) => entry.name === 't2i.json')
    assert.equal(project.id, `project:${path.join(root, 'fragments', 't2i.json')}`)
    assert.equal(project.path, path.join(root, 'fragments', 't2i.json'))
    assert.equal(project.nodes, 1)

    const saved = await index.save(root, comfy, 'my_flow', { nodes: [] })
    assert.equal(saved.entry.source, 'workspace')
    assert.equal(saved.entry.path, path.join(root, '.comfy-cowork', 'workflows', 'my_flow.json'))
    const reread = await index.read(root)
    assert.ok(reread.entries.some((entry) => entry.id === saved.entry.id))
  } finally {
    await cleanup()
  }
})

test('a ComfyUI failure keeps the previous workflow entries and marks them stale', async () => {
  const { root, cleanup } = await makeRoot()
  try {
    const config = normalizeConfig({})
    const index = new WorkflowIndex(config)
    await index.build(root, fakeComfy())
    const broken = fakeComfy({
      async listWorkflows() {
        throw new Error('connection refused')
      },
    })
    const built = await index.build(root, broken)
    assert.equal(built.stale, true)
    assert.match(built.error, /connection refused/)
    assert.ok(built.entries.some((entry) => entry.id === 'comfyui:workflows/moss.json'))
  } finally {
    await cleanup()
  }
})
