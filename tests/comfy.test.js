import test from 'node:test'
import assert from 'node:assert/strict'
import { ComfyClient, ComfyError } from '../lib/comfy.js'

const BASE_URL = 'http://127.0.0.1:8188'

const CHECKPOINT = { display_name: 'Load Checkpoint', category: 'loaders', description: 'Loads a checkpoint.' }
const KSAMPLER = { display_name: 'KSampler', category: 'sampling', description: 'Samples a latent.' }

function makeClient() {
  return new ComfyClient({ baseUrl: BASE_URL, requestTimeoutMs: 5000 })
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Replace global fetch for one test, restore it afterwards, and record every request. */
function stubFetch(t, handler) {
  const original = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, options) => {
    const pathname = new URL(String(url)).pathname
    requests.push({ url: String(url), pathname, options })
    return handler({ url: String(url), pathname, options })
  }
  t.after(() => {
    globalThis.fetch = original
  })
  return requests
}

test('nodeInfo asks for one class at a time and omits unknown classes', async (t) => {
  const requests = stubFetch(t, ({ pathname }) => {
    if (pathname === '/object_info/CheckpointLoaderSimple') return jsonResponse({ CheckpointLoaderSimple: CHECKPOINT })
    if (pathname === '/object_info/KSampler') return jsonResponse({ KSampler: KSAMPLER })
    if (pathname === '/object_info/Nope') return jsonResponse({})
    return jsonResponse({ error: `unexpected request ${pathname}` }, 500)
  })

  const info = await makeClient().nodeInfo(['CheckpointLoaderSimple', 'KSampler', 'Nope'])

  assert.deepEqual(info, { CheckpointLoaderSimple: CHECKPOINT, KSampler: KSAMPLER })
  assert.deepEqual(requests.map((request) => request.pathname).sort(), [
    '/object_info/CheckpointLoaderSimple',
    '/object_info/KSampler',
    '/object_info/Nope',
  ])
  assert.equal(requests.some((request) => request.pathname === '/object_info'), false)
})

test('a per-class 404 falls back once to the filtered full dump', async (t) => {
  const fullDump = {
    CheckpointLoaderSimple: CHECKPOINT,
    KSampler: KSAMPLER,
    MOSSImageLayout: { display_name: 'MOSS Image Layout', category: 'moss' },
  }
  const requests = stubFetch(t, ({ pathname }) => {
    if (pathname.startsWith('/object_info/')) return jsonResponse({ error: 'no such route' }, 404)
    if (pathname === '/object_info') return jsonResponse(fullDump)
    return jsonResponse({ error: `unexpected request ${pathname}` }, 500)
  })

  const info = await makeClient().nodeInfo(['KSampler', 'NoSuchNode'])

  assert.deepEqual(info, { KSampler: KSAMPLER })
  assert.ok(requests.some((request) => request.pathname === '/object_info/KSampler'))
  assert.equal(requests.filter((request) => request.pathname === '/object_info').length, 1)
})

test('nodeInfo dedupes names, skips blanks, and makes no request for an empty list', async (t) => {
  const requests = stubFetch(t, ({ pathname }) => {
    const name = decodeURIComponent(pathname.slice('/object_info/'.length))
    return jsonResponse({ [name]: { display_name: name, category: 'test' } })
  })
  const comfy = makeClient()

  assert.deepEqual(await comfy.nodeInfo([]), {})
  assert.deepEqual(await comfy.nodeInfo(['', '', null]), {})
  assert.deepEqual(requests, [])

  const info = await comfy.nodeInfo(['KSampler', '', 'KSampler', 42])
  assert.deepEqual(requests.map((request) => request.pathname), ['/object_info/KSampler'])
  assert.deepEqual(info, { KSampler: { display_name: 'KSampler', category: 'test' } })
})

test('a non-404 failure propagates and never triggers the full dump', async (t) => {
  const requests = stubFetch(t, ({ pathname }) => {
    if (pathname === '/object_info/KSampler') return jsonResponse({ error: 'boom' }, 500)
    return jsonResponse({ error: `unexpected request ${pathname}` }, 500)
  })

  await assert.rejects(makeClient().nodeInfo(['KSampler']), (error) => {
    assert.ok(error instanceof ComfyError)
    assert.equal(error.status, 500)
    return true
  })
  assert.equal(requests.some((request) => request.pathname === '/object_info'), false)
})
