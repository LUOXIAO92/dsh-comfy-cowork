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
      items: [
        { id: 'summary', label: 'summary', caption: 'A studio still life.', text: '', bbox: [0, 0, 1024, 1024], palette: [] },
        { id: 'a', label: 'object', caption: 'an apple', bbox: [100, 100, 300, 300], text: '', palette: [] },
      ],
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
      items: [
        { id: 'summary', label: 'summary', caption: 'x', text: '', bbox: [0, 0, 1024, 1024], palette: [] },
        { id: 'a', label: 'object', caption: 'c', bbox: [0, 0, 2000, 2000] },
      ],
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
    const dir = path.join(root, '.comfy-cowork', session)
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

test('creates, updates and removes canvas comments', async () => {
  const { store, cleanup } = await makeStore()
  try {
    const session = 'session-comments'
    let doc = await store.upsertComment(session, { bbox: [10, 20, 110, 220], text: 'the hand is wrong' }, { source: 'user' })
    assert.equal(doc.comments.length, 1)
    const created = doc.comments[0]
    assert.match(created.id, /^cm-[0-9a-z]+$/)
    assert.equal(created.source, 'user')
    assert.deepEqual(created.bbox, [10, 20, 110, 220])
    assert.ok(Number.isFinite(created.createdAt))
    assert.equal(created.updatedAt, created.createdAt)

    doc = await store.upsertComment(session, {
      id: created.id,
      bbox: [12, 22, 112, 222],
      text: 'the hand is too soft',
    }, { source: 'user' })
    assert.equal(doc.comments.length, 1)
    assert.deepEqual(doc.comments[0].bbox, [12, 22, 112, 222])
    assert.equal(doc.comments[0].text, 'the hand is too soft')
    assert.equal(doc.comments[0].createdAt, created.createdAt)

    const rev = doc.rev
    doc = await store.removeComment(session, created.id)
    assert.deepEqual(doc.comments, [])
    assert.equal(doc.rev, rev + 1)
    doc = await store.removeComment(session, created.id)
    assert.equal(doc.rev, rev + 1, 'removing an unknown comment is a no-op')

    const stored = JSON.parse(await fs.readFile(path.join(store.sessionDir(session), 'document.json'), 'utf8'))
    assert.deepEqual(stored.comments, [])
  } finally {
    await cleanup()
  }
})

test('keeps a comment source when the agent edits it and rejects invalid input', async () => {
  const { store, cleanup } = await makeStore()
  try {
    const session = 'session-comment-source'
    let doc = await store.upsertComment(session, { bbox: [0, 0, 100, 100], text: '这里细节不好', source: 'user' }, { source: 'user' })
    const id = doc.comments[0].id
    const createdAt = doc.comments[0].createdAt

    doc = await store.upsertComment(session, {
      id,
      bbox: [5, 5, 105, 105],
      text: '这里细节不好，重画',
      source: 'agent',
    }, { source: 'agent' })
    assert.equal(doc.comments[0].source, 'user', 'an agent edit keeps the original creator')
    assert.equal(doc.comments[0].createdAt, createdAt)
    assert.equal(doc.comments[0].text, '这里细节不好，重画')

    doc = await store.upsertComment(session, { bbox: [0, 0, 50, 50], text: 'agent note', source: 'agent' }, { source: 'agent' })
    assert.equal(doc.comments[1].source, 'agent')

    await assert.rejects(store.upsertComment(session, { bbox: [0, 0], text: 'x' }), /four coordinates/)
    await assert.rejects(store.upsertComment(session, { bbox: 'nope', text: 'x' }), /array/)
    await assert.rejects(store.upsertComment(session, { bbox: [null, null, 10, 10], text: 'x' }), /finite numbers/)
    await assert.rejects(store.upsertComment(session, { bbox: [0, 0, 10, 10], text: 42 }), /comment text must be a string/)
    await assert.rejects(store.upsertComment(session, { bbox: [0, 0, 10, 10], text: 'x'.repeat(8001) }), /at most 8000 characters/)
    await assert.rejects(store.upsertComment(session, { bbox: [2000, 2000, 3000, 3000], text: 'x' }), /inside the 1024x1024 canvas/)
    assert.equal((await store.snapshot(session)).comments.length, 2)
  } finally {
    await cleanup()
  }
})

