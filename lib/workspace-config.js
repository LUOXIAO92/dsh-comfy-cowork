/**
 * Per-workspace plugin settings.
 *
 * The ComfyUI address belongs to the machine, not to one chat, but it is stored
 * beside the canvases so a project can point at its own server. The file lives
 * at `<workspace>/.comfy-cowork/config.json`; a missing or broken file falls
 * back to the bundle's `baseUrl`.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { DEFAULTS, normalizeBaseUrl } from './config.js'

const CONFIG_FILE = 'config.json'

export class WorkspaceConfig {
  constructor(config) {
    this.config = config
    /** Workspace root -> { baseUrl, mtimeMs } */
    this.cache = new Map()
    /** Workspace root -> serialized write chain. */
    this.queues = new Map()
  }

  fileFor(root) {
    return path.join(root, this.config.storageDirName, CONFIG_FILE)
  }

  /**
   * The address this workspace uses, falling back to the bundle default.
   * Reads are cached by mtime so a hand-edited file is picked up.
   */
  async read(root) {
    const fallback = this.config.baseUrl ?? DEFAULTS.baseUrl
    const file = this.fileFor(root)
    let stat
    try {
      stat = await fs.stat(file)
    } catch {
      this.cache.delete(root)
      return fallback
    }
    const cached = this.cache.get(root)
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs) return cached.baseUrl
    let baseUrl = fallback
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
      const value = normalizeBaseUrl(parsed?.baseUrl)
      if (value !== null) baseUrl = value
    } catch {
      // A corrupt file is not fatal: the default address still works.
    }
    this.cache.set(root, { baseUrl, mtimeMs: stat.mtimeMs })
    return baseUrl
  }

  /** Persist one workspace's address; rejects an address the client cannot use. */
  async write(root, rawBaseUrl) {
    const baseUrl = normalizeBaseUrl(rawBaseUrl)
    if (baseUrl === null) throw new Error(`not an http(s) address: ${String(rawBaseUrl)}`)
    const previous = this.queues.get(root) ?? Promise.resolve()
    const next = previous.then(async () => {
      const dir = path.join(root, this.config.storageDirName)
      await fs.mkdir(dir, { recursive: true })
      const file = path.join(dir, CONFIG_FILE)
      const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
      await fs.writeFile(temporary, `${JSON.stringify({ baseUrl }, null, 2)}\n`, 'utf8')
      await fs.rename(temporary, file)
      const stat = await fs.stat(file)
      this.cache.set(root, { baseUrl, mtimeMs: stat.mtimeMs })
    })
    this.queues.set(root, next.catch(() => {}))
    await next
    return baseUrl
  }
}
