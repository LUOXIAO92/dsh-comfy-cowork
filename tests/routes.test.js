import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { DocStore } from '../lib/store.js'
import { WorkspaceConfig } from '../lib/workspace-config.js'
import { normalizeConfig } from '../lib/config.js'
import { createRoutes } from '../lib/routes.js'

/** Minimal node:http request stand-in: async-iterable body plus the fields routes read. */
function makeReq(method, url, body = undefined) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    headers: { host: '127.0.0.1:3080', cookie: 'dsh=browser' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(status, headers = {}) {
      this.status = status
      this.headers = headers
      this.headersSent = true
      return this
    },
    write(chunk) {
      this.body += String(chunk)
      return true
    },
    end(chunk = '') {
      this.body += String(chunk)
      this.headersSent = true
    },
    destroy() {},
  }
}

async function makeRoutes(admission = { peer: { id: 'peer-1' } }) {
  const root = await fs.mkdtemp(path.join(process.cwd(), 'tests/.tmp-routes-'))
  const ctx = {
    logger: { warn() {} },
    sessions: { get: () => undefined },
    workingDirectory: { defaultDirectory: root },
    connection: { admit: () => admission },
  }
  const config = normalizeConfig({})
  const store = new DocStore(ctx, config)
  const comfy = {
    async systemStats() {
      return { system: { comfyui_version: '0.0.0-test' }, devices: [] }
    },
    async saveWorkflow(name) {
      return { name: name ?? 'saved.json' }
    },
    async readWorkflow() {
      return { nodes: [], links: [] }
    },
    async objectInfo() {
      return {}
    },
    async listWorkflows() {
      return [{ path: 'a.json' }]
    },
  }
  const runCalls = []
  const runManager = {
    async start(sessionId, overrides) {
      runCalls.push({ sessionId, overrides })
      return { run: { id: 'run-test', status: 'queued', sessionId } }
    },
  }
  const routes = createRoutes({ ctx, config, store, comfy, runManager })
  return { routes, store, runCalls, cleanup: () => fs.rm(root, { recursive: true, force: true }) }
}

async function call(routes, req) {
  const res = makeRes()
  await routes.handle(req, res)
  return res
}

test('rejects a request the connection does not admit', async () => {
  const { routes, cleanup } = await makeRoutes({ rejection: 403 })
  try {
    const res = await call(routes, makeReq('GET', '/api/comfy-cowork/health'))
    assert.equal(res.status, 403)
  } finally {
    await cleanup()
  }
})

test('answers health for an admitted browser peer', async () => {
  const { routes, cleanup } = await makeRoutes()
  try {
    const res = await call(routes, makeReq('GET', '/api/comfy-cowork/health'))
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, true)
    assert.equal(body.comfy.connected, true)
    assert.deepEqual(body.errors, [])
  } finally {
    await cleanup()
  }
})

test('stores a box selection and reports the updated document', async () => {
  const { routes, store, cleanup } = await makeRoutes()
  try {
    const session = 'session-routes'
    await store.upsertBox(session, { id: 'box-1', label: 'object', caption: 'an apple', bbox: [10, 10, 100, 100] })
    const res = await call(routes, makeReq('PUT', `/api/comfy-cowork/doc/selection?session=${session}`, {
      selection: { kind: 'box', id: 'box-1' },
    }))
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.deepEqual(body.doc.selected, { kind: 'box', id: 'box-1' })
  } finally {
    await cleanup()
  }
})

test('records a rejected session id so a red banner can be traced', async () => {
  const { routes, cleanup } = await makeRoutes()
  try {
    const res = await call(routes, makeReq('PUT', '/api/comfy-cowork/doc/canvas', {
      sessionId: null,
      mode: 'image',
    }))
    assert.equal(res.status, 400)
    assert.match(JSON.parse(res.body).error, /a valid session id is required/)
    const health = await call(routes, makeReq('GET', '/api/comfy-cowork/health'))
    const errors = JSON.parse(health.body).errors
    assert.equal(errors.length, 1)
    assert.match(errors[0].request, /PUT \/api\/comfy-cowork\/doc\/canvas/)
  } finally {
    await cleanup()
  }
})

test('refuses the literal undefined session instead of creating one', async () => {
  const { routes, store, cleanup } = await makeRoutes()
  try {
    const res = await call(routes, makeReq('PUT', '/api/comfy-cowork/doc/canvas?session=undefined', { mode: 'image' }))
    assert.equal(res.status, 400)
    const dir = store.sessionDir('undefined')
    await assert.rejects(fs.access(path.join(dir, 'document.json')))
  } finally {
    await cleanup()
  }
})

