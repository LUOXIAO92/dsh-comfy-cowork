/**
 * ComfyUI UI-workflow → API-prompt conversion.
 *
 * The frontend normally performs this in the browser; the plugin needs it on
 * the Host so a workflow loaded from userdata can be queued through /prompt.
 */

const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO'])
const CONTROL_VALUES = new Set(['fixed', 'increment', 'decrement', 'randomize'])
const SKIP_TYPES = new Set(['Note', 'MarkdownNote', 'Reroute', 'PrimitiveNode', 'Primitive'])

function isApiPrompt(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.entries(value)
  return entries.length > 0 && entries.every(([, node]) => node !== null && typeof node === 'object' && typeof node.class_type === 'string')
}

function linkTuple(link) {
  if (Array.isArray(link) && link.length >= 5) {
    return {
      id: Number(link[0]),
      originId: Number(link[1]),
      originSlot: Number(link[2]),
      targetId: Number(link[3]),
      targetSlot: Number(link[4]),
      type: link[5] ?? null,
    }
  }
  if (link !== null && typeof link === 'object') {
    const origin = Array.isArray(link.origin) ? link.origin : [link.origin_id, link.origin_slot]
    const target = Array.isArray(link.target) ? link.target : [link.target_id, link.target_slot]
    return {
      id: Number(link.id),
      originId: Number(origin[0]),
      originSlot: Number(origin[1]),
      targetId: Number(target[0]),
      targetSlot: Number(target[1]),
      type: link.type ?? null,
    }
  }
  return null
}

function inputSpecs(info) {
  const required = info?.input?.required ?? {}
  const optional = info?.input?.optional ?? {}
  const order = []
  if (Array.isArray(info?.input_order?.required)) order.push(...info.input_order.required)
  else order.push(...Object.keys(required))
  if (Array.isArray(info?.input_order?.optional)) order.push(...info.input_order.optional)
  else order.push(...Object.keys(optional))
  return order
    .filter((name) => required[name] !== undefined || optional[name] !== undefined)
    .map((name) => {
      const spec = required[name] ?? optional[name]
      const [type, options] = Array.isArray(spec) ? spec : [spec, {}]
      return { name, type, options: options ?? {}, required: required[name] !== undefined }
    })
}

function isWidgetSpec(spec) {
  if (spec.options?.forceInput === true) return false
  if (typeof spec.type === 'string') return WIDGET_TYPES.has(spec.type)
  if (Array.isArray(spec.type)) return true
  return false
}

function widgetValues(node, specs) {
  const named = node.widgets_values_named
  if (named !== null && typeof named === 'object' && !Array.isArray(named)) {
    return { byName: named, positional: null }
  }
  const raw = Array.isArray(node.widgets_values) ? node.widgets_values : []
  const positional = new Map()
  let index = 0
  for (const input of node.inputs ?? []) {
    if (input?.widget === undefined) continue
    const name = input.widget.name ?? input.name
    if (index >= raw.length) break
    const value = raw[index]
    index += 1
    if (typeof value === 'string' && CONTROL_VALUES.has(value)) continue
    positional.set(name, value)
  }
  return { byName: null, positional }
}

function hasExplicitValue(spec, values) {
  if (values.byName !== null && Object.prototype.hasOwnProperty.call(values.byName, spec.name)) return true
  return values.positional !== null && values.positional.has(spec.name)
}

function valueFor(spec, values, info) {
  if (values.byName !== null && Object.prototype.hasOwnProperty.call(values.byName, spec.name)) return values.byName[spec.name]
  if (values.positional !== null && values.positional.has(spec.name)) return values.positional.get(spec.name)
  const fallback = spec.options?.default
  if (fallback !== undefined) return fallback
  if (spec.type === 'STRING') return ''
  if (spec.type === 'BOOLEAN') return false
  if (spec.type === 'INT' || spec.type === 'FLOAT') return 0
  return undefined
}

/**
 * Convert a UI workflow into the API prompt format.
 * @param {object} workflow - UI workflow (nodes/links) or API prompt.
 * @param {object} objectInfo - /object_info payload keyed by node class.
 * @returns {{prompt: object, warnings: string[], api: boolean}}
 */
