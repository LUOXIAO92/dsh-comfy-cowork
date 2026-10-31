/**
 * The workspace's model catalog.
 *
 * A loader widget takes a plain string, and ComfyUI publishes the exact
 * accepted strings in `/object_info`: every combo input carries its values.
 * Those values are what a node accepts — `Illustrious/model.safetensors`, no
 * folder prefix, never an absolute path.
 *
 * Sweeping `/models` folders is the wrong source. That listing also contains
 * directories no widget reads (custom_nodes and its python and .pyc files,
 * configs, datasets, fonts, vae_approx previews), so the catalog is derived
 * from the node definitions instead: the input name is the widget an agent has
 * to fill (`ckpt_name`, `lora_name`, `unet_name`, …), the values are the
 * strings it accepts, and the node types say where the widget appears.
 *
 * The catalog is a cache, not the truth: it is refreshed on demand, on a TTL,
 * and whenever the ComfyUI address changes. A failed refresh keeps the previous
 * snapshot and reports it as stale.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

const CATALOG_FILE = 'models.json'
const CATALOG_VERSION = 2

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

/**
 * The values of one combo input, in either object_info shape: the legacy
 * `[[list], {meta}]` and the current `['COMBO', {options: [list]}]`.
 */
export function comboValues(spec) {
  if (!Array.isArray(spec) || spec.length === 0) return []
  const [type, options] = spec
  const values = Array.isArray(type) ? type : type === 'COMBO' ? options?.options : null
  if (!Array.isArray(values)) return []
  return values.filter((value) => typeof value === 'string')
}

/** Whether a widget value names a model file the server can load. */
export function isModelFile(value) {
  const dot = value.lastIndexOf('.')
  if (dot === -1) return false
  return MODEL_EXTENSIONS.has(value.slice(dot + 1).toLowerCase())
}

/**
 * Group every model-valued input of every node.
 *
 * An input qualifies when at least half of its values are model files. The
 * threshold, not `every`, keeps lists that carry a sentinel — VAELoader offers
 * `pixel_space` next to its real files — while enum lists of other kinds
 * (`sampler_name`, input images, fonts, configs) never reach the threshold.
 */
export function buildModelGroups(objectInfo) {
  const groups = {}
  for (const [nodeType, definition] of Object.entries(objectInfo ?? {})) {
    if (definition === null || typeof definition !== 'object') continue
    for (const section of ['required', 'optional']) {
      const inputs = definition.input?.[section]
      if (inputs === null || typeof inputs !== 'object') continue
      for (const [name, spec] of Object.entries(inputs)) {
        const values = comboValues(spec)
        const files = values.filter(isModelFile)
        if (files.length === 0 || files.length * 2 < values.length) continue
        const group = (groups[name] ??= { values: new Set(), nodes: new Set() })
        for (const value of values) group.values.add(value)
        group.nodes.add(nodeType)
      }
    }
  }
  const result = {}
  for (const [name, group] of Object.entries(groups)) {
    result[name] = {
      values: [...group.values].sort((a, b) => a.localeCompare(b)),
      nodes: [...group.nodes].sort((a, b) => a.localeCompare(b)),
    }
  }
  return result
}

export class ModelCatalog {
  constructor(config) {
    this.config = config
    /** workspace root -> { updatedAt, baseUrl, groups } */
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
      const groups = {}
      for (const [name, entry] of Object.entries(parsed.groups ?? {})) {
        const values = Array.isArray(entry?.values) ? entry.values.filter((value) => typeof value === 'string') : []
        if (values.length === 0) continue
        groups[name] = {
          values,
          nodes: Array.isArray(entry.nodes) ? entry.nodes.filter((node) => typeof node === 'string') : [],
        }
      }
      const snapshot = { updatedAt: Number(parsed.updatedAt) || 0, baseUrl: parsed.baseUrl ?? '', groups }
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

  /** Read the node definitions and regroup their model inputs. */
  async refresh(root, comfy) {
    const objectInfo = await comfy.objectInfo(true)
    if (objectInfo === null || typeof objectInfo !== 'object' || Object.keys(objectInfo).length === 0) {
      throw new Error('ComfyUI returned no node definitions')
    }
    const groups = buildModelGroups(objectInfo)
    if (Object.keys(groups).length === 0) throw new Error('ComfyUI reported no model inputs')
    const snapshot = { updatedAt: Date.now(), baseUrl: this.config.baseUrl, groups }
    await this.write(root, snapshot)
    this.errors.set(root, '')
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
      groups: snapshot.groups,
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

  /** Model inputs with their value counts: the first level an agent browses. */
  groups(snapshot) {
    if (snapshot === null) return []
    return Object.entries(snapshot.groups)
      .map(([group, entry]) => ({ group, count: entry.values.length, nodes: entry.nodes }))
      .sort((a, b) => a.group.localeCompare(b.group))
  }

  /** The values one input accepts, paged: the second level. */
  values(snapshot, group, { query = '', offset = 0, limit = 200 } = {}) {
    const entry = snapshot?.groups?.[group]
    const all = entry?.values ?? []
    const nodes = entry?.nodes ?? []
    const needle = String(query ?? '').trim().toLowerCase()
    const matched = needle === '' ? all : all.filter((value) => value.toLowerCase().includes(needle))
    const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0
    const size = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 1000) : 200
    return {
      group,
      total: matched.length,
      values: matched.slice(start, start + size),
      offset: start,
      truncated: start + size < matched.length,
      nodes,
    }
  }
}
