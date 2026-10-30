/**
 * One authoritative document per session, persisted in the session workspace.
 *
 * All writers (browser routes and agent tools) go through mutate(), which
 * serializes writes per session and broadcasts the new revision over SSE.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { compileDocPrompt, newDoc, normalizeDoc, publicDoc } from './doc.js'

const DOC_FILE = 'document.json'

export class DocStore {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.cache = new Map()
    this.queues = new Map()
    this.listeners = new Map()
  }

  resolveBaseDir(sessionId) {
    const session = this.ctx.sessions?.get?.(sessionId)
    let cwd
    try {
      cwd = session ? this.ctx.workingDirectory.get(session) : this.ctx.workingDirectory.defaultDirectory
    } catch {
      cwd = this.ctx.workingDirectory.defaultDirectory
    }
    return path.join(cwd, this.config.storageDirName, sessionId)
  }

  sessionDir(sessionId) {
    return this.resolveBaseDir(sessionId)
  }

  assetPath(sessionId, name) {
    return path.join(this.resolveBaseDir(sessionId), 'assets', name)
  }

  async ensureDir(sessionId) {
    const dir = this.resolveBaseDir(sessionId)
    await fs.mkdir(path.join(dir, 'assets'), { recursive: true })
    await fs.mkdir(path.join(dir, 'runs'), { recursive: true })
    return dir
  }

  async load(sessionId) {
    const cached = this.cache.get(sessionId)
    if (cached !== undefined) return cached
    let doc
    try {
      const raw = await fs.readFile(path.join(this.resolveBaseDir(sessionId), DOC_FILE), 'utf8')
      doc = normalizeDoc(JSON.parse(raw), sessionId)
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.ctx.logger?.warn?.(`comfy-coworking: cannot read document for ${sessionId}: ${error.message}`)
        try {
          const dir = this.resolveBaseDir(sessionId)
          await fs.rename(path.join(dir, DOC_FILE), path.join(dir, `document.corrupt-${Date.now()}.json`))
        } catch {}
      }
      doc = newDoc(sessionId)
    }
    this.cache.set(sessionId, doc)
    return doc
  }

  async snapshot(sessionId) {
    return publicDoc(await this.load(sessionId))
  }

  async save(sessionId, doc) {
    const dir = await this.ensureDir(sessionId)
    const target = path.join(dir, DOC_FILE)
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`
    await fs.writeFile(temporary, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
    await fs.rename(temporary, target)
  }

  /** Serialize one mutation per session; the mutator may return false to skip persistence. */
  async mutate(sessionId, mutator, meta = {}) {
    const previous = this.queues.get(sessionId) ?? Promise.resolve()
    const next = previous.then(async () => {
      const doc = await this.load(sessionId)
      const changed = await mutator(doc)
      if (changed === false) return publicDoc(doc)
      doc.rev += 1
      doc.updatedAt = Date.now()
      if (doc.layout?.items?.length > 0 && doc.promptManual !== true) {
        const compiled = compileDocPrompt(doc)
        doc.prompt = compiled.prompt
        doc.promptError = compiled.error
        doc.promptSource = 'layout'
      }
      this.cache.set(sessionId, doc)
      await this.save(sessionId, doc)
      this.broadcast(sessionId, { type: 'doc', doc: publicDoc(doc), meta })
      return publicDoc(doc)
    })
    this.queues.set(sessionId, next.catch(() => {}))
    return next
  }

  async setPrompt(sessionId, prompt, meta = {}) {
    return this.mutate(sessionId, (doc) => {
      doc.prompt = String(prompt ?? '')
      doc.promptManual = meta.manual !== false
      doc.promptSource = meta.source ?? 'user'
      doc.promptError = null
      if (doc.selected?.kind === 'box') {
        const item = doc.layout.items.find((entry) => entry.id === doc.selected.id)
        if (item !== undefined && meta.boxCaption === true) item.caption = doc.prompt
      }
    }, meta)
  }

  async setLayout(sessionId, { summary, items }, meta = {}) {
    return this.mutate(sessionId, (doc) => {
      if (typeof summary === 'string') doc.layout.summary = summary
      if (Array.isArray(items)) doc.layout.items = items.map(normalizeItem)
      doc.promptManual = false
      doc.promptSource = meta.source ?? 'layout'
    }, meta)
  }

  async upsertBox(sessionId, box, meta = {}) {
    return this.mutate(sessionId, (doc) => {
      const item = normalizeItem(box)
      if (item.id === undefined || item.id === '') item.id = `box-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      const index = doc.layout.items.findIndex((entry) => entry.id === item.id)
      if (index >= 0) doc.layout.items[index] = { ...doc.layout.items[index], ...item }
      else doc.layout.items.push(item)
      doc.promptManual = false
      doc.promptSource = meta.source ?? 'agent'
      doc.selected = { kind: 'box', id: item.id }
      return true
    }, meta)
  }

  async removeBox(sessionId, id, meta = {}) {
    return this.mutate(sessionId, (doc) => {
      const index = doc.layout.items.findIndex((entry) => entry.id === id)
      if (index < 0) throw new Error(`box not found: ${id}`)
      doc.layout.items.splice(index, 1)
      if (doc.selected?.kind === 'box' && doc.selected.id === id) {
        doc.selected = doc.layout.items.length > 0 ? { kind: 'box', id: doc.layout.items[0].id } : null
      }
      doc.promptManual = false
      doc.promptSource = meta.source ?? 'agent'
    }, meta)
  }

  async setCanvas(sessionId, patch, meta = {}) {
    return this.mutate(sessionId, (doc) => {
      if (patch.mode === 'image' || patch.mode === 'layout') doc.mode = patch.mode
      if (Number.isInteger(patch.width) && patch.width > 0) doc.canvas.width = patch.width
      if (Number.isInteger(patch.height) && patch.height > 0) doc.canvas.height = patch.height
      if (patch.image === null) doc.canvas.image = null
      else if (patch.image && typeof patch.image === 'object') doc.canvas.image = { ...patch.image }
      if (patch.mask === null) doc.mask = { ...doc.mask, rev: doc.mask.rev + 1 }
      else if (patch.mask && typeof patch.mask === 'object') doc.mask = { ...doc.mask, ...patch.mask }
    }, meta)
  }

  async setWorkflow(sessionId, workflow, meta = {}) {
    return this.mutate(sessionId, (doc) => {
      doc.workflow = workflow === null ? null : { ...workflow, loadedAt: workflow.loadedAt ?? Date.now() }
    }, meta)
  }

  async patchWorkflow(sessionId, patch, meta = {}) {
    return this.mutate(sessionId, (doc) => {
      if (doc.workflow === null) throw new Error('no workflow is loaded')
      doc.workflow = { ...doc.workflow, ...patch }
    }, meta)
  }

  async setSelection(sessionId, selection, meta = {}) {
    return this.mutate(sessionId, (doc) => {
      if (selection === null) doc.selected = null
      else if (selection?.kind === 'box') {
        if (!doc.layout.items.some((item) => item.id === selection.id)) throw new Error(`box not found: ${selection.id}`)
        doc.selected = { kind: 'box', id: selection.id }
      } else doc.selected = null
    }, meta)
  }

  async addRun(sessionId, run, meta = {}) {
    return this.mutate(sessionId, (doc) => {
      doc.runs = [run, ...doc.runs].slice(0, 30)
    }, meta)
  }

  async updateRun(sessionId, runId, patch, meta = {}) {
    return this.mutate(sessionId, (doc) => {
      const run = doc.runs.find((entry) => entry.id === runId)
      if (run === undefined) return false
      Object.assign(run, patch, { updatedAt: Date.now() })
    }, meta)
  }

  async notify(sessionId, notice, meta = {}) {
    return this.mutate(sessionId, (doc) => {
      doc.ui.notice = { seq: (doc.ui.notice?.seq ?? 0) + 1, ...notice, at: Date.now() }
    }, meta)
  }

  async requestOpen(sessionId, meta = {}) {
    return this.mutate(sessionId, (doc) => {
      doc.ui.openSeq += 1
    }, meta)
  }

  async saveAsset(sessionId, name, data) {
    if (data.length > this.config.maxAssetBytes) throw new Error(`asset exceeds ${this.config.maxAssetBytes} bytes`)
    const target = this.assetPath(sessionId, name)
    const dir = path.dirname(target)
    await fs.mkdir(dir, { recursive: true })
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`
    await fs.writeFile(temporary, data)
    await fs.rename(temporary, target)
    return target
  }

  async readAsset(sessionId, name) {
    return fs.readFile(this.assetPath(sessionId, name))
  }

  async deleteAsset(sessionId, name) {
    try {
      await fs.unlink(this.assetPath(sessionId, name))
      return true
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw error
    }
  }

  assetExists(sessionId, name) {
    return fs.access(this.assetPath(sessionId, name)).then(() => true, () => false)
  }

  subscribe(sessionId, res) {
    let set = this.listeners.get(sessionId)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(sessionId, set)
    }
    set.add(res)
    return () => {
      set.delete(res)
      if (set.size === 0) this.listeners.delete(sessionId)
    }
  }

  broadcast(sessionId, payload) {
    const set = this.listeners.get(sessionId)
    if (set === undefined) return
    const frame = `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`
    for (const res of set) {
      try {
        res.write(frame)
      } catch {
        set.delete(res)
      }
    }
  }
}

export function normalizeItem(item) {
  const out = {
    id: typeof item?.id === 'string' && item.id !== '' ? item.id : '',
    label: ['object', 'character', 'text'].includes(item?.label) ? item.label : 'object',
    caption: String(item?.caption ?? ''),
    text: String(item?.text ?? ''),
    bbox: Array.isArray(item?.bbox) ? item.bbox.map(Number) : [0, 0, 0, 0],
    palette: Array.isArray(item?.palette) ? item.palette.filter((c) => typeof c === 'string') : [],
    tags: Array.isArray(item?.tags) ? item.tags.filter((c) => typeof c === 'string') : [],
  }
  return out
}