test('normalizes persisted comments and drops malformed ones', async () => {
  const { store, root, cleanup } = await makeStore()
  try {
    const session = 'session-comments-old'
    const dir = path.join(root, '.comfy-cowork', session)
    await fs.mkdir(path.join(dir, 'assets'), { recursive: true })
    const longText = 'x'.repeat(9000)
    await fs.writeFile(path.join(dir, 'document.json'), JSON.stringify({
      canvas: { width: 800, height: 600 },
      comments: [
        { id: 'cm-good', bbox: [-50, -20, 500, 400], text: 'keep me', source: 'agent', createdAt: 111, updatedAt: 222, extra: 'drop me' },
        { id: 'cm-strings', bbox: ['10', '20', '300', '400'], text: 'coerced numbers' },
        { id: 'cm-long', bbox: [10, 10, 20, 20], text: longText, source: 'weird' },
        { id: 'cm-bad-bbox', bbox: 'nope', text: 'drop me' },
        { id: 'cm-short-bbox', bbox: [1, 2, 3], text: 'drop me' },
        { id: 'cm-null-bbox', bbox: [null, null, 10, 10], text: 'drop me' },
        { id: 'cm-outside', bbox: [900, 700, 1000, 800], text: 'drop me' },
        { bbox: [0, 0, 10, 10], text: 'no id' },
      ],
    }))
    const doc = await store.snapshot(session)
    assert.deepEqual(doc.comments.map((comment) => comment.id), ['cm-good', 'cm-strings', 'cm-long'])
    assert.deepEqual(doc.comments[0].bbox, [0, 0, 500, 400], 'bbox is clamped into the canvas')
    assert.equal(doc.comments[0].source, 'agent')
    assert.equal(doc.comments[0].createdAt, 111)
    assert.equal(doc.comments[0].updatedAt, 222)
    assert.deepEqual(Object.keys(doc.comments[0]).sort(), ['bbox', 'createdAt', 'id', 'source', 'text', 'updatedAt'])
    assert.deepEqual(doc.comments[1].bbox, [10, 20, 300, 400])
    assert.equal(doc.comments[1].text, 'coerced numbers')
    assert.equal(doc.comments[1].source, 'user', 'source defaults to user')
    assert.equal(doc.comments[2].text.length, 8000, 'comment text is capped')
    assert.equal(doc.comments[2].source, 'user', 'an unknown source falls back to user')
  } finally {
    await cleanup()
  }
})

test('clears a stale layout prompt error when the last box is deleted', async () => {
  const { store, cleanup } = await makeStore()
  try {
    const session = 'session-prompt-error'
    const summary = { id: 'summary', label: 'summary', caption: 'A still life.', text: '', bbox: [0, 0, 1024, 1024], palette: [] }
    let doc = await store.setLayout(session, {
      items: [summary, { id: 'bad', label: 'object', caption: '', bbox: [10, 10, 100, 100] }],
    })
    assert.notEqual(doc.promptError, null)

    doc = await store.removeBox(session, 'bad')
    assert.deepEqual(doc.layout.items.map((item) => item.id), ['summary'])
    assert.equal(doc.promptError, null)
    const stored = JSON.parse(await fs.readFile(path.join(store.sessionDir(session), 'document.json'), 'utf8'))
    assert.equal(stored.promptError, null, 'the cleared error is persisted')

    doc = await store.setLayout(session, {
      items: [summary, { id: 'bad2', label: 'object', caption: '', bbox: [10, 10, 100, 100] }],
    })
    assert.notEqual(doc.promptError, null)
    doc = await store.setLayout(session, { items: [] })
    assert.equal(doc.promptError, null)
  } finally {
    await cleanup()
  }
})

test('clears a stale prompt error when a manual prompt needs no compilation', async () => {
  const { store, root, cleanup } = await makeStore()
  try {
    const session = 'session-manual-error'
    const dir = path.join(root, '.comfy-cowork', session)
    await fs.mkdir(path.join(dir, 'assets'), { recursive: true })
    await fs.writeFile(path.join(dir, 'document.json'), JSON.stringify({
      promptManual: true,
      promptSource: 'user',
      promptError: 'items[0].caption must not be empty (box 1)',
      layout: { summary: 's', items: [{ id: 'box-1', label: 'object', caption: '', bbox: [0, 0, 64, 64] }] },
    }))
    const doc = await store.setNegative(session, 'blurry')
    assert.equal(doc.promptError, null)
  } finally {
    await cleanup()
  }
})

