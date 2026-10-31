/**
 * The workspace's model catalog.
 *
 * ComfyUI answers `/models` with folder names and `/models/<folder>` with the
 * files inside it. Those file strings are exactly what a loader widget expects
 * (`Illustrious/model.safetensors`, no folder prefix, never an absolute path),
 * so the catalog stores them as-is and groups them by folder.
 *
 * The catalog is a cache, not the truth: it is refreshed on demand, on a TTL,
 * and whenever the ComfyUI address changes. A failed refresh keeps the previous
 * snapshot and reports it as stale.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

const CATALOG_FILE = 'models.json'
const CATALOG_VERSION = 1

/** Fetch this many folders at once; a big install can have thirty of them. */
const CONCURRENCY = 4

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
        if (Array.isArray(entry)) folders[name] = entry.filter((file) => typeof file === 'string')
        else if (Array.isArray(entry?.files)) folders[name] = entry.files.filter((file) => typeof file === 'string')
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

  /** Fetch every folder and its files, then persist the snapshot. */
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
          folders[folder] = Array.isArray(files) ? files.filter((file) => typeof file === 'string') : []
        } catch (error) {
          folders[folder] = []
          failures.push(`${folder}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    })
    await Promise.all(workers)
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
    const needle = query.trim().toLowerCase()
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