export function workflowToPrompt(workflow, objectInfo) {
  if (isApiPrompt(workflow)) {
    return { prompt: structuredClone(workflow), warnings: [], api: true }
  }
  if (workflow === null || typeof workflow !== 'object' || !Array.isArray(workflow.nodes)) {
    throw new Error('workflow must contain a nodes array or be an API-format prompt')
  }
  if (Array.isArray(workflow.definitions?.subgraphs) && workflow.definitions.subgraphs.length > 0) {
    throw new Error('subgraph workflows are not supported yet; flatten the subgraph in ComfyUI and save again')
  }

  const nodes = new Map()
  for (const node of workflow.nodes) {
    if (node !== null && typeof node === 'object') nodes.set(Number(node.id), node)
  }
  const links = new Map()
  for (const raw of workflow.links ?? []) {
    const link = linkTuple(raw)
    if (link !== null) links.set(link.id, link)
  }
  const setNodes = new Map()
  for (const node of workflow.nodes) {
    if (node?.type === 'SetNode' && Array.isArray(node.widgets_values) && typeof node.widgets_values[0] === 'string') {
      setNodes.set(node.widgets_values[0], node)
    }
  }

  const warnings = []
  function resolveLink(linkId, seen = new Set()) {
    if (linkId === null || linkId === undefined || seen.has(linkId)) return null
    seen.add(linkId)
    const link = links.get(Number(linkId))
    if (link === undefined) return null
    const origin = nodes.get(link.originId)
    if (origin === undefined) return null
    if (origin.mode === 2) return null
    if (origin.type === 'Reroute') {
      const inputLink = origin.inputs?.[0]?.link
      return inputLink === null || inputLink === undefined ? null : resolveLink(inputLink, seen)
    }
    if (origin.type === 'PrimitiveNode' || origin.type === 'Primitive') {
      const value = Array.isArray(origin.widgets_values) ? origin.widgets_values[0] : undefined
      return value === undefined ? null : { value }
    }
    if (origin.type === 'GetNode') {
      const name = Array.isArray(origin.widgets_values) ? origin.widgets_values[0] : null
      const setter = setNodes.get(name)
      if (setter === undefined) return null
      const inputLink = setter.inputs?.[0]?.link
      return inputLink === null || inputLink === undefined ? null : resolveLink(inputLink, seen)
    }
    if (origin.mode === 4) {
      const outputType = origin.outputs?.[link.originSlot]?.type ?? link.type
      const candidate = (origin.inputs ?? []).find((input) => input.link !== null && input.link !== undefined
        && (input.type === outputType || input.type === '*' || outputType === '*'))
      return candidate === undefined ? null : resolveLink(candidate.link, seen)
    }
    return { link: [String(origin.id), link.originSlot] }
  }

  const prompt = {}
  for (const node of workflow.nodes) {
    if (node === null || typeof node !== 'object') continue
    if (SKIP_TYPES.has(node.type) || node.mode === 2 || node.mode === 4) continue
    const info = objectInfo?.[node.type]
    if (info === undefined) warnings.push(`unknown node class "${node.type}" (node ${node.id}); passing it through`)
    const specs = inputSpecs(info)
    const specByName = new Map(specs.map((spec) => [spec.name, spec]))
    const values = widgetValues(node, specs)
    const inputs = {}

    for (const input of node.inputs ?? []) {
      const name = input?.name
      if (typeof name !== 'string' || name === '') continue
      if (input.link !== null && input.link !== undefined) {
        const resolved = resolveLink(input.link)
        if (resolved === null) {
          warnings.push(`node ${node.id} (${node.type}) input "${name}" is linked to a muted/missing node`)
        } else if (resolved.link !== undefined) {
          inputs[name] = resolved.link
        } else if (resolved.value !== undefined) {
          inputs[name] = resolved.value
        }
        continue
      }
      const spec = specByName.get(name)
      if (spec !== undefined && isWidgetSpec(spec)) {
        if (!spec.required && !hasExplicitValue(spec, values) && spec.options?.default === undefined) continue
        const value = valueFor(spec, values, info)
        if (value !== undefined) inputs[name] = value
      } else if (spec !== undefined && input.widget !== undefined) {
        if (!spec.required && !hasExplicitValue(spec, values) && spec.options?.default === undefined) continue
        const value = valueFor(spec, values, info)
        if (value !== undefined) inputs[name] = value
      }
    }

    for (const spec of specs) {
      if (inputs[spec.name] !== undefined) continue
      if (isWidgetSpec(spec)) {
        if (!spec.required && !hasExplicitValue(spec, values) && spec.options?.default === undefined) continue
        const value = valueFor(spec, values, info)
        if (value !== undefined) inputs[spec.name] = value
        continue
      }
      if (spec.required && spec.options?.default !== undefined) {
        // ComfyUI's API validator treats every array as a [node, slot] link, so a
        // list-typed widget default (BOUNDING_BOXES editor_state) must be sent as JSON text.
        inputs[spec.name] = spec.type === 'BOUNDING_BOXES'
          ? JSON.stringify(spec.options.default)
          : JSON.parse(JSON.stringify(spec.options.default))
      }
    }

    const entry = { class_type: node.type, inputs }
    if (typeof node.title === 'string' && node.title.trim() !== '') entry._meta = { title: node.title }
    prompt[String(node.id)] = entry
  }

  if (Object.keys(prompt).length === 0) throw new Error('workflow produced no executable nodes')
  return { prompt, warnings, api: false }
}