test('keeps the session enable switch in the document', async () => {
  const { store, cleanup } = await makeStore()
  try {
    const session = 'session-enable'
    const initial = await store.snapshot(session)
    assert.equal(initial.enabled, false)
    const on = await store.setEnabled(session, true)
    assert.equal(on.enabled, true)
    const reloaded = await store.snapshot(session)
    assert.equal(reloaded.enabled, true)
    const off = await store.setEnabled(session, false)
    assert.equal(off.enabled, false)
  } finally {
    await cleanup()
  }
})

test('closing the canvas keeps the tools pinned; only an unload drops them', async () => {
  const { store, cleanup } = await makeStore()
  try {
    const session = 'session-pin'
    const initial = await store.snapshot(session)
    assert.equal(initial.toolsPinned, false)
    const on = await store.setEnabled(session, true)
    assert.equal(on.enabled, true)
    assert.equal(on.toolsPinned, true, 'opening the canvas pins the tools')
    const closed = await store.setEnabled(session, false)
    assert.equal(closed.enabled, false)
    assert.equal(closed.toolsPinned, true, 'a normal close keeps the tools')
    const reopened = await store.setEnabled(session, true)
    assert.equal(reopened.toolsPinned, true)
    const unloaded = await store.unloadTools(session)
    assert.equal(unloaded.enabled, false)
    assert.equal(unloaded.toolsPinned, false, 'the explicit unload drops the pin')
    const persisted = await store.snapshot(session)
    assert.equal(persisted.toolsPinned, false)
  } finally {
    await cleanup()
  }
})

test('an enabled document written before the pin existed keeps its tools', async () => {
  const { store, cleanup } = await makeStore()
  try {
    const session = 'session-legacy-pin'
    // A document from the version without the pin: enabled, no toolsPinned key.
    await fs.mkdir(store.sessionDir(session), { recursive: true })
    await fs.writeFile(
      path.join(store.sessionDir(session), 'document.json'),
      JSON.stringify({ version: 1, sessionId: session, enabled: true, prompt: 'legacy' }),
      'utf8',
    )
    const doc = await store.snapshot(session)
    assert.equal(doc.enabled, true)
    assert.equal(doc.toolsPinned, true)
  } finally {
    await cleanup()
  }
})

test('migrates a legacy .comfy-coworking store directory', async () => {
  const { store, root, cleanup } = await makeStore()
  try {
    const session = 'session-legacy'
    const legacyDir = path.join(root, '.comfy-coworking', session)
    await fs.mkdir(path.join(legacyDir, 'assets'), { recursive: true })
    await fs.writeFile(path.join(legacyDir, 'document.json'), JSON.stringify({ prompt: 'from the old directory', rev: 7 }))
    const doc = await store.snapshot(session)
    assert.equal(doc.rev, 7)
    assert.equal(doc.prompt, 'from the old directory')
    const moved = JSON.parse(await fs.readFile(path.join(root, '.comfy-cowork', session, 'document.json'), 'utf8'))
    assert.equal(moved.prompt, 'from the old directory')
    const entries = await fs.readdir(root)
    assert.ok(!entries.includes('.comfy-coworking'), 'the legacy directory moved away')
  } finally {
    await cleanup()
  }
})

test('leaves an existing current store directory alone during migration', async () => {
  const { store, root, cleanup } = await makeStore()
  try {
    const session = 'session-both'
    const legacyDir = path.join(root, '.comfy-coworking', session)
    const currentDir = path.join(root, '.comfy-cowork', session)
    await fs.mkdir(legacyDir, { recursive: true })
    await fs.mkdir(currentDir, { recursive: true })
    await fs.writeFile(path.join(legacyDir, 'document.json'), JSON.stringify({ prompt: 'stale' }))
    await fs.writeFile(path.join(currentDir, 'document.json'), JSON.stringify({ prompt: 'current' }))
    const doc = await store.snapshot(session)
    assert.equal(doc.prompt, 'current')
    assert.ok(await fs.stat(legacyDir), 'the legacy directory is kept untouched')
  } finally {
    await cleanup()
  }
})

