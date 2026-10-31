/**
 * The workspace's node directory.
 *
 * ComfyUI describes its node types only through `/object_info`, which also
 * carries every input schema. Those schemas are large, version-specific, and
 * belong to the request that needs them — a widget's option list is read when
 * the widget is opened, not cached here. This cache keeps just what identifies
 * a node: type, display name, category, and description.
 *
 * ComfyUI's own node palette is a tree, and every node carries the category
 * path that puts it there (`KJNodes/masking`, `🆎 AusBoss/Video`, or nothing).
 * The directory stores that tree, so an agent walks top-level counts →
 * subcategories → the nodes filed there instead of paging a thousand names.
 * The flat view that text search needs is derived in memory; only the tree is
 * written, because a flat list would duplicate every node in the file.
 *
 * There is no TTL: a written directory is reused until it is missing or a
 * caller forces a refresh, and a failed refresh keeps the previous tree.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

const NODES_FILE = 'nodes.json'
const NODES_VERSION = 2

/** Page size for a text search, and the most one search may return. */
const SEARCH_LIMIT = 100
const SEARCH_LIMIT_MAX = 500

/** Pseudo category for node types ComfyUI files under no category at all. */
const UNCATEGORIZED = 'uncategorized'

/** Trim a category path to `a/b` form, without stray slashes or spaces. */
export function cleanCategory(value) {
  return String(value ?? '')
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join('/')
}

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

/** One branch of the category tree; `count` covers every node below it. */
function treeNode() {
  return { count: 0, nodes: [], children: {} }
}

/**
 * Add a child branch without ever running through the `__proto__` setter, so a
 * category literally named that cannot reach Object.prototype.
 */
function addChild(children, name, child) {
  Object.defineProperty(children, name, { value: child, enumerable: true, writable: true, configurable: true })
}

/** Trust one `{type, display, description}` entry, filling in display/description. */
function normalizeNode(entry) {
  if (entry === null || typeof entry !== 'object' || typeof entry.type !== 'string') return null
  return {
    type: entry.type,
    display: typeof entry.display === 'string' && entry.display !== '' ? entry.display : entry.type,
    description: typeof entry.description === 'string' ? entry.description : '',
  }
}

/**
 * Nest flat `{type, display, category, description}` entries by their category
 * path and roll counts up. This is the shape written to nodes.json: a branch
 * holds the nodes filed exactly there plus its child branches, and its `count`
 * is every node type in that subtree.
 */
export function buildNodeTree(nodes) {
  const root = treeNode()
  for (const raw of Array.isArray(nodes) ? nodes : []) {
    const entry = normalizeNode(raw)
    if (entry === null) continue
    const segments = cleanCategory(raw.category).split('/').filter(Boolean)
    root.count += 1
    let current = root
    for (const segment of segments) {
      if (!Object.hasOwn(current.children, segment)) addChild(current.children, segment, treeNode())
      current = current.children[segment]
      current.count += 1
    }
    current.nodes.push(entry)
  }
  sortTree(root)
  return root
}

/** Stable order inside every branch: nodes by type, children left in place. */
function sortTree(node) {
  node.nodes.sort((a, b) => a.type.localeCompare(b.type))
  for (const child of Object.values(node.children)) sortTree(child)
}

/**
 * Walk a stored tree back to the flat entries search wants, with the full
 * category path attached. The counts are ignored: callers rebuild them.
 */
function flattenTree(tree) {
  const flat = []
  const walk = (node, prefix) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node.nodes)) {
      for (const raw of node.nodes) {
        const entry = normalizeNode(raw)
        if (entry === null) continue
        flat.push({ ...entry, category: prefix })
      }
    }
    if (node.children === null || typeof node.children !== 'object') return
    for (const [name, child] of Object.entries(node.children)) {
      const segment = cleanCategory(name)
      if (segment === '') continue
      walk(child, prefix === '' ? segment : `${prefix}/${segment}`)
    }
  }
  walk(tree, '')
  return flat.sort((a, b) => a.type.localeCompare(b.type))
}

/**
 * Accept a parsed tree, or null when it cannot be trusted. A file written by a
 * broken version is rebuilt from the flat entries instead of breaking browse;
 * recomputing counts here is what keeps a hand-edited file from drifting.
 */
function normalizeTree(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!Array.isArray(raw.nodes)) return null
  if (raw.children === null || typeof raw.children !== 'object' || Array.isArray(raw.children)) return null
  const flat = flattenTree(raw)
  if (flat.length === 0) return null
  return buildNodeTree(flat)
}

export class NodeCatalog {
  constructor(config) {
    this.config = config
    /** workspace root -> { updatedAt, baseUrl, tree } */
    this.memory = new Map()
    /** workspace root -> in-flight refresh */
    this.pending = new Map()
    /** workspace root -> last refresh error */
    this.errors = new Map()
    /** snapshot -> flat { type, display, category, description } entries */
    this.flat = new WeakMap()
  }

  fileFor(root) {
    return path.join(root, this.config.storageDirName, NODES_FILE)
  }

  /** Derive the in-memory flat view search needs; it is never persisted. */
  remember(snapshot) {
    this.flat.set(snapshot, flattenTree(snapshot.tree))
    return snapshot
  }

  /** The flat entries behind a snapshot, for search. */
  flatOf(snapshot) {
    if (snapshot === null || snapshot === undefined) return []
    const known = this.flat.get(snapshot)
    if (known !== undefined) return known
    const derived = flattenTree(snapshot?.tree)
    this.flat.set(snapshot, derived)
    return derived
  }