test('accepts a document write whose session id is only in the body', async () => {
  const { routes, store, cleanup } = await makeRoutes()
  try {
    const session = 'session-body-only'
    const res = await call(routes, makeReq('PUT', '/api/comfy-cowork/doc/canvas', {
      sessionId: session,
      mode: 'image',
      mask: { feather: 12, grow: 2, color: '#ff3b30', opacity: 0.45, rev: 1, hasMask: true },
      source: 'user',
    }))
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.doc.mode, 'image')
    assert.equal(body.doc.mask.feather, 12)
    const stored = await store.snapshot(session)
    assert.equal(stored.mask.feather, 12)
  } finally {
    await cleanup()
  }
})

test('accepts a prompt write whose session id is only in the body', async () => {
  const { routes, store, cleanup } = await makeRoutes()
  try {
    const session = 'session-prompt-body'
    const res = await call(routes, makeReq('PUT', '/api/comfy-cowork/doc/prompt', {
      sessionId: session,
      prompt: 'a red apple on linen',
      manual: true,
      source: 'user',
    }))
    assert.equal(res.status, 200)
    assert.equal((await store.snapshot(session)).prompt, 'a red apple on linen')
  } finally {
    await cleanup()
  }
})

test('answers the client heartbeat', async () => {
  const { routes, cleanup } = await makeRoutes()
  try {
    const res = await call(routes, makeReq('POST', '/api/comfy-cowork/client-hello', { build: 'test' }))
    assert.equal(res.status, 200)
    const health = await call(routes, makeReq('GET', '/api/comfy-cowork/health'))
    assert.equal(JSON.parse(health.body).client.build, 'test')
  } finally {
    await cleanup()
  }
})

test('queues a run whose session id is only in the body', async () => {
  const { routes, cleanup } = await makeRoutes()
  try {
    const res = await call(routes, makeReq('POST', '/api/comfy-cowork/run', {
      sessionId: 'session-run-body',
      seed: 7,
    }))
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.body).run.id, 'run-test')
  } finally {
    await cleanup()
  }
})

test('forwards the canvas repaint strength with a run', async () => {
  const { routes, runCalls, cleanup } = await makeRoutes()
  try {
    const res = await call(routes, makeReq('POST', '/api/comfy-cowork/run', {
      sessionId: 'session-run-strength',
      denoise: 0.65,
    }))
    assert.equal(res.status, 200)
    assert.equal(runCalls[0].overrides.denoise, 0.65)
    // A value that is not a number is dropped instead of reaching the sampler.
    await call(routes, makeReq('POST', '/api/comfy-cowork/run', {
      sessionId: 'session-run-strength',
      denoise: 'high',
    }))
    assert.equal(runCalls[1].overrides.denoise, undefined)
  } finally {
    await cleanup()
  }
})

test('stores the negative prompt separately from the canvas prompt', async () => {
  const { routes, store, cleanup } = await makeRoutes()
  try {
    const session = 'session-negative'
    await store.setPrompt(session, 'a red apple on linen', { source: 'agent' })
    const res = await call(routes, makeReq('PUT', '/api/comfy-cowork/doc/negative', {
      sessionId: session,
      negative: 'blurry, watermark',
    }))
    assert.equal(res.status, 200)
    const doc = JSON.parse(res.body).doc
    assert.equal(doc.negative, 'blurry, watermark')
    assert.equal(doc.prompt, 'a red apple on linen')
    assert.equal((await store.snapshot(session)).negative, 'blurry, watermark')
  } finally {
    await cleanup()
  }
})

