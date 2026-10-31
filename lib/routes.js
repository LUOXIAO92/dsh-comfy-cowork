/** HTTP surface for the browser half. Every writer goes through DocStore. */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { DEFAULTS, errorMessage, isAssetName, isSessionId, jsonResponse, ROUTE_PREFIX } from './config.js'

/** The installed package version, read once: the health payload must not drift from package.json. */
const PACKAGE_VERSION = (() => {
  try {
    const manifest = new URL('../package.json', import.meta.url)
    return JSON.parse(readFileSync(manifest, 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()
import { publicDoc } from './doc.js'
import { inferBindings } from './workflow.js'

const MAX_JSON_BYTES = 4 * 1024 * 1024

function contentTypeFor(name) {
  const ext = path.extname(name).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.json') return 'application/json; charset=utf-8'
  if (ext === '.txt') return 'text/plain; charset=utf-8'
  if (ext === '.mp4') return 'video/mp4'
  if (ext === '.webm') return 'video/webm'
  return 'application/octet-stream'
}

async function readBody(req, limit = MAX_JSON_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw Object.assign(new Error('request body is too large'), { status: 413 })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readJson(req) {
  const buffer = await readBody(req)
  if (buffer.length === 0) return {}
  const text = buffer.toString('utf8')
  // Kept only so a rejected write can name what it actually sent.
  req.ccwBody = text.slice(0, 300)
  try {
    return JSON.parse(text)
  } catch {
    throw Object.assign(new Error('request body must be JSON'), { status: 400 })
  }
}

function sessionFrom(url, body) {
  const value = body?.sessionId ?? url.searchParams.get('session')
  if (!isSessionId(value)) {
    const shown = typeof value === 'string' ? JSON.stringify(value.slice(0, 80)) : String(value)
    throw Object.assign(new Error(`a valid session id is required (received ${shown ?? 'undefined'})`), { status: 400 })
  }
  return value
}

function methodNotAllowed(res, allow) {
  res.writeHead(405, { allow, 'content-type': 'text/plain; charset=utf-8' })
  res.end(`method not allowed; use ${allow}`)
}

export function createRoutes({ ctx, config, store, comfy, runManager, hooks = {}, workspaceConfig = null, modelCatalog = null, workflowIndex = null }) {
  const sseClients = new Map()
  const diagnostics = { clientHello: null, errors: [] }

  /** Keep the last failing browser requests so a red banner can be traced without server logs. */
  function recordError(req, status, message) {
    diagnostics.errors.unshift({
      at: Date.now(),
      request: `${req.method ?? 'GET'} ${req.url ?? ''}`.slice(0, 400),
      status,
      error: String(message).slice(0, 400),
      body: typeof req.ccwBody === 'string' ? req.ccwBody : '',
      build: typeof req.headers?.['x-ccw-build'] === 'string' ? req.headers['x-ccw-build'] : '',
    })
    if (diagnostics.errors.length > 20) diagnostics.errors.length = 20
  }


  /** The workspace a request works against: the session's, or the default one. */
  function workspaceRoot(url, body = null) {
    const value = body?.sessionId ?? url.searchParams.get('session')
    if (isSessionId(value)) return store.resolveRoot(value)
    return ctx.workingDirectory?.defaultDirectory
  }

  function sendDoc(res, doc) {
    jsonResponse(res, 200, { sessionId: doc.sessionId, doc: publicDoc(doc) })
  }

  /**
   * Admit one browser request through the Connection service: it checks the
   * loopback Host/Origin trust fence and the signed browser cookie, so a
   * cross-site page cannot drive ComfyUI through this plugin. Requests that
   * fail are answered here and never reach a route.
   */
  function admit(req, res) {
    let connection
    try {
      connection = ctx.connection
    } catch {
      jsonResponse(res, 503, {
        error: 'comfy-cowork host plugin was loaded without the connection service; reload the plugin',
      })
      return false
    }
    if (connection === undefined || typeof connection.admit !== 'function') {
      jsonResponse(res, 503, {
        error: 'comfy-cowork host plugin was loaded without the connection service; reload the plugin',
      })
      return false
    }
    const result = connection.admit({ headers: req.headers })
    if (result !== undefined && result.peer !== undefined) return true
    const status = result?.rejection === 403 ? 403 : 401
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(status === 403 ? 'Forbidden' : 'Unauthorized')
    return false
  }

  async function handleAsset(req, res, url) {
    const sessionId = sessionFrom(url)
    const name = url.searchParams.get('name')
    if (!isAssetName(name)) throw Object.assign(new Error('invalid asset name'), { status: 400 })
    if (req.method === 'GET' || req.method === 'HEAD') {
      await store.ready(sessionId)
      const target = store.assetPath(sessionId, name)
      let data
      try {
        data = await fs.readFile(target)
      } catch (error) {
        if (error?.code === 'ENOENT') throw Object.assign(new Error(`asset not found: ${name}`), { status: 404 })
        throw error
      }
      res.writeHead(200, {
        'content-type': contentTypeFor(name),
        'content-length': data.length,
        'cache-control': 'no-store',
      })
      if (req.method === 'HEAD') res.end()
      else res.end(data)
      return
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      const buffer = await readBody(req, config.maxAssetBytes + 1024)
      await store.saveAsset(sessionId, name, buffer)
      jsonResponse(res, 200, { sessionId, name, bytes: buffer.length })
      return
    }
    if (req.method === 'DELETE') {
      const deleted = await store.deleteAsset(sessionId, name)
      jsonResponse(res, 200, { sessionId, name, deleted })
      return
    }
    methodNotAllowed(res, 'GET, HEAD, PUT, POST, DELETE')
  }

  function handleEvents(req, res, url) {
    const sessionId = sessionFrom(url)
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write('retry: 2000\n\n')
    const unsubscribe = store.subscribe(sessionId, res)
    const heartbeat = setInterval(() => {
      try {
        res.write(`: ping ${Date.now()}\n\n`)
      } catch {}
    }, 15_000)
    const cleanup = () => {
      clearInterval(heartbeat)
      unsubscribe()
      const current = sseClients.get(sessionId)
      if (current !== undefined) {
        current.delete(cleanup)
        if (current.size === 0) sseClients.delete(sessionId)
      }
    }
    let set = sseClients.get(sessionId)
    if (set === undefined) {
      set = new Set()
      sseClients.set(sessionId, set)
    }
    set.add(cleanup)
    req.on('close', cleanup)
    req.on('error', cleanup)
    store.snapshot(sessionId).then((doc) => {
      if (!res.writableEnded) res.write(`event: hello\ndata: ${JSON.stringify({ type: 'hello', doc })}\n\n`)
    }).catch((error) => {
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', message: errorMessage(error) })}\n\n`)
      } catch {}
    })
  }

  async function handleHealth(res) {
    let stats = null
    let error = null
    try {
      stats = await comfy.systemStats()
    } catch (caught) {
      error = errorMessage(caught)
    }
    jsonResponse(res, 200, {
      ok: true,
      baseUrl: config.baseUrl,
      version: PACKAGE_VERSION,
      client: diagnostics.clientHello,
      scoped: typeof diagnostics.scopedSessions === 'function' ? diagnostics.scopedSessions() : [],
      errors: diagnostics.errors.slice(0, 10),
      comfy: stats === null
        ? { connected: false, error }
        : {
            connected: true,
            version: stats?.system?.comfyui_version ?? null,
            os: stats?.system?.os ?? null,
            devices: Array.isArray(stats?.devices) ? stats.devices.map((d) => ({ name: d.name, vram_total: d.vram_total, vram_free: d.vram_free })) : [],
          },
    })
  }

  async function handleDoc(req, res, url, sub) {
    // Every write carries its session id in the JSON body; only reads and
    // deletes put it in the query string. Read the body once here so the
    // session check sees the same value the handler writes with, and so a
    // second read never consumes an already-drained stream.
    const body = req.method === 'PUT' || req.method === 'POST' ? await readJson(req) : {}
    const sessionId = sessionFrom(url, body)
    // Follow the workspace's saved ComfyUI address before any work that may
    // reach it, so a port change applies to the very next request.
    try {
      await hooks.activate?.(sessionId)
    } catch {}
    if (req.method === 'GET' && sub === '/doc') {
      const doc = await store.snapshot(sessionId)
      sendDoc(res, doc)
      return
    }
    if (req.method === 'PUT' && sub === '/doc/prompt') {
      const doc = await store.setPrompt(sessionId, body.prompt, { source: body.source ?? 'user', manual: body.manual !== false })
      sendDoc(res, doc)
      return
    }
    if (req.method === 'PUT' && sub === '/doc/negative') {
      const doc = await store.setNegative(sessionId, body.negative, { source: body.source ?? 'user' })
      sendDoc(res, doc)
      return
    }
    if (req.method === 'PUT' && sub === '/doc/layout') {
      const doc = await store.setLayout(sessionId, { summary: body.summary, items: body.items }, { source: body.source ?? 'user' })
      sendDoc(res, doc)
      return
    }
    if (req.method === 'PUT' && sub === '/doc/canvas') {
      const doc = await store.setCanvas(sessionId, body, { source: body.source ?? 'user' })
      sendDoc(res, doc)
      return
    }
    if (req.method === 'PUT' && sub === '/doc/enabled') {
      const enabled = body.enabled === true
      if (enabled) {
        // Attaching the tools rewrites the request prefix, so a chat that
        // already has history pays one full-context cache miss. Ask first,
        // quoting the history the model would actually re-read.
        const current = await store.snapshot(sessionId)
        const history = hooks.historyCount?.(sessionId) ?? { messages: 0, tokens: null }
        const messages = typeof history === 'number' ? history : Number(history.messages) || 0
        const tokens = typeof history === 'number' ? null : history.tokens ?? null
        if (current.toolsPinned !== true && messages > 0 && body.confirm !== true) {
          jsonResponse(res, 200, { sessionId, doc: publicDoc(current), needsConfirmation: true, messages, tokens })
          return
        }
      }
      const doc = await store.setEnabled(sessionId, enabled, { source: body.source ?? 'user' })
      try {
        await hooks.sync?.(sessionId, doc)
      } catch (error) {
        recordError(req, 500, errorMessage(error))
      }
      sendDoc(res, doc)
      return
    }
    if (req.method === 'PUT' && sub === '/doc/unload') {
      const doc = await store.unloadTools(sessionId, { source: body.source ?? 'user' })
      try {
        await hooks.sync?.(sessionId, doc)
      } catch (error) {
        recordError(req, 500, errorMessage(error))
      }
      sendDoc(res, doc)
      return
    }
    if (req.method === 'PUT' && sub === '/doc/selection') {
      const doc = await store.setSelection(sessionId, body.selection ?? null, { source: body.source ?? 'user' })
      sendDoc(res, doc)
      return
    }
    if (req.method === 'PUT' && sub === '/doc/workflow') {
      const doc = await store.setWorkflow(sessionId, body.workflow ?? null, { source: body.source ?? 'user' })
      sendDoc(res, doc)
      return
    }
    if (req.method === 'PUT' && sub === '/doc/workflow/patch') {
      const doc = await store.patchWorkflow(sessionId, body.patch ?? {}, { source: body.source ?? 'user' })
      sendDoc(res, doc)
      return
    }
    if (req.method === 'PUT' && sub === '/doc/box') {
      const doc = await store.upsertBox(sessionId, body.box ?? body, { source: body.source ?? 'user' })
      sendDoc(res, doc)
      return
    }
    if (req.method === 'DELETE' && sub.startsWith('/doc/box/')) {
      const id = decodeURIComponent(sub.slice('/doc/box/'.length))
      const doc = await store.removeBox(sessionId, id, { source: 'user' })
      sendDoc(res, doc)
      return
    }
    if (req.method === 'PUT' && sub === '/doc/comment') {
      const payload = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {}
      const raw = payload.comment ?? payload
      const comment = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
      const doc = await store.upsertComment(sessionId, {
        ...comment,
        source: comment.source ?? payload.source ?? 'user',
      }, { source: payload.source ?? 'user' })
      sendDoc(res, doc)
      return
    }
    if (req.method === 'DELETE' && sub.startsWith('/doc/comment/')) {
      const id = decodeURIComponent(sub.slice('/doc/comment/'.length))
      const doc = await store.removeComment(sessionId, id, { source: 'user' })
      sendDoc(res, doc)
      return
    }
    if (req.method === 'POST' && sub === '/doc/notify') {
      const doc = await store.notify(sessionId, { text: String(body.text ?? ''), kind: body.kind ?? 'info' }, { source: 'user' })
      sendDoc(res, doc)
      return
    }
    methodNotAllowed(res, 'GET, PUT, DELETE, POST')
  }

  async function handle(req, res) {
    try {
      if (!admit(req, res)) return
      const url = new URL(req.url ?? '/', 'http://comfy-cowork.invalid')
      const sub = url.pathname.startsWith(ROUTE_PREFIX)
        ? url.pathname.slice(ROUTE_PREFIX.length) || '/'
        : url.pathname

      if (sub === '/health' && (req.method === 'GET' || req.method === 'HEAD')) return await handleHealth(res)
      if (sub === '/client-hello' && req.method === 'POST') {
        const body = await readJson(req)
          diagnostics.clientHello = { ...(diagnostics.clientHello ?? {}), ...body, at: Date.now() }
        jsonResponse(res, 200, { ok: true })
        return
      }
      if (sub === '/events' && req.method === 'GET') return handleEvents(req, res, url)
      if (sub === '/asset') return await handleAsset(req, res, url)
      if (sub === '/doc' || sub.startsWith('/doc/')) return await handleDoc(req, res, url, sub)

      if (sub === '/config' && req.method === 'GET') {
        const requested = url.searchParams.get('session')
        const root = isSessionId(requested) ? store.resolveRoot(requested) : ctx.workingDirectory?.defaultDirectory
        const stored = workspaceConfig !== null && typeof root === 'string' ? await workspaceConfig.read(root) : config.baseUrl
        jsonResponse(res, 200, { baseUrl: config.baseUrl, stored, default: DEFAULTS.baseUrl })
        return
      }
      if (sub === '/config' && req.method === 'PUT') {
        const body = await readJson(req)
        const sessionId = sessionFrom(url, body)
        if (!isSessionId(sessionId)) {
          jsonResponse(res, 400, { error: 'a session is required to save the ComfyUI address' })
          return
        }
        try {
          const baseUrl = await hooks.setBaseUrl?.(sessionId, body.baseUrl)
          if (typeof baseUrl !== 'string') throw new Error('the workspace settings store is unavailable')
          store.broadcastAll({ type: 'config', baseUrl })
          jsonResponse(res, 200, { baseUrl })
        } catch (error) {
          jsonResponse(res, 400, { error: errorMessage(error) })
        }
        return
      }
      if (sub === '/models' && req.method === 'GET') {
        const root = workspaceRoot(url)
        const { snapshot } = await modelCatalog.ensure(root, comfy)
        jsonResponse(res, 200, {
          updatedAt: snapshot.updatedAt,
          stale: modelCatalog.stale(root, snapshot) || (modelCatalog.errors.get(root) ?? '') !== '',
          folders: modelCatalog.folders(snapshot),
        })
        return
      }
      if (sub === '/models/refresh' && req.method === 'POST') {
        const root = workspaceRoot(url)
        const snapshot = await modelCatalog.refresh(root, comfy)
        jsonResponse(res, 200, {
          updatedAt: snapshot.updatedAt,
          folders: modelCatalog.folders(snapshot),
        })
        return
      }
      if (sub.startsWith('/models/') && req.method === 'GET') {
        const folder = decodeURIComponent(sub.slice('/models/'.length))
        const root = workspaceRoot(url)
        const { snapshot } = await modelCatalog.ensure(root, comfy)
        jsonResponse(res, 200, {
          ...modelCatalog.files(snapshot, folder, {
            query: url.searchParams.get('q') ?? '',
            offset: Number(url.searchParams.get('offset') ?? '0'),
            limit: Number(url.searchParams.get('limit') ?? '200'),
          }),
          updatedAt: snapshot.updatedAt,
        })
        return
      }
      if (sub === '/workflows' && req.method === 'GET') {
        const root = workspaceRoot(url)
        const index = await workflowIndex.build(root, comfy)
        jsonResponse(res, 200, { workflows: index.entries, updatedAt: index.updatedAt, stale: index.stale, error: index.error })
        return
      }
      if (sub === '/workflows/save' && req.method === 'POST') {
        const body = await readJson(req)
        const root = workspaceRoot(url, body)
        if (typeof workflowIndex?.save === 'function') {
          const target = body.target === 'comfyui' ? 'comfyui' : 'workspace'
          const result = await workflowIndex.save(root, comfy, body.name, body.workflow, { target })
          if (isSessionId(body.sessionId)) {
            const doc = await store.patchWorkflow(body.sessionId, {
              name: result.entry?.name ?? body.name,
              json: body.workflow,
              dirty: false,
            }, { source: 'user' })
            jsonResponse(res, 200, { name: result.entry?.name ?? body.name, target, doc })
          } else {
            jsonResponse(res, 200, { name: result.entry?.name ?? body.name, target })
          }
          return
        }
        const result = await comfy.saveWorkflow(body.name, body.workflow)
        if (isSessionId(body.sessionId)) {
          const doc = await store.patchWorkflow(body.sessionId, {
            name: result.name,
            json: body.workflow,
            dirty: false,
          }, { source: 'user' })
          jsonResponse(res, 200, { ...result, doc })
        } else {
          jsonResponse(res, 200, result)
        }
        return
      }
      if (sub === '/workflows/load' && req.method === 'POST') {
        const body = await readJson(req)
        const sessionId = sessionFrom(url, body)
        const root = workspaceRoot(url, body)
        const index = await workflowIndex.build(root, comfy)
        const entry = workflowIndex.find(index, body.id ?? body.name)
        if (entry === null) {
          jsonResponse(res, 404, { error: `no workflow matches ${JSON.stringify(body.id ?? body.name ?? '')}` })
          return
        }
        const workflow = await workflowIndex.load(root, comfy, entry)
        let bindings = {}
        try {
          bindings = inferBindings(workflow, await comfy.objectInfo())
        } catch {}
        const doc = await store.setWorkflow(sessionId, {
          name: entry.name,
          json: workflow,
          bindings,
          dirty: false,
        }, { source: 'user' })
        sendDoc(res, doc)
        return
      }
      if (sub === '/run' && req.method === 'POST') {
        const body = await readJson(req)
        const sessionId = sessionFrom(url, body)
        const result = await runManager.start(sessionId, {
          bindings: body.bindings,
          seed: body.seed,
        }, { agent: false })
        jsonResponse(res, 200, { run: result.run })
        return
      }
      if (sub.startsWith('/run/') && sub.endsWith('/interrupt') && req.method === 'POST') {
        const body = await readJson(req)
        const sessionId = sessionFrom(url, body)
        const id = decodeURIComponent(sub.slice('/run/'.length, -'/interrupt'.length))
        const run = await runManager.interrupt(sessionId, id)
        jsonResponse(res, 200, { run })
        return
      }
      if (sub.startsWith('/workflows/') && req.method === 'GET') {
        const id = decodeURIComponent(sub.slice('/workflows/'.length))
        const root = workspaceRoot(url)
        const index = await workflowIndex.build(root, comfy)
        const entry = workflowIndex.find(index, id)
        if (entry === null) {
          jsonResponse(res, 404, { error: `no workflow matches ${JSON.stringify(id)}` })
          return
        }
        jsonResponse(res, 200, { id: entry.id, name: entry.name, source: entry.source, workflow: await workflowIndex.load(root, comfy, entry) })
        return
      }
      if (sub === '/object_info' && req.method === 'GET') {
        const classes = (url.searchParams.get('classes') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
        const data = classes.length > 0 ? await comfy.nodeInfo(classes) : await comfy.objectInfo()
        jsonResponse(res, 200, { nodes: data })
        return
      }
      if (sub === '/view' && req.method === 'GET') {
        const asset = await comfy.view({
          filename: url.searchParams.get('filename') ?? '',
          subfolder: url.searchParams.get('subfolder') ?? '',
          type: url.searchParams.get('type') ?? 'output',
        })
        res.writeHead(200, {
          'content-type': asset.contentType,
          'content-length': asset.buffer.length,
          'cache-control': 'no-store',
        })
        res.end(asset.buffer)
        return
      }

      jsonResponse(res, 404, { error: `no route for ${req.method} ${sub}` })
    } catch (error) {
      const status = Number(error?.status) || 500
      recordError(req, status, errorMessage(error))
      if (!res.headersSent) {
        jsonResponse(res, status, { error: errorMessage(error), status })
      } else {
        try {
          res.end()
        } catch {}
      }
    }
  }

  return { handle, close: () => sseClients.clear(), diagnostics }
}
