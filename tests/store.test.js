import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { DocStore } from '../lib/store.js'
import { normalizeConfig } from '../lib/config.js'

async function makeStore() {
  const root = await fs.mkdtemp(path.join(process.cwd(), 'tests/.tmp-store-'))
  const ctx = {
    sessions: { get: () => undefined },
    workingDirectory: { defaultDirectory: root },
    logger: { warn() {} },
  }
  const store = new DocStore(ctx, normalizeConfig({}))
  return { store, root, cleanup: () => fs.rm(root, { recursive: true, force: true }) }
}

test('persists prompt and increments revision', async () => {
  const { store, cleanup } = await makeStore()
  try {
    const session = 'session-test'
    const first = await store.setPrompt(session, 'hello', { source: 'agent' })
    assert.equal(first.rev, 1)
    assert.equal(first.prompt, 'hello')
    const raw = JSON.parse(await fs.readFile(path.join(store.sessionDir(session), 'document.json'), 'utf8'))
    assert.equal(raw.prompt, 'hello')
    const second = await store.snapshot(session)
    assert.equal(second.rev, 1)
  } finally {
    await cleanup()
  }
})

test('compiles a layout into the prompt and keeps manual edits', async () => {
  const { store, cleanup } = await makeStore()
  try {
    const session = 'session-layout'
    await store.setLayout(session, {
      summary: 'A studio still life.',
      items: [{ id: 'a', label: 'object', caption: 'an apple', bbox: [100, 100, 300, 300], text: '', palette: [] }],
    })
    let doc = await store.snapshot(session)
    assert.equal(doc.promptSource, 'layout')
    assert.equal(doc.prompt, '{"summary":{"caption":"A studio still life."},"items":[{"label":"object","caption":"an apple","bbox":[-412,-412,-212,-212]}],"bbox_coord_space":"abs_centralized","bbox_format":"yxyx"}')
    doc = await store.setPrompt(session, 'manual override', { manual: true })
    assert.equal(doc.prompt, 'manual override')
    doc = await store.upsertBox(session, { id: 'a', label: 'object', caption: 'pear', bbox: [100, 100, 300, 300] })
    assert.equal(doc.promptSource, 'layout')
    assert.match(doc.prompt, /pear/)
  } finally {
    await cleanup()
  }
})

test('keeps a compile error instead of clobbering the shape', async () => {
  const { store, cleanup } = await makeStore()
  try {
    const session = 'session-bad'
    const doc = await store.setLayout(session, {
      summary: 'x',
      items: [{ id: 'a', label: 'object', caption: 'c', bbox: [0, 0, 2000, 2000] }],
    })
    assert.notEqual(doc.promptError, null)
    assert.equal(doc.prompt, '')
  } finally {
    await cleanup()
  }
})

test('recovers from a corrupt document file', async () => {
  const { store, root, cleanup } = await makeStore()
  try {
    const session = 'session-corrupt'
    const dir = path.join(root, '.comfy-coworking', session)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'document.json'), '{not json')
    const doc = await store.snapshot(session)
    assert.equal(doc.rev, 0)
    const files = await fs.readdir(dir)
    assert.ok(files.some((name) => name.startsWith('document.corrupt-')))
  } finally {
    await cleanup()
  }
})