/** Infer which nodes should receive prompt, image, mask, width/height, and seed. */
export function inferBindings(workflow, objectInfo) {
  const nodes = Array.isArray(workflow?.nodes)
    ? workflow.nodes.filter((node) => node !== null && typeof node === 'object' && node.mode !== 2)
    : []
  const bindings = {
    prompt: '',
    negative: '',
    image: '',
    mask: '',
    width: '',
    height: '',
    seed: '',
    bboxes: '',
    denoise: '',
  }
  if (nodes.length === 0) return bindings

  const textNodes = nodes.filter((node) => node.type === 'CLIPTextEncode' || (objectInfo?.[node.type]?.output ?? []).includes('CONDITIONING'))
  const positive = textNodes.find((node) => /positiv/i.test(node.title ?? '')) ?? textNodes[0]
  const moss = nodes.find((node) => node.type === 'MOSSImageLayoutPrompt')
  if (moss !== undefined) bindings.prompt = String(moss.id)
  else if (positive !== undefined) bindings.prompt = String(positive.id)

  // Negative prompt: the text node wired into a sampler's `negative` input.
  const negativeHost = nodes.find((node) => (node.inputs ?? []).some((input) => input.name === 'negative'))
  if (negativeHost !== undefined) {
    const slot = (negativeHost.inputs ?? []).findIndex((input) => input.name === 'negative')
    const link = (Array.isArray(workflow?.links) ? workflow.links : [])
      .find((entry) => Array.isArray(entry) && String(entry[3]) === String(negativeHost.id) && Number(entry[4]) === slot)
    if (link !== undefined) bindings.negative = String(link[1])
  }

  // A node only matters when a path from it reaches an output node. Outputs
  // are nodes that produce no value (SaveImage, PreviewImage, …); a dangling
  // node with declared outputs is not an output, so it can never qualify.
  const byId = new Map(nodes.map((node) => [String(node.id), node]))
  const links = (Array.isArray(workflow?.links) ? workflow.links : [])
    .filter((entry) => Array.isArray(entry) && byId.has(String(entry[1])) && byId.has(String(entry[3])))
  const sinks = nodes.filter((node) => !Array.isArray(node.outputs) || node.outputs.length === 0)
  const feedsOutput = new Set(sinks.map((node) => String(node.id)))
  let grew = true
  while (grew) {
    grew = false
    for (const link of links) {
      const source = String(link[1])
      if (!feedsOutput.has(String(link[3])) || feedsOutput.has(source)) continue
      feedsOutput.add(source)
      grew = true
    }
  }

  // The canvas image is the image loader whose IMAGE output feeds an output
  // node. A loader that only feeds a mask chain (its MASK output) is not it.
  const imageLoaders = new Set(['LoadImage', 'LoadImageOutput'])
  const imageNode = nodes.find((node) => {
    if (!imageLoaders.has(node.type)) return false
    const slot = (node.outputs ?? []).findIndex((output) => output.type === 'IMAGE')
    if (slot < 0) return false
    return links.some((entry) => String(entry[1]) === String(node.id) && Number(entry[2]) === slot && feedsOutput.has(String(entry[3])))
  })
  if (imageNode !== undefined) bindings.image = String(imageNode.id)

  // The mask only counts through a real repaint consumer that reaches an
  // output. Compositing nodes such as ImageCompositeMasked also have a mask
  // input but do not repaint, so they are deliberately absent here.
  const inpaintConsumers = new Set(['VAEEncodeForInpaint', 'SetLatentNoiseMask', 'InpaintModelConditioning'])
  const sourceFor = (node, slot) => links.find((entry) => String(entry[3]) === String(node.id) && Number(entry[4]) === slot)
  // Any mask-in/mask-out node is a pass-through on the mask path. That covers
  // the core mask nodes and the crop-and-paste nodes an "inpaint at full
  // resolution" graph uses (ImageCropByMaskAndResize, GrowMaskWithBlur, …),
  // without listing every custom node by name.
  const maskInputSlot = (node) => (node.inputs ?? []).findIndex((input) => input?.name === 'mask')
  const declaresMaskOutput = (node) => {
    if ((node.outputs ?? []).some((output) => output?.type === 'MASK')) return true
    const declared = objectInfo?.[node.type]?.output
    return Array.isArray(declared) && declared.includes('MASK')
  }
  const maskPathSlot = (node) => {
    if (node.type === 'ImageToMask') return (node.inputs ?? []).findIndex((input) => input?.name === 'image')
    return maskInputSlot(node)
  }
  const tracesMask = (node) => {
    if (node.type === 'ImageToMask') return true
    if (['GrowMask', 'FeatherMask', 'InvertMask', 'MaskBlur', 'MaskToImage'].includes(node.type)) return maskInputSlot(node) >= 0
    if (inpaintConsumers.has(node.type)) return false
    return maskInputSlot(node) >= 0 && declaresMaskOutput(node)
  }
  const traceMask = (nodeId, depth = 0) => {
    if (depth > 12) return null
    const node = byId.get(String(nodeId))
    if (node === undefined) return null
    if (node.type === 'LoadImageMask' || node.type === 'LoadImage') return node
    if (!tracesMask(node)) return null
    const slot = maskPathSlot(node)
    if (slot < 0) return null
    const link = sourceFor(node, slot)
    return link === undefined ? null : traceMask(link[1], depth + 1)
  }
  let maskNode = null
  for (const node of nodes) {
    if (!inpaintConsumers.has(node.type)) continue
    if (!feedsOutput.has(String(node.id))) continue
    const slot = (node.inputs ?? []).findIndex((input) => input.name === 'mask')
    if (slot < 0) continue
    const link = sourceFor(node, slot)
    if (link === undefined) continue
    const traced = traceMask(link[1])
    if (traced !== null) {
      maskNode = traced
      break
    }
  }
  if (maskNode !== null) bindings.mask = String(maskNode.id)

  // The canvas size must reach the node that actually decides the rendered
  // image size. The first node with width/height inputs is often a helper
  // (MOSS-Image's CreateBoundingBoxes, a layout-prompt node), not the latent
  // that EmptyFlux2LatentImage and friends create: binding those silently
  // renders the workflow's own 1024x1024 while the canvas said something else.
  // Prefer an Empty* latent/image node that reaches an output, then any node
  // with a LATENT output on the output path, then the first candidate.
  const hasInput = (node, name) => (node.inputs ?? []).some((input) => input?.name === name)
  const sizeCandidates = nodes.filter((node) => hasInput(node, 'width') && hasInput(node, 'height'))
  const sizeScore = (node) => {
    let score = 0
    if (/^Empty/i.test(String(node.type ?? ''))) score += 4
    if ((node.outputs ?? []).some((output) => output?.type === 'LATENT')) score += 2
    if (feedsOutput.has(String(node.id))) score += 1
    return score
  }
  let sizeNode
  for (const node of sizeCandidates) {
    if (sizeNode === undefined || sizeScore(node) > sizeScore(sizeNode)) sizeNode = node
  }
  if (sizeNode !== undefined) {
    bindings.width = String(sizeNode.id)
    bindings.height = String(sizeNode.id)
  }
  const seedNode = nodes.find((node) => node.type === 'KSampler' || (node.inputs ?? []).some((input) => input.name === 'seed'))
  if (seedNode !== undefined) bindings.seed = String(seedNode.id)
  // The repaint-strength knob: the sampler's denoise input. A mask run writes
  // the mask section's strength into it instead of the workflow's own value.
  const denoiseNode = nodes.find((node) => (node.inputs ?? []).some((input) => input?.name === 'denoise') && feedsOutput.has(String(node.id)))
  if (denoiseNode !== undefined) bindings.denoise = String(denoiseNode.id)
  const boxes = nodes.find((node) => node.type === 'CreateBoundingBoxes')
  if (boxes !== undefined) bindings.bboxes = String(boxes.id)
  return bindings
}