test('writes and deletes a canvas comment (session in body then query)', async () => {
  const { routes, store, cleanup } = await makeRoutes()
  try {
    const session = 'session-route-comments'
    const put = await call(routes, makeReq('PUT', '/api/comfy-cowork/doc/comment', {
      sessionId: session,
      comment: { bbox: [10, 10, 200, 200], text: '这个图不行 这里细节不好' },
      source: 'user',
    }))
    assert.equal(put.status, 200)
    let body = JSON.parse(put.body)
    assert.equal(body.sessionId, session)
    assert.equal(body.doc.comments.length, 1)
    assert.equal(body.doc.comments[0].source, 'user')
    assert.equal(body.doc.comments[0].text, '这个图不行 这里细节不好')
    const id = body.doc.comments[0].id

    // The comment object may also arrive at the top level; the session comes from the query.
    const update = await call(routes, makeReq('PUT', `/api/comfy-cowork/doc/comment?session=${session}`, {
      id,
      bbox: [20, 20, 220, 220],
      text: '把手指改好',
    }))
    assert.equal(update.status, 200)
    body = JSON.parse(update.body)
    assert.equal(body.doc.comments.length, 1)
    assert.deepEqual(body.doc.comments[0].bbox, [20, 20, 220, 220])
    assert.equal(body.doc.comments[0].text, '把手指改好')
    assert.equal(body.doc.comments[0].source, 'user')

    const invalid = await call(routes, makeReq('PUT', '/api/comfy-cowork/doc/comment', {
      sessionId: session,
      comment: { bbox: [0, 0], text: 'bad' },
    }))
    assert.equal(invalid.status, 400)
    assert.match(JSON.parse(invalid.body).error, /bbox/)

    const remove = await call(routes, makeReq('DELETE', `/api/comfy-cowork/doc/comment/${encodeURIComponent(id)}?session=${session}`))
    assert.equal(remove.status, 200)
    body = JSON.parse(remove.body)
    assert.deepEqual(body.doc.comments, [])
    assert.deepEqual((await store.snapshot(session)).comments, [])

    const again = await call(routes, makeReq('DELETE', `/api/comfy-cowork/doc/comment/${encodeURIComponent(id)}?session=${session}`))
    assert.equal(again.status, 200)
    assert.deepEqual(JSON.parse(again.body).doc.comments, [])
  } finally {
    await cleanup()
  }
})

test('rejects a canvas comment write the connection does not admit', async () => {
  const { routes, store, cleanup } = await makeRoutes({ rejection: 401 })
  try {
    const res = await call(routes, makeReq('PUT', '/api/comfy-cowork/doc/comment', {
      sessionId: 'session-comment-denied',
      comment: { bbox: [0, 0, 10, 10], text: 'nope' },
    }))
    assert.equal(res.status, 401)
    await assert.rejects(fs.access(path.join(store.sessionDir('session-comment-denied'), 'document.json')))
  } finally {
    await cleanup()
  }
})

test('stores the session enable switch', async () => {
  const { routes, cleanup } = await makeRoutes()
  try {
    const session = 'session-enable-route'
    const on = await call(routes, makeReq('PUT', '/api/comfy-cowork/doc/enabled', { sessionId: session, enabled: true }))
    assert.equal(on.status, 200)
    assert.equal(JSON.parse(on.body).doc.enabled, true)
    const off = await call(routes, makeReq('PUT', '/api/comfy-cowork/doc/enabled?session=' + session, { enabled: false }))
    assert.equal(off.status, 200)
    assert.equal(JSON.parse(off.body).doc.enabled, false)
    assert.equal(JSON.parse(off.body).doc.toolsPinned, true, 'a normal close keeps the tools')
  } finally {
    await cleanup()
  }
})

