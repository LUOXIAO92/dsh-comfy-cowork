/** Queue, inject, poll, and download ComfyUI runs for the canvas document. */

import { applyBindings, inferBindings, workflowToPrompt } from './workflow.js'
import { layoutSummaryCaption, layoutToElements } from './moss.js'
import { composeMaskImage, composeMaskedImage } from './mask-compose.js'
import { decodePng, encodePng, maskExtent } from './png.js'
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

/**
 * Pick the positive text of one pass.
 *
 * Three cases, and the mask case is deliberately not a fallback: a mask pass
 * carries its region's own prompt, and an empty region prompt is an empty
 * local repaint (the model invents content inside the selection). A mask that
 * did not get its own text must not silently borrow the whole-image prompt,
 * which describes the picture before the edit. A MOSS layout run always sends
 * the whole-image description item; everything else sends the canvas prompt.
 *
 * @param options - canvas prompt, this region's prompt, MOSS summary caption
 *   (null when this is not a layout run), and whether this pass repaints a mask.
 * @returns { text, kind } with kind `layout`, `mask`, `empty`, or `canvas`.
 */
export function runPassPrompt({ prompt, regionPrompt, summaryCaption = null, maskPass = false }) {
  if (summaryCaption !== null) return { text: summaryCaption, kind: 'layout' }
  if (maskPass) {
    const text = typeof regionPrompt === 'string' ? regionPrompt : ''
    return { text, kind: text.trim() === '' ? 'empty' : 'mask' }
  }
  return { text: typeof prompt === 'string' ? prompt : '', kind: 'canvas' }
}

/**
 * Turn a region's canonical mask cutout back into the painted mask a canvas
 * alpha channel needs.
 *
 * A region asset is written for ComfyUI's mask loaders: white with
 * `alpha = 1 - painted` (see composeMaskImage). The legacy graph shape reads
 * its mask from the loader image's alpha, so the composed image must be cut
 * where the region is painted, not where it is transparent.
 */
function paintedMaskFromCutout(cutoutBuffer) {
  const png = decodePng(cutoutBuffer)
  if (png === null) return null
  const { width, height, channels, data } = png
  const out = Buffer.alloc(width * height * 4)
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const src = pixel * channels
    const alpha = channels === 4
      ? data[src + 3]
      : channels === 2
        ? data[src + 1]
        : data[src]
    const painted = 255 - alpha
    const dst = pixel * 4
    out[dst] = painted
    out[dst + 1] = painted
    out[dst + 2] = painted
    out[dst + 3] = painted
  }
  return encodePng(width, height, 4, out)
}

export class RunManager {
  constructor({ ctx, store, comfy, config, activate, pollIntervalMs = POLL_INTERVAL_MS }) {
    this.ctx = ctx
    this.store = store
    this.comfy = comfy
    this.config = config
    // Follows the workspace's saved ComfyUI address before a run reaches it;
    // the tool path never passes through the HTTP routes that also call this.
    this.activate = activate
    this.pollIntervalMs = pollIntervalMs
    this.pollers = new Map()
    // Per-run pass bookkeeping (current prompt id, remaining passes). Kept out
    // of the document: a restart stops polling anyway.
    this.plans = new Map()
  }

