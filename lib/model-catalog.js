/**
 * The workspace's model catalog.
 *
 * A model list is about models, not about nodes. ComfyUI answers `/models` with
 * its folder names and `/models/<folder>` with the files inside it; this stores
 * those, keeping only files a loader can actually load (model weights and their
 * sidecars) and dropping a folder that holds none of them.
 *
 * That filter is what keeps the junk out: the same endpoint also lists
 * `custom_nodes` (python and .pyc files), `configs` (yaml), `datasets` and font
 * folders, none of which is a model. File strings stay exactly as ComfyUI
 * reports them (folder-relative, no prefix) because that is what a loader
 * widget takes.
 *
 * The catalog is a cache, not the truth: it is refreshed on demand, on a TTL,
 * and whenever the ComfyUI address changes. A failed refresh keeps the previous
 * snapshot and reports it as stale.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

const CATALOG_FILE = 'models.json'
const CATALOG_VERSION = 3

/** Fetch this many folders at once; a big install can have thirty of them. */
const CONCURRENCY = 4

/** Extensions ComfyUI can load as a model or a model sidecar. */
const MODEL_EXTENSIONS = new Set([
  'safetensors',
  'sft',
  'ckpt',
  'pt',
  'pth',
  'bin',
  'gguf',
  'onnx',
  'pkl',
  'tflite',
  'engine',
])

/** Whether a folder entry names a model file the server can load. */
export function isModelFile(value) {
  if (typeof value !== 'string') return false
  const dot = value.lastIndexOf('.')
  if (dot === -1) return false
  return MODEL_EXTENSIONS.has(value.slice(dot + 1).toLowerCase())
}

export class ModelCatalog {
  constructor(config) {
    this.config = config
    /** workspace root -> { updatedAt, baseUrl, folders } */
    this.memory = new Map()
    /** workspace root -> in-flight refresh */
    this.pending = new Map()
    /** workspace root -> last refresh error */
    this.errors = new Map()
  }

  get ttlMs() {
    const value = Number(this.config.modelCacheTtlMs)
    return Number.isFinite(value) && value > 0 ? value : 10 * 60_000
  }

  fileFor(root) {
    return path.join(root, this.config.storageDirName, CATALOG_FILE)
  }

  /** The last snapshot for this workspace, or null before the first refresh. */
  async read(root) {
    const cached = this.memory.get(root)
    if (cached !== undefined) return cached
    try {
      const parsed = JSON.parse(await fs.readFile(this.fileFor(root), 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || parsed.version !== CATALOG_VERSION) return null
      const folders = {}
      for (const [name, entry] of Object.entries(parsed.folders ?? {})) {
        if (!Array.isArray(entry)) continue
        const files = entry.filter(isModelFile)
        if (files.length > 0) folders[name] = files
      }
      const snapshot = { updatedAt: Number(parsed.updatedAt) || 0, baseUrl: parsed.baseUrl ?? '', folders }
      this.memory.set(root, snapshot)
      return snapshot
    } catch {
      return null
    }
  }

  /** True when the snapshot is missing or older than the TTL. */
  stale(root, snapshot) {
    if (snapshot === null) return true
    return Date.now() - snapshot.updatedAt > this.ttlMs
  }

  /**
   * Return a fresh-enough snapshot, refreshing when it is missing or stale.
   * Concurrent callers share one refresh.
   */
  async ensure(root, comfy, { force = false } = {}) {
    const snapshot = await this.read(root)
    if (!force && !this.stale(root, snapshot)) return { snapshot, refreshed: false }
    const existing = this.pending.get(root)
    if (existing !== undefined) return { snapshot: await existing, refreshed: true }
    const pending = this.refresh(root, comfy).finally(() => {
      this.pending.delete(root)
    })
    this.pending.set(root, pending)
    return { snapshot: await pending, refreshed: true }
  }

  /** Read every folder and keep the model files; folders without any are dropped. */
  async refresh(root, comfy) {
    const names = await comfy.models()
    const folders = {}
    const failures = []
    const queue = Array.isArray(names) ? [...names] : []
    const workers = Array.from({ length: Math.min(CONCURRENCY, Math.max(queue.length, 1)) }, async () => {
      while (queue.length > 0) {
        const folder = queue.shift()
        try {
          const files = await comfy.modelFiles(folder)
          const kept = Array.isArray(files) ? files.filter(isModelFile) : []
          if (kept.length > 0) folders[folder] = kept
        } catch (error) {
          failures.push(`${folder}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    })
    await Promise.all(workers)
    if (Object.keys(folders).length === 0 && failures.length === 0) throw new Error('ComfyUI reported no model files')
    const snapshot = {
      updatedAt: Date.now(),
      baseUrl: this.config.baseUrl,
      folders,
      failures,
    }
    await this.write(root, snapshot)
    this.errors.set(root, failures.length > 0 ? failures.slice(0, 3).join('; ') : '')
    return snapshot
  }

  async write(root, snapshot) {
    const dir = path.join(root, this.config.storageDirName)
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, CATALOG_FILE)
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
    const body = {
      version: CATALOG_VERSION,
      updatedAt: snapshot.updatedAt,
      baseUrl: snapshot.baseUrl,
      folders: snapshot.folders,
    }
    await fs.writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
    await fs.rename(temporary, file)
    this.memory.set(root, snapshot)
  }

  /** Forget a workspace: used when the ComfyUI address changes. */
  clear(root) {
    this.memory.delete(root)
    this.errors.delete(root)
  }

  /** Folder names with their file counts: the first level an agent browses. */
  folders(snapshot) {
    if (snapshot === null) return []
    return Object.entries(snapshot.folders)
      .map(([folder, files]) => ({ folder, count: files.length }))
      .sort((a, b) => a.folder.localeCompare(b.folder))
  }

  /** Files inside one folder, paged: the second level. */
  files(snapshot, folder, { query = '', offset = 0, limit = 200 } = {}) {
    const all = snapshot?.folders?.[folder] ?? []
    const needle = String(query ?? '').trim().toLowerCase()
    const matched = needle === '' ? all : all.filter((file) => file.toLowerCase().includes(needle))
    const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0
    const size = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 1000) : 200
    return {
      folder,
      total: matched.length,
      files: matched.slice(start, start + size),
      offset: start,
      truncated: start + size < matched.length,
    }
  }
}
