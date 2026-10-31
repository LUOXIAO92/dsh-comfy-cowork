/**
 * The workspace's workflow index.
 *
 * Three sources feed one list, and every entry names its file:
 *
 * - `comfyui`   ComfyUI's own `userdata/workflows/**.json`, addressed by its
 *               userdata-relative path (`workflows/<name>.json`);
 * - `project`   the comfy skill's project convention: `fragments/*.json` and
 *               `blueprints/*.compiled.json` in the workspace;
 * - `workspace` what this plugin saved: `.comfy-cowork/workflows/*.json`.
 *
 * The index is a cache with explicit paths, so the agent can open any entry
 * without walking the filesystem itself.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

const INDEX_VERSION = 1
const INDEX_DIR = 'workflows'
const INDEX_FILE = 'index.json'

/** A workflow body is either the UI graph (`nodes`) or the API prompt (id → node). */
function countNodes(json) {
  if (json === null || typeof json !== 'object') return 0
  if (Array.isArray(json.nodes)) return json.nodes.length
  return Object.keys(json).length
}

async function listJsonFiles(dir, { suffix = '.json' } = {}) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.endsWith(suffix)) continue
    files.push(path.join(dir, entry.name))
  }
  return files.sort()
}

export class WorkflowIndex {
  constructor(config) {
    this.config = config
    /** workspace root -> { updatedAt, entries, stale, error } */
    this.memory = new Map()
  }

  dirFor(root) {
    return path.join(root, this.config.storageDirName, INDEX_DIR)
  }

  fileFor(root) {
    return path.join(this.dirFor(root), INDEX_FILE)
  }

  /** Forget a workspace's cached index, for example after the address changes. */
  clear(root) {
    this.memory.delete(root)
  }

  /** The last index for this workspace, or null before the first build. */
  async read(root) {
    const cached = this.memory.get(root)
    if (cached !== undefined) return cached
    try {
      const parsed = JSON.parse(await fs.readFile(this.fileFor(root), 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || parsed.version !== INDEX_VERSION) return null
      const index = {
        updatedAt: Number(parsed.updatedAt) || 0,
        entries: Array.isArray(parsed.entries) ? parsed.entries.filter((entry) => typeof entry?.id === 'string') : [],
        stale: parsed.stale === true,
        error: typeof parsed.error === 'string' ? parsed.error : '',
      }
      this.memory.set(root, index)
      return index
    } catch {
      return null
    }
  }

  async describe(file, source, id) {
    let stat
    try {
      stat = await fs.stat(file)
    } catch {
      return null
    }
    let nodes = 0
    try {
      nodes = countNodes(JSON.parse(await fs.readFile(file, 'utf8')))
    } catch {
      // A file that does not parse is still listed; loading it reports why.
    }
    return {
      id,
      source,
      name: path.basename(file),
      path: file,
      updatedAt: stat.mtimeMs,
      size: stat.size,
      nodes,
    }
  }

  /**
   * Rebuild the index: ComfyUI userdata, the comfy project's authored files,
   * and this plugin's own saves. A ComfyUI failure keeps the previous `comfyui`
   * entries and marks the index stale instead of emptying the list.
   */
  async build(root, comfy) {
    const previous = await this.read(root)
    const entries = []
    let stale = false
    let error = ''

    try {
      const listed = await comfy.listWorkflows()
      for (const entry of listed) {
        const relative = typeof entry.path === 'string' ? entry.path : ''
        if (relative === '') continue
        entries.push({
          id: `comfyui:${relative}`,
          source: 'comfyui',
          name: relative.replace(/^workflows\//, ''),
          path: relative,
          updatedAt: Number(entry.modified) || 0,
          size: Number(entry.size) || 0,
          nodes: 0,
        })
      }
    } catch (caught) {
      stale = true
      error = caught instanceof Error ? caught.message : String(caught)
      for (const entry of previous?.entries ?? []) if (entry.source === 'comfyui') entries.push(entry)
    }

    for (const file of await listJsonFiles(path.join(root, 'fragments'))) {
      const entry = await this.describe(file, 'project', `project:${file}`)
      if (entry !== null) entries.push(entry)
    }
    for (const file of await listJsonFiles(path.join(root, 'blueprints'), { suffix: '.compiled.json' })) {
      const entry = await this.describe(file, 'project', `project:${file}`)
      if (entry !== null) entries.push(entry)
    }
    for (const file of await listJsonFiles(this.dirFor(root))) {
      if (path.basename(file) === INDEX_FILE) continue
      const entry = await this.describe(file, 'workspace', `workspace:${file}`)
      if (entry !== null) entries.push(entry)
    }

    entries.sort((a, b) => {
      if (a.source !== b.source) return a.source.localeCompare(b.source)
      return a.name.localeCompare(b.name)
    })

    const index = { updatedAt: Date.now(), entries, stale, error }
    await this.write(root, index)
    return index
  }

  async write(root, index) {
    const dir = this.dirFor(root)
    await fs.mkdir(dir, { recursive: true })
    const file = this.fileFor(root)
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
    const body = {
      version: INDEX_VERSION,
      updatedAt: index.updatedAt,
      stale: index.stale === true,
      error: index.error ?? '',
      entries: index.entries,
    }
    await fs.writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
    await fs.rename(temporary, file)
    this.memory.set(root, index)
  }

  /** Resolve one entry by id, tolerating a bare ComfyUI file name. */
  find(index, id) {
    if (typeof id !== 'string' || id.trim() === '') return null
    const wanted = id.trim()
    const entries = index?.entries ?? []
    const exact = entries.find((entry) => entry.id === wanted)
    if (exact !== undefined) return exact
    const name = wanted.replace(/^workflows\//, '')
    return entries.find((entry) => entry.source === 'comfyui' && (entry.name === name || entry.path === wanted)) ?? null
  }

  /** Read the body of one entry; ComfyUI entries go through the API. */
  async load(root, comfy, entry) {
    if (entry.source === 'comfyui') return await comfy.readWorkflow(entry.path)
    const resolved = path.resolve(entry.path)
    if (!resolved.startsWith(path.resolve(root))) throw new Error(`workflow path escapes the workspace: ${entry.path}`)
    const text = await fs.readFile(resolved, 'utf8')
    return JSON.parse(text)
  }

  /**
   * Save a workflow body into `.comfy-cowork/workflows/` (or, when asked, into
   * ComfyUI's userdata) and refresh the index.
   */
  async save(root, comfy, name, json, { target = 'workspace' } = {}) {
    if (typeof name !== 'string' || name.trim() === '') throw new Error('workflow name is required')
    const clean = name.trim().replace(/[\\/]+/g, '-')
    const fileName = clean.endsWith('.json') ? clean : `${clean}.json`
    if (target === 'comfyui') {
      const saved = await comfy.saveWorkflow(fileName, json)
      const index = await this.build(root, comfy)
      return { entry: this.find(index, `comfyui:workflows/${fileName}`), index, saved }
    }
    const dir = this.dirFor(root)
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, fileName)
    await fs.writeFile(file, `${JSON.stringify(json, null, 2)}\n`, 'utf8')
    const index = await this.build(root, comfy)
    return { entry: this.find(index, `workspace:${file}`), index }
  }
}
