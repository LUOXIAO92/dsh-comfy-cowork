import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { isModelFile, ModelCatalog } from '../lib/model-catalog.js'
import { buildNodeTree, cleanCategory, NodeCatalog, nodeEntries } from '../lib/node-catalog.js'
import { WorkflowIndex } from '../lib/workflow-index.js'
import { DEFAULTS, normalizeConfig } from '../lib/config.js'

async function makeRoot() {
  const root = await fs.mkdtemp(path.join(process.cwd(), 'tests/.tmp-catalog-'))
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) }
}

function nodeFile(root) {
  return path.join(root, '.comfy-cowork', 'nodes.json')
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
  KJMask: {
    display_name: 'Mask Ops',
    category: 'KJNodes/masking',
    description: 'Mask helpers.',
  },
  KJImage: {
    display_name: 'Image Ops',
    category: 'KJNodes/imaging',
    description: 'Image helpers.',
  },
  AusBossVideo: {
    display_name: 'AusBoss Video',
    category: '🆎 AusBoss/Video',
    description: 'Video helpers for AusBoss.',
  },
  UnfiledNode: {
    display_name: 'Unfiled Node',
    category: '',
    description: 'A node with no category at all.',
  },
}

function fakeComfy(overrides = {}) {
  return {
    async models() {
      // ComfyUI also lists folders that hold no model, or that mirror others.
      return ['checkpoints', 'loras', 'custom_nodes', 'configs', 'vae_approx']
    },
    async modelFiles(folder) {
      return {
        checkpoints: ['Illustrious/a.safetensors', 'Illustrious/b.ckpt'],
        loras: ['style/c.safetensors'],
        custom_nodes: ['SomeNode.py', 'SomeNode.pyc', '.disabled/pkg/weights.safetensors'],
        configs: ['anything_v3.yaml'],
        // A preview folder pointed at the models root repeats every weight.
        vae_approx: ['checkpoints/Illustrious/a.safetensors'],
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
    // custom_nodes, configs, and the mirrored vae_approx folder never enter it.
    assert.deepEqual(catalog.folders(snapshot), [
      { folder: 'checkpoints', count: 2 },
      { folder: 'loras', count: 1 },
    ])
    const file = JSON.parse(await fs.readFile(path.join(root, '.comfy-cowork', 'models.json'), 'utf8'))
    assert.equal(file.version, 4)
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

test('a model snapshot is stale only when missing, and a failed refresh keeps it', async () => {
  const { root, cleanup } = await makeRoot()
  try {
    const config = normalizeConfig({})
    const catalog = new ModelCatalog(config)
    assert.equal(catalog.stale(root, null), true)

    let reads = 0
    const comfy = fakeComfy({
      async models() {
        reads += 1
        return ['checkpoints', 'loras', 'custom_nodes', 'configs', 'vae_approx']
      },
    })
    const first = await catalog.ensure(root, comfy)
    assert.equal(first.refreshed, true)
    assert.equal(catalog.stale(root, first.snapshot), false)
    // No TTL: even a snapshot with an ancient timestamp is never stale.
    assert.equal(catalog.stale(root, { ...first.snapshot, updatedAt: 0 }), false)

    const second = await catalog.ensure(root, comfy)
    assert.equal(second.refreshed, false)
    assert.equal(reads, 1)

    const failing = fakeComfy({
      async models() {
        throw new Error('server down')
      },
    })
    await assert.rejects(() => catalog.ensure(root, failing, { force: true }), /server down/)
    const kept = await catalog.read(root)
    assert.deepEqual(catalog.folders(kept), [
      { folder: 'checkpoints', count: 2 },
      { folder: 'loras', count: 1 },
    ])
    // The last good snapshot also survives on disk for a fresh process.
    const reread = new ModelCatalog(config)
    assert.deepEqual(reread.folders(await reread.read(root)), [
      { folder: 'checkpoints', count: 2 },
      { folder: 'loras', count: 1 },
    ])
  } finally {
    await cleanup()
  }
})

test('the model cache TTL setting is gone', () => {
  assert.equal(Object.hasOwn(DEFAULTS, 'modelCacheTtlMs'), false)
  assert.equal(normalizeConfig({}).modelCacheTtlMs, undefined)
})

test('buildNodeTree nests category paths and rolls counts up', () => {
  const tree = buildNodeTree(nodeEntries(OBJECT_INFO))
  assert.equal(tree.count, 6)
  assert.equal(tree.children.KJNodes.count, 2)
  assert.equal(tree.children.KJNodes.children.masking.count, 1)
  assert.equal(tree.children.KJNodes.children.imaging.count, 1)
  assert.deepEqual(tree.children.KJNodes.children.masking.nodes, [
    { type: 'KJMask', display: 'Mask Ops', description: 'Mask helpers.' },
  ])
  assert.deepEqual(tree.children['🆎 AusBoss'].children.Video.nodes.map((node) => node.type), ['AusBossVideo'])
  // A node with no category is filed at the root, not in a fake branch.
  assert.deepEqual(tree.nodes.map((node) => node.type), ['UnfiledNode'])
  // The stored shape is exactly { count, nodes, children } at every level.
  assert.deepEqual(buildNodeTree([{ type: 'A', display: 'A', category: 'X', description: '' }]), {
    count: 1,
    nodes: [],
    children: { X: { count: 1, nodes: [{ type: 'A', display: 'A', description: '' }], children: {} } },
  })

  // Category paths are cleaned segment by segment, not treated as one string.
  assert.equal(cleanCategory(' KJNodes // masking / '), 'KJNodes/masking')
  const messy = buildNodeTree([{ type: 'Messy', display: 'Messy', category: ' A / b // c ', description: '' }])
  assert.equal(messy.count, 1)
  assert.equal(messy.children.A.count, 1)
  assert.equal(messy.children.A.children.b.children.c.nodes[0].type, 'Messy')
})

test('the node directory browses the same tree ComfyUI\'s palette shows', async () => {
  const { root, cleanup } = await makeRoot()
  try {
    const config = normalizeConfig({})
    const catalog = new NodeCatalog(config)
    const { snapshot, refreshed } = await catalog.ensure(root, fakeComfy())
    assert.equal(refreshed, true)
    // The in-memory snapshot is the persisted shape; the flat view stays hidden.
    assert.deepEqual(Object.keys(snapshot).sort(), ['baseUrl', 'tree', 'updatedAt'])
    assert.equal(snapshot.tree.count, 6)
    assert.equal(snapshot.baseUrl, config.baseUrl)

    const top = catalog.categories(snapshot)
    assert.deepEqual(top[0], { category: 'KJNodes', count: 2 })
    const rest = ['🆎 AusBoss', 'loaders', 'sampling', 'uncategorized']
    assert.deepEqual(
      top.slice(1).map((entry) => entry.category),
      rest.sort((a, b) => a.localeCompare(b)),
    )
    assert.deepEqual(catalog.categories(snapshot, 'KJNodes'), [
      { category: 'KJNodes/imaging', count: 1 },
      { category: 'KJNodes/masking', count: 1 },
    ])
    assert.deepEqual(catalog.categories(snapshot, 'KJNodes/masking'), [])
    assert.deepEqual(catalog.categories(snapshot, 'Nope'), [])

    assert.deepEqual(catalog.inCategory(snapshot, 'KJNodes/masking').map((node) => node.type), ['KJMask'])
    // A branch holds only the nodes filed there, never its children's nodes.
    assert.deepEqual(catalog.inCategory(snapshot, 'KJNodes'), [])
    assert.deepEqual(catalog.inCategory(snapshot, ''), [])
    assert.deepEqual(catalog.inCategory(snapshot, 'uncategorized').map((node) => node.type), ['UnfiledNode'])

    assert.equal(catalog.subtreeSize(snapshot, ''), 6)
    assert.equal(catalog.subtreeSize(snapshot, 'KJNodes'), 2)
    assert.equal(catalog.subtreeSize(snapshot, 'KJNodes/masking'), 1)
    assert.equal(catalog.subtreeSize(snapshot, 'uncategorized'), 1)
    assert.equal(catalog.subtreeSize(snapshot, 'Nope'), 0)

    assert.equal(catalog.stale(root, null), true)
    assert.equal(catalog.stale(root, snapshot), false)
    assert.equal(catalog.stale(root, { ...snapshot, updatedAt: 0 }), false)
  } finally {
    await cleanup()
  }
})

test('list searches type, display, category, and description, and pages', async () => {
  const { root, cleanup } = await makeRoot()
  try {
    const catalog = new NodeCatalog(normalizeConfig({}))
    const { snapshot } = await catalog.ensure(root, fakeComfy())

    const byType = catalog.list(snapshot, { query: 'ksampler' })
    assert.equal(byType.total, 1)
    assert.deepEqual(byType.nodes, [{
      type: 'KSampler',
      display: 'KSampler',
      category: 'sampling',
      description: 'Samples latent noise with a model.',
    }])

    const byDisplay = catalog.list(snapshot, { query: 'load checkpoint' })
    assert.deepEqual(byDisplay.nodes.map((node) => node.type), ['CheckpointLoaderSimple'])

    const byCategory = catalog.list(snapshot, { query: 'ausboss' })
    assert.deepEqual(byCategory.nodes.map((node) => node.type), ['AusBossVideo'])
    assert.equal(byCategory.nodes[0].category, '🆎 AusBoss/Video')

    const byDescription = catalog.list(snapshot, { query: 'latent noise' })
    assert.deepEqual(byDescription.nodes.map((node) => node.type), ['KSampler'])

    // Input schemas never enter the directory, so they cannot match a search.
    assert.equal(catalog.list(snapshot, { query: 'ckpt_name' }).total, 0)

    const everything = catalog.list(snapshot, {})
    assert.equal(everything.total, 6)
    assert.equal(everything.nodes.length, 6)
    assert.equal(everything.truncated, false)

    const firstPage = catalog.list(snapshot, { limit: 2 })
    assert.equal(firstPage.total, 6)
    assert.equal(firstPage.nodes.length, 2)
    assert.equal(firstPage.truncated, true)
    const lastPage = catalog.list(snapshot, { offset: 4, limit: 2 })
    assert.equal(lastPage.nodes.length, 2)
    assert.equal(lastPage.truncated, false)
    assert.equal(catalog.list(snapshot, { offset: 6, limit: 2 }).nodes.length, 0)
    // limit is clamped to 1..500.
    assert.equal(catalog.list(snapshot, { limit: 0 }).nodes.length, 1)
    assert.equal(catalog.list(snapshot, { limit: -3 }).nodes.length, 1)
    assert.equal(catalog.list(snapshot, { limit: 5000 }).nodes.length, 6)
  } finally {
    await cleanup()
  }
})

test('the node file is a version 2 tree with no input schemas', async () => {
  const { root, cleanup } = await makeRoot()
  try {
    const config = normalizeConfig({})
    const catalog = new NodeCatalog(config)
    await catalog.ensure(root, fakeComfy())

    const stored = JSON.parse(await fs.readFile(nodeFile(root), 'utf8'))
    assert.equal(stored.version, 2)
    assert.equal(stored.baseUrl, config.baseUrl)
    assert.equal(stored.tree.count, 6)
    assert.ok(stored.tree.children.KJNodes)
    assert.equal(stored.tree.children.KJNodes.count, 2)
    assert.deepEqual(stored.tree.children.KJNodes.children.masking.nodes, [
      { type: 'KJMask', display: 'Mask Ops', description: 'Mask helpers.' },
    ])
    assert.equal(stored.tree.children['🆎 AusBoss'].children.Video.nodes[0].type, 'AusBossVideo')
    assert.deepEqual(stored.tree.nodes.map((node) => node.type), ['UnfiledNode'])
    // The flat list is an in-memory view, never a second copy in the file.
    assert.equal(Object.hasOwn(stored, 'nodes'), false)

    const text = JSON.stringify(stored)
    assert.equal(text.includes('input'), false)
    assert.equal(text.includes('ckpt_name'), false)
  } finally {
    await cleanup()
  }
})

test('a legacy or broken node file is rejected and rebuilt as a tree', async () => {
  const { root, cleanup } = await makeRoot()
  try {
    const config = normalizeConfig({})
    const catalog = new NodeCatalog(config)
    await fs.mkdir(path.join(root, '.comfy-cowork'), { recursive: true })
    await fs.writeFile(nodeFile(root), JSON.stringify({
      version: 1,
      updatedAt: 1,
      baseUrl: config.baseUrl,
      nodes: [{ type: 'LegacyNode', display: 'Legacy', category: 'loaders', description: '' }],
    }), 'utf8')
    assert.equal(await catalog.read(root), null)

    const { snapshot, refreshed } = await catalog.ensure(root, fakeComfy())
    assert.equal(refreshed, true)
    assert.equal(snapshot.tree.count, 6)
    assert.equal(snapshot.tree.children.KJNodes.count, 2)
    assert.equal(JSON.parse(await fs.readFile(nodeFile(root), 'utf8')).version, 2)

    // A version 2 file whose tree is not a tree is treated as missing too.
    await fs.writeFile(nodeFile(root), JSON.stringify({ version: 2, updatedAt: 1, baseUrl: '', tree: null }), 'utf8')
    assert.equal(await new NodeCatalog(config).read(root), null)
  } finally {
    await cleanup()
  }
})

test('a node snapshot is only rebuilt when missing or forced', async () => {
  const { root, cleanup } = await makeRoot()
  try {
    const calls = []
    const comfy = fakeComfy({
      async objectInfo(force) {
        calls.push(force)
        return OBJECT_INFO
      },
    })
    const catalog = new NodeCatalog(normalizeConfig({}))
    const first = await catalog.ensure(root, comfy)
    assert.equal(first.refreshed, true)
    // The full dump is always requested explicitly; the client caches it.
    assert.deepEqual(calls, [true])

    const second = await catalog.ensure(root, comfy)
    assert.equal(second.refreshed, false)
    assert.equal(calls.length, 1)

    const forced = await catalog.ensure(root, comfy, { force: true })
    assert.equal(forced.refreshed, true)
    assert.equal(calls.length, 2)
  } finally {
    await cleanup()
  }
})

test('a failed object_info refresh keeps the previous tree', async () => {
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
    await assert.rejects(() => catalog.ensure(root, broken, { force: true }), /connection refused/)
    const kept = await catalog.read(root)
    assert.equal(kept.tree.children.KJNodes.children.masking.nodes[0].type, 'KJMask')

    const empty = fakeComfy({
      async objectInfo() {
        return {}
      },
    })
    await assert.rejects(() => catalog.ensure(root, empty, { force: true }), /no node definitions/)
    assert.equal((await catalog.read(root)).tree.count, 6)

    // The last good tree is still on disk for a fresh process.
    const reread = new NodeCatalog(config)
    assert.equal((await reread.read(root)).tree.count, 6)
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

test('a model snapshot from another ComfyUI address is rebuilt, not reused', async () => {
  const { root, cleanup } = await makeRoot()
  try {
    const config = normalizeConfig({})
    const catalog = new ModelCatalog(config)
    let reads = 0
    const comfy = fakeComfy({
      async models() {
        reads += 1
        return ['checkpoints']
      },
    })
    await catalog.ensure(root, comfy)
    assert.equal(reads, 1)

    config.baseUrl = 'http://127.0.0.1:9999'
    // A fresh process sees the address stored in the file and refuses it.
    const fresh = new ModelCatalog(config)
    assert.equal(await fresh.read(root), null)
    // And a warm one drops the in-memory snapshot built for the old address.
    const next = await catalog.ensure(root, comfy)
    assert.equal(next.refreshed, true)
    assert.equal(reads, 2)
  } finally {
    await cleanup()
  }
})

test('a node tree from another ComfyUI address is rebuilt, not reused', async () => {
  const { root, cleanup } = await makeRoot()
  try {
    const config = normalizeConfig({})
    const catalog = new NodeCatalog(config)
    let refreshes = 0
    const comfy = fakeComfy({
      async objectInfo() {
        refreshes += 1
        return OBJECT_INFO
      },
    })
    await catalog.ensure(root, comfy)
    assert.equal(refreshes, 1)

    config.baseUrl = 'http://127.0.0.1:9999'
    const fresh = new NodeCatalog(config)
    assert.equal(await fresh.read(root), null)
    const next = await catalog.ensure(root, comfy)
    assert.equal(next.refreshed, true)
    assert.equal(refreshes, 2)
  } finally {
    await cleanup()
  }
})