  /** The last snapshot for this workspace, or null before the first refresh. */
  async read(root) {
    const cached = this.memory.get(root)
    if (cached !== undefined) return cached
    try {
      const parsed = JSON.parse(await fs.readFile(this.fileFor(root), 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || parsed.version !== NODES_VERSION) return null
      const tree = normalizeTree(parsed.tree)
      if (tree === null) return null
      const snapshot = this.remember({
        updatedAt: Number(parsed.updatedAt) || 0,
        baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '',
        tree,
      })
      this.memory.set(root, snapshot)
      return snapshot
    } catch {
      return null
    }
  }

  /** A snapshot is stale only when there is none: no TTL, no date math. */
  stale(root, snapshot) {
    return snapshot === null
  }

  /**
   * Return the stored snapshot, refreshing only when it is missing or the
   * caller forces it. Concurrent callers share one refresh.
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

  async refresh(root, comfy) {
    const objectInfo = await comfy.objectInfo(true)
    if (objectInfo === null || typeof objectInfo !== 'object' || Object.keys(objectInfo).length === 0) {
      throw new Error('ComfyUI returned no node definitions')
    }
    const snapshot = {
      updatedAt: Date.now(),
      baseUrl: this.config.baseUrl,
      tree: buildNodeTree(nodeEntries(objectInfo)),
    }
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
      tree: snapshot.tree,
    }
    // Compact on purpose: the tree is around 300 KB on a full install, and
    // indentation would multiply that with no reader benefit.
    await fs.writeFile(temporary, `${JSON.stringify(body)}\n`, 'utf8')
    await fs.rename(temporary, file)
    this.memory.set(root, this.remember(snapshot))
  }

  /** Forget a workspace: used when the ComfyUI address changes. */
  clear(root) {
    this.memory.delete(root)
    this.errors.delete(root)
  }

  /** The tree branch at a full category path, or null when it does not exist. */
  findNode(snapshot, category) {
    const target = cleanCategory(category)
    const tree = snapshot?.tree
    if (tree === null || tree === undefined) return null
    if (target === '') return tree
    if (target === UNCATEGORIZED) return null
    let node = tree
    for (const segment of target.split('/')) {
      if (node.children === null || typeof node.children !== 'object') return null
      if (!Object.hasOwn(node.children, segment)) return null
      node = node.children[segment]
      if (node === null || typeof node !== 'object') return null
    }
    return node
  }

  /**
   * Child categories directly under `parent` ('' for the top level), each with
   * the number of node types below it. This is the tree ComfyUI's own node
   * palette shows, so an agent can walk `KJNodes` → `KJNodes/masking` instead
   * of paging 1304 names. `uncategorized` is a pseudo category for nodes whose
   * category path is empty, and only exists at the top level.
   */
  categories(snapshot, parent = '') {
    const base = cleanCategory(parent)
    if (base === UNCATEGORIZED) return []
    const node = this.findNode(snapshot, base)
    if (node === null) return []
    const children = node.children !== null && typeof node.children === 'object' ? node.children : {}
    const result = Object.entries(children).map(([name, child]) => ({
      category: base === '' ? name : `${base}/${name}`,
      count: Number.isFinite(child?.count) ? child.count : 0,
    }))
    const rootNodes = snapshot?.tree?.nodes
    if (base === '' && Array.isArray(rootNodes) && rootNodes.length > 0) {
      result.push({ category: UNCATEGORIZED, count: rootNodes.length })
    }
    return result.sort((a, b) => b.count - a.count || a.category.localeCompare(b.category))
  }

  /** Node types filed exactly at one category path (not its subcategories). */
  inCategory(snapshot, category) {
    const target = cleanCategory(category)
    if (target === '') return []
    const node = target === UNCATEGORIZED ? snapshot?.tree : this.findNode(snapshot, target)
    if (node === null || node === undefined || !Array.isArray(node.nodes)) return []
    return node.nodes.map((entry) => ({
      type: entry.type,
      display: typeof entry.display === 'string' ? entry.display : entry.type,
      description: typeof entry.description === 'string' ? entry.description : '',
    }))
  }

  /** How many node types live in a category and everything below it. */
  subtreeSize(snapshot, category) {
    const target = cleanCategory(category)
    if (target === '') {
      return Number.isFinite(snapshot?.tree?.count) ? snapshot.tree.count : 0
    }
    if (target === UNCATEGORIZED) {
      const rootNodes = snapshot?.tree?.nodes
      return Array.isArray(rootNodes) ? rootNodes.length : 0
    }
    const node = this.findNode(snapshot, target)
    return Number.isFinite(node?.count) ? node.count : 0
  }

  /**
   * Search type, display name, category, and description case-insensitively.
   * An empty query pages the whole directory and is only meant for small
   * installs. `limit` is clamped to 1..500 and pages never exceed it.
   */
  list(snapshot, { query = '', offset = 0, limit = SEARCH_LIMIT } = {}) {
    const all = this.flatOf(snapshot)
    const needle = String(query ?? '').trim().toLowerCase()
    const matched = needle === ''
      ? all
      : all.filter((node) =>
        node.type.toLowerCase().includes(needle) ||
        node.display.toLowerCase().includes(needle) ||
        node.category.toLowerCase().includes(needle) ||
        node.description.toLowerCase().includes(needle))
    const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0
    const wanted = Number(limit)
    const size = Number.isFinite(wanted)
      ? Math.min(Math.max(Math.floor(wanted), 1), SEARCH_LIMIT_MAX)
      : SEARCH_LIMIT
    const page = matched.slice(start, start + size)
    return {
      total: matched.length,
      nodes: page.map((node) => ({
        type: node.type,
        display: node.display,
        category: node.category,
        description: node.description,
      })),
      offset: start,
      truncated: start + page.length < matched.length,
    }
  }
}
