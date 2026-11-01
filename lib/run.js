/** Queue, inject, poll, and download ComfyUI runs for the canvas document. */

import { applyBindings, inferBindings, workflowToPrompt } from './workflow.js'
import { layoutSummaryCaption, layoutToElements } from './moss.js'
import { composeMaskedImage } from './mask-compose.js'
import { decodePng, maskExtent } from './png.js'
import { errorMessage } from './config.js'

const RUN_TIMEOUT_MS = 45 * 60_000
const POLL_INTERVAL_MS = 1200

function runId() {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function sanitize(name) {
  return String(name).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
}

/**
 * Decide what a painted mask means for this run.
 *
 * A workflow whose output does not depend on a repaint node cannot use the
 * mask. Silently rendering the whole image is the failure this guard exists
 * for: the agent must say so, and may only override it explicitly.
 *
 * @param options - painted mask presence, whether the workflow reads the canvas
 *   image and/or an inpaint node, the explicit override, and the caller kind.
 * @returns an error message to abort with, or a note to record on the run.
 */
export function maskGuard({ painted, hasImage, hasMask, ignoreMask = false, agent = false }) {
  if (!painted || hasMask) return { error: null, note: null }
  if (agent && hasImage && ignoreMask !== true) {
    return {
      error: 'this workflow has no inpaint node, so the painted mask would be ignored; load a workflow with VAEEncodeForInpaint, SetLatentNoiseMask, or InpaintModelConditioning, or pass ignore_mask: true to render the whole image',
      note: null,
    }
  }
  return { error: null, note: 'the painted mask is not used: this workflow has no inpaint node' }
}

export class RunManager {
  constructor({ ctx, store, comfy, config }) {
    this.ctx = ctx
    this.store = store
    this.comfy = comfy
    this.config = config
    this.pollers = new Map()
  }

  async asset(sessionId, name) {
    try {
      return await this.store.readAsset(sessionId, name)
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }

  async start(sessionId, overrides = {}, meta = {}) {
    // A run reaches whatever ComfyUI address this chat's workspace saved.
    try {
      await this.activate?.(sessionId)
    } catch {}
    if (meta.agent === true && this.config.allowAgentRun === false) {
      throw new Error('agent-initiated ComfyUI runs are disabled by configuration (allowAgentRun: false)')
    }
    const doc = await this.store.load(sessionId)
    if (doc.workflow === null || doc.workflow === undefined) throw new Error('no workflow is loaded on the canvas')
    const workflow = doc.workflow.json ?? doc.workflow.api
    if (workflow === null || typeof workflow !== 'object') throw new Error('the loaded workflow has no JSON body')

    const objectInfo = await this.comfy.objectInfo()
    const converted = workflowToPrompt(workflow, objectInfo)
    const inferred = inferBindings(workflow, objectInfo)
    const bindings = {
      ...inferred,
      ...(doc.workflow.bindings ?? {}),
      ...(overrides.bindings ?? {}),
    }
    const id = runId()
    const promptNode = converted.prompt[String(bindings.prompt)]
    const mossLayout = promptNode?.class_type === 'MOSSImageLayoutPrompt' && doc.layout.items.length > 0
    // The whole-image caption is the layout item of type `summary`; it is the
    // only source the MOSS node's `prompt` input may receive.
    const summaryCaption = layoutSummaryCaption(doc.layout.items)
    const promptText = mossLayout ? summaryCaption : doc.prompt
    if (mossLayout && String(promptText).trim() === '') throw new Error('the layout needs a whole-image description box (label summary) before running')

    const uploads = []
    let imageName = null
    let maskName = null
    const imageBuffer = await this.asset(sessionId, 'canvas.png')
    let rgbaBuffer = await this.asset(sessionId, 'canvas_rgba.png')
    const maskBuffer = await this.asset(sessionId, 'mask.png')
    let maskPainted = false
    if (maskBuffer !== null) {
      try {
        maskPainted = maskExtent(decodePng(maskBuffer)) !== null
      } catch {
        maskPainted = false
      }
    }
    const guard = maskGuard({
      painted: maskPainted,
      hasImage: bindings.image !== '',
      hasMask: bindings.mask !== '',
      ignoreMask: overrides.ignore_mask === true,
      agent: meta.agent === true,
    })
    if (guard.error !== null) throw Object.assign(new Error(guard.error), { status: 409, maskIgnored: true })
    // The browser exports canvas_rgba when the mask is saved, but a fresh host
    // may only have the mask itself. Derive the alpha layer from the current
    // image and mask so a run never ignores what the user painted.
    if (bindings.mask && bindings.mask === bindings.image) {
      const derived = composeMaskedImage(imageBuffer, maskBuffer)
      if (derived !== null) rgbaBuffer = derived
    }
    if (bindings.image) {
      if (bindings.mask && bindings.mask === bindings.image && rgbaBuffer !== null) {
        const uploaded = await this.comfy.uploadImage(rgbaBuffer, `${id}-rgba.png`, { subfolder: '' })
        imageName = uploaded.name
        maskName = uploaded.name
        uploads.push(uploaded.name)
      } else if (imageBuffer !== null) {
        const uploaded = await this.comfy.uploadImage(imageBuffer, `${id}-canvas.png`, { subfolder: '' })
        imageName = uploaded.name
        uploads.push(uploaded.name)
      } else {
        throw new Error('the workflow binds an image node but the canvas has no image yet')
      }
    }
    if (bindings.mask && bindings.mask !== bindings.image) {
      if (maskBuffer === null) throw new Error('the workflow binds a mask node but the canvas has no mask yet')
      const uploaded = await this.comfy.uploadImage(maskBuffer, `${id}-mask.png`, { subfolder: '' })
      maskName = uploaded.name
      uploads.push(uploaded.name)
    }

    const values = {
      prompt: promptText,
      negative: doc.negative ?? '',
      imageName,
      width: doc.canvas.width,
      height: doc.canvas.height,
      seed: Number.isFinite(overrides.seed) ? overrides.seed : undefined,
    }
    if (mossLayout) {
      values.bboxesJson = JSON.stringify(layoutToElements({
        width: doc.canvas.width,
        height: doc.canvas.height,
        items: doc.layout.items,
      }))
    }
    const injected = applyBindings(converted.prompt, bindings, values)
    const prompt = injected.prompt

    if (maskName !== null && bindings.mask !== bindings.image) {
      prompt[String(bindings.mask)].inputs.image = maskName
    }
    if (mossLayout) {
      const node = prompt[String(bindings.prompt)]
      node.inputs.width = doc.canvas.width
      node.inputs.height = doc.canvas.height
      const elementLink = Array.isArray(node.inputs.element) && node.inputs.element.length === 2 && typeof node.inputs.element[0] === 'string'
      if (bindings.bboxes === '' && node.inputs.element !== undefined && !elementLink) {
        node.inputs.element = JSON.parse(values.bboxesJson)
      }
      if (bindings.bboxes !== '' && prompt[String(bindings.bboxes)] !== undefined) {
        prompt[String(bindings.bboxes)].inputs.width = doc.canvas.width
        prompt[String(bindings.bboxes)].inputs.height = doc.canvas.height
      }
    }

    const queued = await this.comfy.queuePrompt(prompt)
    const run = {
      id,
      promptId: queued.prompt_id,
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      workflowName: doc.workflow.name ?? null,
      bindings,
      uploads,
      notes: guard.note === null ? [...converted.warnings, ...injected.notes] : [...converted.warnings, ...injected.notes, guard.note],
      outputs: [],
      error: null,
    }
    await this.store.addRun(sessionId, run, { source: meta.agent === true ? 'agent' : 'user' })
    this.poll(sessionId, run)
    return { run, prompt }
  }

  poll(sessionId, run) {
    const startedAt = Date.now()
    let lastStatus = run.status
    const timer = setInterval(async () => {
      try {
        if (Date.now() - startedAt > RUN_TIMEOUT_MS) {
          await this.finish(sessionId, run, { status: 'failed', error: 'ComfyUI run timed out' })
          return
        }
        const history = await this.comfy.history(run.promptId)
        const entry = history?.[run.promptId]
        if (entry !== undefined) {
          const failed = entry.status?.status_str === 'error'
          const outputs = failed ? [] : await this.downloadOutputs(sessionId, run, entry.outputs ?? {})
          const error = failed ? errorFromHistory(entry) : null
          await this.finish(sessionId, run, {
            status: failed ? 'failed' : 'completed',
            outputs,
            error,
          })
          return
        }
        const queue = await this.comfy.queue()
        const running = (queue.queue_running ?? []).some((item) => Array.isArray(item) && item[1] === run.promptId)
        const pending = (queue.queue_pending ?? []).some((item) => Array.isArray(item) && item[1] === run.promptId)
        const status = running ? 'running' : pending ? 'queued' : lastStatus === 'queued' && Date.now() - startedAt < 30_000 ? 'queued' : 'running'
        if (status !== lastStatus) {
          lastStatus = status
          await this.store.updateRun(sessionId, run.id, { status }, { source: 'run' })
        }
      } catch (error) {
        this.ctx.logger?.warn?.(`comfy-cowork: run ${run.id} poll failed: ${errorMessage(error)}`)
      }
    }, POLL_INTERVAL_MS)
    this.pollers.set(run.id, timer)
  }

  finish(sessionId, run, patch) {
    const timer = this.pollers.get(run.id)
    if (timer !== undefined) {
      clearInterval(timer)
      this.pollers.delete(run.id)
    }
    return this.store.updateRun(sessionId, run.id, patch, { source: 'run' })
  }

  async downloadOutputs(sessionId, run, outputs) {
    const files = []
    for (const [nodeId, output] of Object.entries(outputs)) {
      for (const kind of ['images', 'gifs', 'videos', 'audio']) {
        const list = Array.isArray(output?.[kind]) ? output[kind] : []
        for (const file of list) {
          if (file === null || typeof file !== 'object' || typeof file.filename !== 'string') continue
          files.push({ nodeId, kind, ...file })
        }
      }
    }
    const saved = []
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]
      const asset = `run-${run.id}-${index}-${sanitize(file.filename)}`
      try {
        const downloaded = await this.comfy.view(file)
        await this.store.saveAsset(sessionId, asset, downloaded.buffer)
        saved.push({
          nodeId: file.nodeId,
          kind: file.kind,
          filename: file.filename,
          subfolder: file.subfolder ?? '',
          type: file.type ?? 'output',
          asset,
          contentType: downloaded.contentType,
        })
      } catch (error) {
        saved.push({
          nodeId: file.nodeId,
          kind: file.kind,
          filename: file.filename,
          subfolder: file.subfolder ?? '',
          type: file.type ?? 'output',
          asset: null,
          error: errorMessage(error),
        })
      }
    }
    return saved
  }

  async interrupt(sessionId, id) {
    const doc = await this.store.load(sessionId)
    const run = doc.runs.find((entry) => entry.id === id) ?? doc.runs[0]
    if (run === undefined) throw new Error('no run to interrupt')
    await this.comfy.interrupt(run.promptId)
    await this.finish(sessionId, run, { status: 'cancelled', error: null })
    return run
  }

  async waitFor(sessionId, id, timeoutMs) {
    const deadline = Date.now() + Math.max(1000, Math.min(timeoutMs, 120_000))
    while (Date.now() < deadline) {
      const doc = await this.store.load(sessionId)
      const run = id ? doc.runs.find((entry) => entry.id === id) : doc.runs[0]
      if (run !== undefined && ['completed', 'failed', 'cancelled'].includes(run.status)) return run
      await new Promise((resolve) => setTimeout(resolve, 900))
    }
    const doc = await this.store.load(sessionId)
    return id ? doc.runs.find((entry) => entry.id === id) ?? null : doc.runs[0] ?? null
  }

  dispose() {
    for (const timer of this.pollers.values()) clearInterval(timer)
    this.pollers.clear()
  }
}

function errorFromHistory(entry) {
  const messages = Array.isArray(entry?.status?.messages) ? entry.status.messages : []
  for (const message of messages) {
    if (!Array.isArray(message)) continue
    const [type, data] = message
    if (type === 'execution_error') {
      const node = data?.node_id ?? data?.node_type ?? 'unknown'
      const text = data?.exception_message ?? data?.message ?? 'execution error'
      return `node ${node}: ${text}`
    }
    if (type === 'execution_interrupted') return 'execution interrupted'
  }
  return 'ComfyUI reported an error without details'
}