  async asset(sessionId, name) {
    try {
      return await this.store.readAsset(sessionId, name)
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }

  /**
   * The passes a run will queue, in order.
   *
   * A mask run repaints each painted region once, in paint order, chaining the
   * image: each pass's output is the next pass's input. A mask with no regions
   * (an older document, or an agent that painted through `load_image`) is one
   * implicit pass over the union mask carrying the legacy single prompt.
   */
  buildPasses({ doc, maskPass, maskDenoise, canvasPlan }) {
    if (!maskPass) {
      return [{
        regionId: null,
        prompt: canvasPlan.text,
        promptKind: canvasPlan.kind,
        denoise: null,
        maskBuffer: undefined,
      }]
    }
    const regions = Array.isArray(doc.mask?.regions) ? doc.mask.regions : []
    const list = regions.length > 0
      ? regions.map((region) => ({
        regionId: region.id,
        prompt: typeof region.prompt === 'string' ? region.prompt : '',
      }))
      : [{
        regionId: null,
        prompt: typeof doc.mask?.prompt === 'string' ? doc.mask.prompt : '',
      }]
    return list.map((entry) => {
      const plan = runPassPrompt({ regionPrompt: entry.prompt, maskPass: true })
      return {
        regionId: entry.regionId,
        prompt: plan.text,
        promptKind: plan.kind,
        denoise: maskDenoise,
        maskBuffer: undefined,
      }
    })
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

    const uploads = []
    const imageBuffer = await this.asset(sessionId, 'canvas.png')
    const rgbaBuffer = await this.asset(sessionId, 'canvas_rgba.png')
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
    // The whole-image caption is the layout item of type `summary`; it is the
    // only source the MOSS node's `prompt` input may receive.
    const promptNode = converted.prompt[String(bindings.prompt)]
    const mossLayout = promptNode?.class_type === 'MOSSImageLayoutPrompt' && doc.layout.items.length > 0
    const summaryCaption = layoutSummaryCaption(doc.layout.items)
    const maskPass = maskPainted && bindings.mask !== '' && !mossLayout
    // The repaint strength belongs to the mask, not to the workflow: every mask
    // pass writes the mask section's value (or the run override) into the
    // sampler's denoise. A full-image run keeps the workflow's own value.
    let maskDenoise = null
    if (maskPass) {
      const requested = Number.isFinite(Number(overrides.denoise)) ? Number(overrides.denoise) : Number(doc.mask?.denoise)
      if (Number.isFinite(requested)) maskDenoise = Math.min(1, Math.max(0, requested))
    }
    const canvasPlan = runPassPrompt({
      prompt: doc.prompt,
      summaryCaption: mossLayout ? summaryCaption : null,
    })
    if (mossLayout && String(canvasPlan.text).trim() === '') throw new Error('the layout needs a whole-image description box (label summary) before running')
    const passes = this.buildPasses({ doc, maskPass, maskDenoise, canvasPlan })
    // A mask region ships its own cutout; compose the union mask for the
    // implicit pass. Loading every region mask now means a missing asset fails
    // the run before anything is queued, naming the region.
    for (const pass of passes) {
      if (!maskPass) continue
      if (pass.regionId === null) {
        pass.maskBuffer = maskBuffer === null ? null : composeMaskImage(maskBuffer) ?? maskBuffer
        continue
      }
      const regionMask = await this.asset(sessionId, `mask-${pass.regionId}.png`)
      if (regionMask === null) {
        throw Object.assign(
          new Error(`region ${pass.regionId} has no mask asset (mask-${pass.regionId}.png); save the mask in the canvas again`),
          { status: 409 },
        )
      }
      pass.maskBuffer = regionMask
    }

    const legacyShape = bindings.mask !== '' && bindings.mask === bindings.image
    const passCount = passes.length
    const notes = guard.note === null ? [...converted.warnings] : [...converted.warnings, guard.note]
    let injectedNotes = null

    /** Upload one pass's inputs and queue its prompt. */
    const queuePass = async (index, imageBytes) => {
      const pass = passes[index - 1]
      // A multi-pass run needs distinct input names per pass; a single pass
      // keeps the names earlier hosts used.
      const suffix = passCount > 1 ? `-p${index}` : ''
      let imageName = null
      let maskName = null
      if (bindings.image) {
        if (legacyShape) {
          // This graph reads its mask from the image alpha, so each pass needs
          // its own cutout composed into the image.
          const unionPass = pass.regionId === null
          let composed = null
          const painted = unionPass ? maskBuffer : paintedMaskFromCutout(pass.maskBuffer)
          if (unionPass && rgbaBuffer !== null) composed = rgbaBuffer
          else if (painted !== null && imageBytes !== null) composed = composeMaskedImage(imageBytes, painted)
          if (composed === null && !unionPass) {
            throw Object.assign(
              new Error(`cannot apply the mask of region ${pass.regionId}: the canvas image has no alpha channel for it; load a workflow whose mask comes from a mask image (LoadImageMask)`),
              { status: 409 },
            )
          }
          if (composed !== null) {
            const uploaded = await this.comfy.uploadImage(composed, `${id}${suffix}-rgba.png`, { subfolder: '' })
            imageName = uploaded.name
            maskName = uploaded.name
            uploads.push(uploaded.name)
          } else if (imageBytes !== null) {
            // Same degradation as a single pass without canvas_rgba.png: the
            // plain image is uploaded and the graph uses its own alpha.
            const uploaded = await this.comfy.uploadImage(imageBytes, `${id}${suffix}-canvas.png`, { subfolder: '' })
            imageName = uploaded.name
            uploads.push(uploaded.name)
            notes.push('the canvas image has no alpha channel for the mask; the loaded image is used as-is')
          } else {
            throw new Error('the workflow binds an image node but the canvas has no image yet')
          }
        } else if (imageBytes !== null) {
          const uploaded = await this.comfy.uploadImage(imageBytes, `${id}${suffix}-canvas.png`, { subfolder: '' })
          imageName = uploaded.name
          uploads.push(uploaded.name)
        } else {
          throw new Error('the workflow binds an image node but the canvas has no image yet')
        }
      }
      if (bindings.mask && !legacyShape) {
        const maskUpload = pass.maskBuffer ?? (maskBuffer === null ? null : composeMaskImage(maskBuffer) ?? maskBuffer)
        if (maskUpload === null) throw new Error('the workflow binds a mask node but the canvas has no mask yet')
        // ComfyUI reads an image mask as 1 - alpha, while mask.png keeps the
        // painted region opaque. The cutout (painted = transparent) is what
        // LoadImage MASK, LoadImageMask alpha and LoadImageMask red all select.
        const uploaded = await this.comfy.uploadImage(maskUpload, `${id}${suffix}-mask.png`, { subfolder: '' })
        maskName = uploaded.name
        uploads.push(uploaded.name)
      }

      const values = {
        prompt: pass.prompt,
        negative: doc.negative ?? '',
        imageName,
        width: doc.canvas.width,
        height: doc.canvas.height,
        seed: Number.isFinite(overrides.seed) ? overrides.seed : undefined,
        denoise: pass.denoise ?? undefined,
      }
      if (mossLayout) {
        values.bboxesJson = JSON.stringify(layoutToElements({
          width: doc.canvas.width,
          height: doc.canvas.height,
          items: doc.layout.items,
        }))
      }
      const injected = applyBindings(converted.prompt, bindings, values)
      if (injectedNotes === null) injectedNotes = injected.notes
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
      return { promptId: queued.prompt_id, prompt }
    }

    const first = await queuePass(1, imageBuffer)
    const run = {
      id,
      // The first pass's id: following a run means reading its passes now.
      promptId: first.promptId,
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      workflowName: doc.workflow.name ?? null,
      // Which text drove the first pass, and the repaint strength every mask
      // pass wrote. Kept for the panel and for older `state` readers.
      promptKind: passes[0].promptKind,
      maskDenoise,
      passCount,
      passIndex: 1,
      passes: passes.map((pass, index) => ({
        index: index + 1,
        regionId: pass.regionId,
        promptId: index === 0 ? first.promptId : null,
        promptKind: pass.promptKind,
        prompt: pass.prompt,
        denoise: pass.denoise ?? null,
        status: 'queued',
        outputs: [],
        error: null,
      })),
      bindings,
      uploads,
      notes: [...notes, ...(injectedNotes ?? [])],
      outputs: [],
      error: null,
    }
    const plan = {
      passCount,
      current: 1,
      currentPromptId: first.promptId,
      passes: run.passes,
      uploads,
      queuePass,
    }
    this.plans.set(id, plan)
    await this.store.addRun(sessionId, run, { source: meta.agent === true ? 'agent' : 'user' })
    this.poll(sessionId, run, plan)
    return { run, prompt: first.prompt }
  }

  poll(sessionId, run, plan) {
    const startedAt = Date.now()
    let lastStatus = run.status
    const timer = setInterval(async () => {
      // Downloading a pass's outputs can outlast the interval, and two ticks
      // acting on the same history entry would advance the chain twice (and
      // skip a region). Only one tick may touch a plan at a time.
      if (plan.busy) return
      plan.busy = true
      try {
        if (Date.now() - startedAt > RUN_TIMEOUT_MS) {
          await this.finishRun(sessionId, run, plan, { status: 'failed', outputs: [], error: 'ComfyUI run timed out' }, 'failed')
          return
        }
        const promptId = plan.currentPromptId
        const history = await this.comfy.history(promptId)
        const entry = history?.[promptId]
        if (entry !== undefined) {
          const currentPass = plan.passes[plan.current - 1]
          if (entry.status?.status_str === 'error') {
            await this.finishRun(sessionId, run, plan, { status: 'failed', outputs: [], error: errorFromHistory(entry) }, 'failed')
            return
          }
          const outputs = await this.downloadOutputs(sessionId, run, entry.outputs ?? {}, passCountOf(plan))
          currentPass.status = 'completed'
          currentPass.outputs = outputs
          if (plan.current < plan.passCount) {
            const nextImage = await this.firstImageBytes(sessionId, outputs)
            if (nextImage === null) {
              await this.finishRun(sessionId, run, plan, {
                status: 'failed',
                outputs: [],
                error: `mask pass ${plan.current} produced no image output to feed the next region`,
              }, 'failed')
              return
            }
            plan.current += 1
            const nextPass = plan.passes[plan.current - 1]
            let queued
            try {
              queued = await plan.queuePass(plan.current, nextImage)
            } catch (error) {
              await this.finishRun(sessionId, run, plan, {
                status: 'failed',
                outputs: [],
                error: `could not queue mask pass ${plan.current}: ${errorMessage(error)}`,
              }, 'failed')
              return
            }
            plan.currentPromptId = queued.promptId
            nextPass.promptId = queued.promptId
            nextPass.status = 'queued'
            lastStatus = 'queued'
            await this.store.updateRun(sessionId, run.id, {
              status: 'queued',
              passIndex: plan.current,
              passes: plan.passes,
              uploads: plan.uploads,
            }, { source: 'run' })
            return
          }
          await this.finishRun(sessionId, run, plan, { status: 'completed', outputs, error: null }, 'completed')
          return
        }
        const queue = await this.comfy.queue()
        const running = (queue.queue_running ?? []).some((item) => Array.isArray(item) && item[1] === promptId)
        const pending = (queue.queue_pending ?? []).some((item) => Array.isArray(item) && item[1] === promptId)
        const status = running ? 'running' : pending ? 'queued' : lastStatus === 'queued' && Date.now() - startedAt < 30_000 ? 'queued' : 'running'
        if (status !== lastStatus) {
          lastStatus = status
          const currentPass = plan.passes[plan.current - 1]
          if (status === 'running' && currentPass.status === 'queued') currentPass.status = 'running'
          await this.store.updateRun(sessionId, run.id, { status, passes: plan.passes }, { source: 'run' })
        }
      } catch (error) {
        this.ctx.logger?.warn?.(`comfy-cowork: run ${run.id} poll failed: ${errorMessage(error)}`)
      } finally {
        plan.busy = false
      }
    }, this.pollIntervalMs)
    this.pollers.set(run.id, timer)
  }

  /** Stop polling and record the run's final state, marking the passes it never reached. */
  finishRun(sessionId, run, plan, patch, final) {
    const timer = this.pollers.get(run.id)
    if (timer !== undefined) {
      clearInterval(timer)
      this.pollers.delete(run.id)
    }
    this.plans.delete(run.id)
    for (const [offset, pass] of plan.passes.entries()) {
      const index = offset + 1
      if (index < plan.current) continue
      if (index === plan.current) {
        pass.status = final
        if (final === 'failed') pass.error = patch.error ?? null
      } else {
        pass.status = 'cancelled'
      }
    }
    return this.store.updateRun(sessionId, run.id, {
      ...patch,
      passes: plan.passes,
      passIndex: plan.current,
      passCount: plan.passCount,
      uploads: plan.uploads,
    }, { source: 'run' })
  }

  /** Keep the older single-pass bookkeeping in use for callers that never see a plan. */
  finish(sessionId, run, patch) {
    const timer = this.pollers.get(run.id)
    if (timer !== undefined) {
      clearInterval(timer)
      this.pollers.delete(run.id)
    }
    return this.store.updateRun(sessionId, run.id, patch, { source: 'run' })
  }

  /** The first image a pass produced, as bytes for the next pass's loader. */
  async firstImageBytes(sessionId, outputs) {
    for (const output of outputs) {
      if (output.kind !== 'images' || typeof output.asset !== 'string' || output.asset === '') continue
      const buffer = await this.asset(sessionId, output.asset)
      if (buffer !== null) return buffer
    }
    return null
  }

  async downloadOutputs(sessionId, run, outputs, passIndex = null) {
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
    // A multi-pass run saves every pass's outputs; the pass segment keeps the
    // later passes from overwriting the earlier ones.
    const prefix = passIndex === null ? `run-${run.id}` : `run-${run.id}-p${passIndex}`
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]
      const asset = `${prefix}-${index}-${sanitize(file.filename)}`
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
    const plan = this.plans.get(run.id)
    // With several passes the user sees one run, but only one prompt is
    // executing: cancel that pass and leave the rest unqueued.
    const promptId = plan?.currentPromptId ?? run.promptId
    await this.comfy.interrupt(promptId)
    const updated = plan !== undefined
      ? await this.finishRun(sessionId, run, plan, { status: 'cancelled', error: null }, 'cancelled')
      : await this.finish(sessionId, run, { status: 'cancelled', error: null })
    return updated.runs.find((entry) => entry.id === run.id) ?? run
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
    this.plans.clear()
  }
}

/** Only a multi-pass run needs the pass segment in its downloaded asset names. */
function passCountOf(plan) {
  return plan.passCount > 1 ? plan.current : null
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