test('saves the ComfyUI address in the workspace and reports it back', async () => {
  const root = await fs.mkdtemp(path.join(process.cwd(), 'tests/.tmp-routes-'))
  const ctx = {
    logger: { warn() {} },
    sessions: { get: () => undefined },
    workingDirectory: { defaultDirectory: root },
    connection: { admit: () => ({ peer: { id: 'peer-1' } }) },
  }
  const config = normalizeConfig({})
  const store = new DocStore(ctx, config)
  const workspaceConfig = new WorkspaceConfig(config)
  const hooks = { setBaseUrl: async (sessionId, raw) => { const url = await workspaceConfig.write(store.resolveRoot(sessionId), raw); config.baseUrl = url; return url } }
  const routes = createRoutes({ ctx, config, store, hooks, workspaceConfig })
  try {
    const session = 'session-config-route'
    const saved = await call(routes, makeReq('PUT', '/api/comfy-cowork/config', { sessionId: session, baseUrl: 'http://127.0.0.1:9199/' }))
    assert.equal(saved.status, 200)
    assert.equal(JSON.parse(saved.body).baseUrl, 'http://127.0.0.1:9199')
    const file = JSON.parse(await fs.readFile(path.join(root, '.comfy-cowork', 'config.json'), 'utf8'))
    assert.equal(file.baseUrl, 'http://127.0.0.1:9199')

    const read = await call(routes, makeReq('GET', `/api/comfy-cowork/config?session=${session}`))
    assert.equal(JSON.parse(read.body).baseUrl, 'http://127.0.0.1:9199')

    const rejected = await call(routes, makeReq('PUT', '/api/comfy-cowork/config', { sessionId: session, baseUrl: 'not a url' }))
    assert.equal(rejected.status, 400)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('enabling in a chat with history asks before attaching the tools', async () => {
  const root = await fs.mkdtemp(path.join(process.cwd(), 'tests/.tmp-routes-'))
  const ctx = {
    logger: { warn() {} },
    sessions: { get: () => undefined },
    workingDirectory: { defaultDirectory: root },
    connection: { admit: () => ({ peer: { id: 'peer-1' } }) },
  }
  const config = normalizeConfig({})
  const store = new DocStore(ctx, config)
  const hooks = { historyCount: () => ({ messages: 12, tokens: 24000 }), sync: async () => {} }
  const routes = createRoutes({ ctx, config, store, hooks })
  try {
    const session = 'session-enable-guard'
    const guarded = await call(routes, makeReq('PUT', '/api/comfy-cowork/doc/enabled', { sessionId: session, enabled: true }))
    assert.equal(guarded.status, 200)
    const body = JSON.parse(guarded.body)
    assert.equal(body.needsConfirmation, true)
    assert.equal(body.messages, 12)
    assert.equal(body.tokens, 24000, 'the warning quotes the context it would re-send')
    assert.equal(body.doc.enabled, false, 'nothing changes until the user confirms')

    const confirmed = await call(routes, makeReq('PUT', '/api/comfy-cowork/doc/enabled', { sessionId: session, enabled: true, confirm: true }))
    assert.equal(JSON.parse(confirmed.body).doc.enabled, true)
    assert.equal(JSON.parse(confirmed.body).doc.toolsPinned, true)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('a fresh chat enables without asking', async () => {
  const root = await fs.mkdtemp(path.join(process.cwd(), 'tests/.tmp-routes-'))
  const ctx = {
    logger: { warn() {} },
    sessions: { get: () => undefined },
    workingDirectory: { defaultDirectory: root },
    connection: { admit: () => ({ peer: { id: 'peer-1' } }) },
  }
  const config = normalizeConfig({})
  const store = new DocStore(ctx, config)
  const routes = createRoutes({ ctx, config, store, hooks: { historyCount: () => ({ messages: 0, tokens: null }) } })
  try {
    const session = 'session-enable-fresh'
    const on = await call(routes, makeReq('PUT', '/api/comfy-cowork/doc/enabled', { sessionId: session, enabled: true }))
    const body = JSON.parse(on.body)
    assert.equal(body.needsConfirmation, undefined)
    assert.equal(body.doc.enabled, true)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('the unload route drops the pin and tells the host to detach', async () => {
  const root = await fs.mkdtemp(path.join(process.cwd(), 'tests/.tmp-routes-'))
  const ctx = {
    logger: { warn() {} },
    sessions: { get: () => undefined },
    workingDirectory: { defaultDirectory: root },
    connection: { admit: () => ({ peer: { id: 'peer-1' } }) },
  }
  const config = normalizeConfig({})
  const store = new DocStore(ctx, config)
  const synced = []
  const hooks = { sync: async (sessionId, doc) => { synced.push({ sessionId, enabled: doc.enabled, pinned: doc.toolsPinned }) } }
  const routes = createRoutes({ ctx, config, store, hooks })
  try {
    const session = 'session-unload-route'
    await call(routes, makeReq('PUT', '/api/comfy-cowork/doc/enabled', { sessionId: session, enabled: true }))
    const unloaded = await call(routes, makeReq('PUT', '/api/comfy-cowork/doc/unload', { sessionId: session }))
    assert.equal(unloaded.status, 200)
    const doc = JSON.parse(unloaded.body).doc
    assert.equal(doc.enabled, false)
    assert.equal(doc.toolsPinned, false)
    assert.deepEqual(synced.at(-1), { sessionId: session, enabled: false, pinned: false })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('stores the local repaint prompt on the mask route', async () => {
  const { routes, store, cleanup } = await makeRoutes()
  try {
    const session = 'session-mask-prompt-route'
    await store.setPrompt(session, 'a whole-image description', { source: 'user' })
    const res = await call(routes, makeReq('PUT', '/api/comfy-cowork/doc/mask-prompt', {
      sessionId: session,
      prompt: 'yellow hair, single ponytail',
    }))
    assert.equal(res.status, 200)
    const doc = JSON.parse(res.body).doc
    assert.equal(doc.mask.prompt, 'yellow hair, single ponytail')
    assert.equal(doc.mask.promptSource, 'user')
    assert.equal(doc.prompt, 'a whole-image description')
    assert.equal((await store.snapshot(session)).mask.prompt, 'yellow hair, single ponytail')
  } finally {
    await cleanup()
  }
})
