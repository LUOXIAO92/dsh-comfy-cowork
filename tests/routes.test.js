import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { DocStore } from '../lib/store.js'
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
  }
  const runManager = {}
  const routes = createRoutes({ ctx, config, store, comfy, runManager })
  return { routes, store, cleanup: () => fs.rm(root, { recursive: true, force: true }) }
}

async function call(routes, req) {
  const res = makeRes()
  await routes.handle(req, res)
  return res
}

test('rejects a request the connection does not admit', async () => {
  const { routes, cleanup } = await makeRoutes({ rejection: 403 })
  try {
    const res = await call(routes, makeReq('GET', '/api/comfy-coworking/health'))
    assert.equal(res.status, 403)
  } finally {
    await cleanup()
  }
})

test('answers health for an admitted browser peer', async () => {
  const { routes, cleanup } = await makeRoutes()
  try {
    const res = await call(routes, makeReq('GET', '/api/comfy-coworking/health'))
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
    const res = await call(routes, makeReq('PUT', `/api/comfy-coworking/doc/selection?session=${session}`, {
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
    const res = await call(routes, makeReq('PUT', '/api/comfy-coworking/doc/canvas', {
      sessionId: null,
      mode: 'image',
    }))
    assert.equal(res.status, 400)
    assert.match(JSON.parse(res.body).error, /a valid session id is required/)
    const health = await call(routes, makeReq('GET', '/api/comfy-coworking/health'))
    const errors = JSON.parse(health.body).errors
    assert.equal(errors.length, 1)
    assert.match(errors[0].request, /PUT \/api\/comfy-coworking\/doc\/canvas/)
  } finally {
    await cleanup()
  }
})

test('refuses the literal undefined session instead of creating one', async () => {
  const { routes, store, cleanup } = await makeRoutes()
  try {
    const res = await call(routes, makeReq('PUT', '/api/comfy-coworking/doc/canvas?session=undefined', { mode: 'image' }))
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
    const res = await call(routes, makeReq('PUT', '/api/comfy-coworking/doc/canvas', {
      sessionId: session,
      mode: 'image',
      mask: { feather: 12, grow: 2, inverted: false, visible: true, color: '#ff3b30', opacity: 0.45, rev: 1, hasMask: true },
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
    const res = await call(routes, makeReq('PUT', '/api/comfy-coworking/doc/prompt', {
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
