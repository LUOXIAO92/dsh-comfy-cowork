/** Minimal ComfyUI HTTP client used by the Host half (no browser CORS involved). */

import { errorMessage } from './config.js'

export class ComfyError extends Error {
  constructor(message, { status, body } = {}) {
    super(message)
    this.name = 'ComfyError'
    this.status = status
    this.body = body
  }
}

export class ComfyClient {
  constructor(config, logger) {
    this.config = config
    this.logger = logger
    this.objectInfoCache = null
    this.objectInfoAt = 0
  }

  url(pathname) {
    return `${this.config.baseUrl}${pathname.startsWith('/') ? '' : '/'}${pathname}`
  }

  async fetch(pathname, options = {}) {
    const timeout = options.timeoutMs ?? this.config.requestTimeoutMs
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const response = await fetch(this.url(pathname), {
        ...options,
        signal: controller.signal,
        headers: {
          ...(options.headers ?? {}),
        },
      })
      return response
    } catch (error) {
      if (error?.name === 'AbortError') throw new ComfyError(`ComfyUI request timed out after ${timeout}ms: ${pathname}`)
      throw new ComfyError(`Cannot reach ComfyUI at ${this.config.baseUrl}: ${errorMessage(error)}`)
    } finally {
      clearTimeout(timer)
    }
  }

  async json(pathname, options = {}) {
    const response = await this.fetch(pathname, options)
    const text = await response.text()
    let body
    try {
      body = text === '' ? null : JSON.parse(text)
    } catch {
      body = text
    }
    if (!response.ok) {
      const detail = typeof body === 'string' ? body.slice(0, 500) : JSON.stringify(body).slice(0, 800)
      throw new ComfyError(`ComfyUI ${options.method ?? 'GET'} ${pathname} failed (${response.status}): ${detail}`, {
        status: response.status,
        body,
      })
    }
    return body
  }

  systemStats() {
    return this.json('/system_stats', { timeoutMs: 10_000 })
  }

  async models() {
    return this.json('/models')
  }

  async modelFiles(folder) {
    if (typeof folder !== 'string' || folder === '') throw new ComfyError('model folder is required')
    return this.json(`/models/${encodeURIComponent(folder)}`)
  }

  async objectInfo(force = false) {
    const now = Date.now()
    if (!force && this.objectInfoCache !== null && now - this.objectInfoAt < 5 * 60_000) return this.objectInfoCache
    const data = await this.json('/object_info', { timeoutMs: 90_000 })
    this.objectInfoCache = data
    this.objectInfoAt = now
    return data
  }

  async nodeInfo(classes) {
    const all = await this.objectInfo()
    const result = {}
    for (const name of classes) {
      if (typeof name === 'string' && all[name] !== undefined) result[name] = all[name]
    }
    return result
  }

  async listWorkflows() {
    const list = await this.json('/userdata?dir=workflows&recurse=true&full_info=true')
    if (!Array.isArray(list)) return []
    return list
      .filter((entry) => entry && typeof entry.path === 'string' && entry.path.endsWith('.json'))
      .map((entry) => ({
        path: entry.path,
        size: entry.size,
        modified: entry.modified,
      }))
  }

  async readWorkflow(name) {
    if (typeof name !== 'string' || name.trim() === '') throw new ComfyError('workflow name is required')
    const file = name.startsWith('workflows/') ? name : `workflows/${name}`
    const response = await this.fetch(`/userdata/${encodeURIComponent(file)}`, { timeoutMs: 30_000 })
    if (!response.ok) {
      throw new ComfyError(`ComfyUI workflow "${name}" could not be loaded (${response.status})`)
    }
    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch {
      throw new ComfyError(`ComfyUI workflow "${name}" is not valid JSON`)
    }
  }

  async saveWorkflow(name, workflow) {
    if (typeof name !== 'string' || name.trim() === '') throw new ComfyError('workflow name is required')
    const clean = name.startsWith('workflows/') ? name.slice('workflows/'.length) : name
    if (!clean.endsWith('.json')) throw new ComfyError('workflow name must end with .json')
    const file = `workflows/${clean}`
    const response = await this.fetch(`/userdata/${encodeURIComponent(file)}?overwrite=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(workflow),
      timeoutMs: 30_000,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new ComfyError(`ComfyUI workflow "${name}" could not be saved (${response.status}): ${text.slice(0, 300)}`)
    }
    return { name: clean }
  }

  async uploadImage(buffer, filename, { subfolder = 'dsh-comfy-coworking', type = 'input', mime = 'image/png' } = {}) {
    const form = new FormData()
    form.append('image', new Blob([buffer], { type: mime }), filename)
    form.append('overwrite', 'true')
    form.append('type', type)
    if (subfolder) form.append('subfolder', subfolder)
    const response = await this.fetch('/upload/image', {
      method: 'POST',
      body: form,
      timeoutMs: this.config.uploadTimeoutMs,
    })
    const text = await response.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
    if (!response.ok) throw new ComfyError(`ComfyUI image upload failed (${response.status}): ${text.slice(0, 300)}`)
    const name = body?.name ?? body?.filename
    if (typeof name !== 'string' || name === '') throw new ComfyError(`ComfyUI image upload returned no name: ${text.slice(0, 300)}`)
    return {
      name,
      subfolder: body?.subfolder ?? subfolder,
      type: body?.type ?? type,
      raw: body,
    }
  }

  async queuePrompt(prompt) {
    const body = await this.json('/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, client_id: 'dsh-comfy-coworking' }),
      timeoutMs: 60_000,
    })
    if (body?.prompt_id === undefined) throw new ComfyError(`ComfyUI did not return a prompt_id: ${JSON.stringify(body).slice(0, 500)}`)
    return body
  }

  history(promptId) {
    return this.json(`/history/${encodeURIComponent(promptId)}`, { timeoutMs: 15_000 })
  }

  queue() {
    return this.json('/queue', { timeoutMs: 10_000 })
  }

  async interrupt(promptId) {
    const response = await this.fetch('/interrupt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(promptId ? { prompt_id: promptId } : {}),
      timeoutMs: 10_000,
    })
    if (!response.ok) throw new ComfyError(`ComfyUI interrupt failed (${response.status})`)
  }

  async view({ filename, subfolder = '', type = 'output' }) {
    const query = new URLSearchParams({ filename, subfolder, type })
    const response = await this.fetch(`/view?${query.toString()}`, { timeoutMs: 120_000 })
    if (!response.ok) throw new ComfyError(`ComfyUI output "${filename}" could not be downloaded (${response.status})`)
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    }
  }
}
