import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ModelCatalog } from '../lib/model-catalog.js'
import { WorkflowIndex } from '../lib/workflow-index.js'
import { normalizeConfig } from '../lib/config.js'

async function makeRoot() {
  const root = await fs.mkdtemp(path.join(process.cwd(), 'tests/.tmp-catalog-'))
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) }
}

function fakeComfy(overrides = {}) {
  return {
    async models() {
      return ['checkpoints', 'loras']
    },
    async modelFiles(folder) {
      return folder === 'checkpoints'
        ? ['Illustrious/a.safetensors', 'Illustrious/b.safetensors']
        : ['style/c.safetensors']
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

test('the model catalog groups files by folder and writes the snapshot', async () => {
  const { root, cleanup } = await makeRoot()
  try {
    const config = normalizeConfig({})
    const catalog = new ModelCatalog(config)
    const comfy = fakeComfy()
    const { snapshot } = await catalog.ensure(root, comfy)
    assert.deepEqual(catalog.folders(snapshot), [
      { folder: 'checkpoints', count: 2 },
      { folder: 'loras', count: 1 },
    ])
    const file = JSON.parse(await fs.readFile(path.join(root, '.comfy-cowork', 'models.json'), 'utf8'))
    assert.equal(file.version, 1)
    assert.deepEqual(file.folders.checkpoints, ['Illustrious/a.safetensors', 'Illustrious/b.safetensors'])

    const page = catalog.files(snapshot, 'checkpoints', { limit: 1 })
    assert.equal(page.total, 2)
    assert.deepEqual(page.files, ['Illustrious/a.safetensors'])
    assert.equal(page.truncated, true)

    const searched = catalog.files(snapshot, 'checkpoints', { query: 'b.safe' })
    assert.deepEqual(searched.files, ['Illustrious/b.safetensors'])
  } finally {
    await cleanup()
  }
})

test('a stale snapshot refreshes, and a failed refresh keeps the last one', async () => {
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