test('prefers the session header project while the directory projection is missing', async () => {
  const base = await fs.mkdtemp(path.join(process.cwd(), 'tests/.tmp-root-'))
  const fallback = path.join(base, 'process-cwd')
  const project = path.join(base, 'project')
  try {
    await fs.mkdir(path.join(project, '.comfy-cowork', 'session-head'), { recursive: true })
    await fs.writeFile(
      path.join(project, '.comfy-cowork', 'session-head', 'document.json'),
      JSON.stringify({ prompt: 'from the project' }),
    )
    // The projection has not replayed yet: get() answers with the process default.
    const session = { header: { cwd: project } }
    const ctx = {
      sessions: { get: () => session },
      workingDirectory: { get: () => fallback, defaultDirectory: fallback },
      logger: { warn() {} },
    }
    const store = new DocStore(ctx, normalizeConfig({}))
    assert.equal(store.resolveRoot('session-head'), project)
    assert.equal((await store.snapshot('session-head')).prompt, 'from the project')
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('reloads a document when the session root changes', async () => {
  const base = await fs.mkdtemp(path.join(process.cwd(), 'tests/.tmp-root-'))
  const first = path.join(base, 'first')
  const second = path.join(base, 'second')
  let current = first
  try {
    await fs.mkdir(path.join(second, '.comfy-cowork', 'session-move'), { recursive: true })
    await fs.writeFile(
      path.join(second, '.comfy-cowork', 'session-move', 'document.json'),
      JSON.stringify({ prompt: 'from the second root' }),
    )
    const ctx = {
      sessions: { get: () => ({ header: {} }) },
      workingDirectory: { get: () => current, defaultDirectory: first },
      logger: { warn() {} },
    }
    const store = new DocStore(ctx, normalizeConfig({}))
    assert.equal((await store.snapshot('session-move')).prompt, '')
    current = second
    assert.equal((await store.snapshot('session-move')).prompt, 'from the second root')
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})

test('keeps the summary item first and rejects a second one', async () => {
  const { store, cleanup } = await makeStore()
  try {
    const session = 'session-summary-unique'
    const summary = { id: 's', label: 'summary', caption: 'whole image', text: '', bbox: [0, 0, 1024, 1024], palette: [] }
    const box = { id: 'a', label: 'object', caption: 'apple', bbox: [10, 10, 100, 100], text: '', palette: [] }
    const doc = await store.setLayout(session, { items: [box, summary] })
    assert.deepEqual(doc.layout.items.map((item) => item.label), ['summary', 'object'])
    assert.equal(doc.promptSource, 'layout')
    assert.match(doc.prompt, /"summary":\{"caption":"whole image"\}/)
    await assert.rejects(
      store.setLayout(session, { items: [summary, { ...summary, id: 's2' }, box] }),
      /only one whole-image description/,
    )
    await assert.rejects(
      store.upsertBox(session, { ...box, label: 'summary' }),
      /only one whole-image description/,
    )
    const current = await store.snapshot(session)
    assert.equal(current.layout.items.filter((item) => item.label === 'summary').length, 1)
  } finally {
    await cleanup()
  }
})

test('keeps a compact handle when the summary item has no bbox', async () => {
  const { store, cleanup } = await makeStore()
  try {
    const session = 'session-summary-handle'
    const doc = await store.setLayout(session, {
      items: [
        { id: 's', label: 'summary', caption: 'whole image', text: '', palette: [] },
        { id: 'a', label: 'object', caption: 'apple', bbox: [10, 10, 100, 100], text: '', palette: [] },
      ],
    })
    assert.deepEqual(doc.layout.items[0].bbox, [16, 16, 336, 156])
    const updated = await store.upsertBox(session, { id: 's', label: 'summary', caption: 'still whole image' })
    assert.deepEqual(updated.layout.items[0].bbox, [16, 16, 336, 156], 'a caption edit keeps the same handle')
    const moved = await store.upsertBox(session, { id: 's', label: 'summary', caption: 'still whole image', bbox: [200, 300, 500, 420] })
    assert.deepEqual(moved.layout.items[0].bbox, [200, 300, 500, 420])
    const renamed = await store.upsertBox(session, { id: 's', label: 'summary', caption: 'renamed' })
    assert.deepEqual(renamed.layout.items[0].bbox, [200, 300, 500, 420], 'a caption-only edit keeps a moved handle')
    const rescued = await store.upsertBox(session, { id: 's', label: 'summary', caption: 'renamed', bbox: [2000, 2000, 2300, 2150] })
    assert.deepEqual(rescued.layout.items[0].bbox, [1016, 1016, 1024, 1024], 'an off-canvas handle is pulled back into view')
  } finally {
    await cleanup()
  }
})

test('migrates the old layout.summary field into the one summary item', async () => {
  const { store, cleanup } = await makeStore()
  try {
    const session = 'session-summary-migrate'
    const dir = store.sessionDir(session)
    await fs.mkdir(path.join(dir, 'assets'), { recursive: true })
    await fs.writeFile(path.join(dir, 'document.json'), JSON.stringify({
      canvas: { width: 800, height: 600 },
      layout: {
        summary: 'The old caption for the whole image.',
        items: [{ id: 'box-1', label: 'object', caption: 'an apple', bbox: [10, 10, 100, 100], text: '', palette: [] }],
      },
    }))
    const doc = await store.snapshot(session)
    assert.equal(doc.layout.items.length, 2)
    assert.equal(doc.layout.items[0].label, 'summary')
    assert.equal(doc.layout.items[0].caption, 'The old caption for the whole image.')
    assert.deepEqual(doc.layout.items[0].bbox, [16, 16, 336, 156])
    assert.equal(doc.layout.items[1].caption, 'an apple')
    // The next write persists the new shape and the old field is gone.
    await store.setNegative(session, 'blurry')
    const stored = JSON.parse(await fs.readFile(path.join(dir, 'document.json'), 'utf8'))
    assert.equal('summary' in stored.layout, false)
    assert.equal(stored.layout.items[0].label, 'summary')
  } finally {
    await cleanup()
  }
})

test('stores the local repaint prompt on the mask without touching the canvas prompt', async () => {
  const { store, cleanup } = await makeStore()
  try {
    const session = 'session-mask-prompt'
    await store.setPrompt(session, 'a girl doing a handstand', { source: 'agent' })
    const doc = await store.setMaskPrompt(session, 'yellow hair, single ponytail', { source: 'agent' })
    assert.equal(doc.mask.prompt, 'yellow hair, single ponytail')
    assert.equal(doc.mask.promptSource, 'agent')
    assert.equal(doc.prompt, 'a girl doing a handstand')
    const reloaded = await store.snapshot(session)
    assert.equal(reloaded.mask.prompt, 'yellow hair, single ponytail')
  } finally {
    await cleanup()
  }
})

test('drops the mask invert and visibility fields older documents carry', async () => {
  const { store, cleanup } = await makeStore()
  try {
    const session = 'session-mask-legacy-toggles'
    const dir = await store.ensureDir(session)
    await fs.writeFile(path.join(dir, 'document.json'), JSON.stringify({
      rev: 3,
      mask: { feather: 12, grow: 2, inverted: true, visible: false, opacity: 0.6, denoise: 0.7 },
    }))
    const doc = await store.snapshot(session)
    // The mask is a plain selection: it is always shown and never inverted.
    assert.equal('inverted' in doc.mask, false)
    assert.equal('visible' in doc.mask, false)
    assert.equal(doc.mask.opacity, 0.6)
    assert.equal(doc.mask.denoise, 0.7)
    const patch = await store.setCanvas(session, { mask: { feather: 4, inverted: true, visible: true, rev: 4 } })
    assert.equal('inverted' in patch.mask, false)
    assert.equal('visible' in patch.mask, false)
    assert.equal(patch.mask.feather, 4)
  } finally {
    await cleanup()
  }
})

test('normalizes a persisted mask prompt and its source', async () => {
  const { store, cleanup } = await makeStore()
  try {
    const session = 'session-mask-prompt-legacy'
    const dir = await store.ensureDir(session)
    await fs.writeFile(path.join(dir, 'document.json'), JSON.stringify({
      rev: 3,
      prompt: 'whole image',
      mask: { feather: 4, grow: 8, prompt: 42, promptSource: 'robot' },
    }))
    const doc = await store.snapshot(session)
    assert.equal(doc.mask.prompt, '')
    assert.equal(doc.mask.promptSource, 'user')
    assert.equal(doc.mask.feather, 4)
    assert.equal(doc.mask.grow, 8)
  } finally {
    await cleanup()
  }
})
