/**
 * The workspace's node directory.
 *
 * ComfyUI describes its node types only through `/object_info`, which also
 * carries every input schema. Those schemas are large, version-specific, and
 * belong to the request that needs them — a widget's option list is read when
 * the widget is opened, not cached here. This cache keeps just what identifies
 * a node: type, display name, category, and description.
 *
 * It answers "is there a node for X" and "what does this custom node do" without
 * making an agent read ComfyUI source folders.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

const NODES_FILE = 'nodes.json'
const NODES_VERSION = 1

/** Reduce `/object_info` to one identifying entry per node type. */
export function nodeEntries(objectInfo) {
  const nodes = []
  for (const [type, definition] of Object.entries(objectInfo ?? {})) {
    if (definition === null || typeof definition !== 'object') continue
    nodes.push({
      type,
      display: typeof definition.display_name === 'string' && definition.display_name !== '' ? definition.display_name : type,
      category: typeof definition.category === 'string' ? definition.category : '',
      description: typeof definition.description === 'string' ? definition.description : '',
    })
  }
  return nodes.sort((a, b) => a.type.localeCompare(b.type))
}

export class NodeCatalog {
  constructor(config) {
    this.config = config
    /** workspace root -> { updatedAt, baseUrl, nodes } */
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
    return path.join(root, this.config.storageDirName, NODES_FILE)
  }

  async read(root) {
    const cached = this.memory.get(root)
    if (cached !== undefined) return cached
    try {
      const parsed = JSON.parse(await fs.readFile(this.fileFor(root), 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || parsed.version !== NODES_VERSION) return null
      if (!Array.isArray(parsed.nodes)) return null
      const nodes = parsed.nodes
        .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.type === 'string')
        .map((entry) => ({
          type: entry.type,
          display: typeof entry.display === 'string' ? entry.display : entry.type,
          category: typeof entry.category === 'string' ? entry.category : '',
          description: typeof entry.description === 'string' ? entry.description : '',
        }))
      const snapshot = { updatedAt: Number(parsed.updatedAt) || 0, baseUrl: parsed.baseUrl ?? '', nodes }
      this.memory.set(root, snapshot)
      return snapshot
    } catch {
      return null
    }
  }

  stale(root, snapshot) {
    if (snapshot === null) return true
    return Date.now() - snapshot.updatedAt > this.ttlMs
  }

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

  async refresh(root, comfy) {
    const objectInfo = await comfy.objectInfo(true)
    if (objectInfo === null || typeof objectInfo !== 'object' || Object.keys(objectInfo).length === 0) {
      throw new Error('ComfyUI returned no node definitions')
    }
    const nodes = nodeEntries(objectInfo)
    const snapshot = { updatedAt: Date.now(), baseUrl: this.config.baseUrl, nodes }
    await this.write(root, snapshot)
    this.errors.set(root, '')
    return snapshot
  }

  async write(root, snapshot) {
    const dir = path.join(root, this.config.storageDirName)
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, NODES_FILE)
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
    const body = {
      version: NODES_VERSION,
      updatedAt: snapshot.updatedAt,
      baseUrl: snapshot.baseUrl,
      nodes: snapshot.nodes,
    }
    await fs.writeFile(temporary, `${JSON.stringify(body, null, 1)}\n`, 'utf8')
    await fs.rename(temporary, file)
    this.memory.set(root, snapshot)
  }

  clear(root) {
    this.memory.delete(root)
    this.errors.delete(root)
  }

  /**
   * Top-level categories with their node counts. A directory is never a menu —
   * an install has over a thousand types and a workflow uses a handful — so the
   * first thing an agent can ask is what is installed, at a glance.
   */
  categories(snapshot) {
    const counts = new Map()
    for (const node of snapshot?.nodes ?? []) {
      const category = String(node.category ?? '').split('/')[0].trim() || 'uncategorized'
      counts.set(category, (counts.get(category) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category))
  }

  /** Exact lookup by type: the node names a workflow already carries. */
  byTypes(snapshot, types) {
    const wanted = new Set((Array.isArray(types) ? types : []).filter((type) => typeof type === 'string'))
    return (snapshot?.nodes ?? []).filter((node) => wanted.has(node.type))
  }

  /**
   * Search by text. A query matches type, display name, category, and
   * description; an empty query pages the whole directory and is only meant for
   * small installs.
   */
  list(snapshot, { query = '', offset = 0, limit = 100 } = {}) {
    const all = snapshot?.nodes ?? []
    const needle = String(query ?? '').trim().toLowerCase()
    const matched = needle === ''
      ? all
      : all.filter((node) =>
        node.type.toLowerCase().includes(needle) ||
        node.display.toLowerCase().includes(needle) ||
        node.category.toLowerCase().includes(needle) ||
        node.description.toLowerCase().includes(needle))
    const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0
    const size = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 500) : 100
    return {
      total: matched.length,
      nodes: matched.slice(start, start + size),
      offset: start,
      truncated: start + size < matched.length,
    }
  }
}