/**
 * Inject the canvas values into an API prompt.
 * @returns {{prompt: object, notes: string[]}}
 */
export function applyBindings(prompt, bindings, values) {
  const notes = []
  const clone = structuredClone(prompt)
  const node = (id) => (id !== undefined && id !== '' && clone[String(id)] !== undefined ? clone[String(id)] : null)

  const promptNode = node(bindings?.prompt)
  if (promptNode !== null) {
    const existing = ['text', 'prompt', 'string', 'value'].find((key) => typeof promptNode.inputs?.[key] === 'string')
    const fallback = promptNode.inputs?.prompt !== undefined ? 'prompt' : 'text'
    promptNode.inputs[existing ?? fallback] = values.prompt
  } else if (values.prompt !== undefined) {
    notes.push('no prompt node is bound')
  }

  if (values.negative !== undefined) {
    const negativeNode = node(bindings?.negative)
    if (negativeNode !== null) {
      const existing = ['text', 'prompt', 'string', 'value'].find((key) => typeof negativeNode.inputs?.[key] === 'string')
      const fallback = negativeNode.inputs?.prompt !== undefined ? 'prompt' : 'text'
      negativeNode.inputs[existing ?? fallback] = values.negative
    } else if (String(values.negative).trim() !== '') {
      notes.push('no negative prompt node is bound')
    }
  }

  if (values.imageName) {
    const imageNode = node(bindings?.image)
    if (imageNode !== null) {
      const key = ['image', 'image_path', 'filename'].find((name) => imageNode.inputs?.[name] !== undefined)
      const resolvedKey = key ?? (imageNode.class_type === 'LoadImage' || imageNode.class_type === 'LoadImageMask' ? 'image' : undefined)
      if (resolvedKey !== undefined) imageNode.inputs[resolvedKey] = values.imageName
      else notes.push(`image node ${bindings.image} has no image input`)
    } else {
      notes.push('no image node is bound')
    }
  }

  if (values.width !== undefined && values.width !== null) {
    const widthNode = node(bindings?.width)
    if (widthNode !== null && widthNode.inputs?.width !== undefined) widthNode.inputs.width = values.width
    else if (values.width !== undefined) notes.push('no width node is bound')
  }
  if (values.height !== undefined && values.height !== null) {
    const heightNode = node(bindings?.height)
    if (heightNode !== null && heightNode.inputs?.height !== undefined) heightNode.inputs.height = values.height
    else notes.push('no height node is bound')
  }
  if (values.seed !== undefined && values.seed !== null) {
    const seedNode = node(bindings?.seed)
    if (seedNode !== null) {
      seedNode.inputs.seed = values.seed
      if (seedNode.inputs.control_after_generate !== undefined) seedNode.inputs.control_after_generate = 'fixed'
    } else notes.push('no seed node is bound')
  }
  if (values.denoise !== undefined && values.denoise !== null) {
    const denoiseNode = node(bindings?.denoise)
    if (denoiseNode !== null && denoiseNode.inputs?.denoise !== undefined) denoiseNode.inputs.denoise = values.denoise
    else notes.push('no denoise node is bound')
  }
  if (values.bboxesJson !== undefined && values.bboxesJson !== null) {
    const boxesNode = node(bindings?.bboxes)
    if (boxesNode !== null) boxesNode.inputs.bboxes = values.bboxesJson
  }
  return { prompt: clone, notes }
}
