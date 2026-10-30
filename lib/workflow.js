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
    image: '',
    mask: '',
    width: '',
    height: '',
    seed: '',
    bboxes: '',
  }
  if (nodes.length === 0) return bindings

  const textNodes = nodes.filter((node) => node.type === 'CLIPTextEncode' || (objectInfo?.[node.type]?.output ?? []).includes('CONDITIONING'))
  const positive = textNodes.find((node) => /positiv/i.test(node.title ?? '')) ?? textNodes[0]
  const moss = nodes.find((node) => node.type === 'MOSSImageLayoutPrompt')
  if (moss !== undefined) bindings.prompt = String(moss.id)
  else if (positive !== undefined) bindings.prompt = String(positive.id)

  const loadImages = nodes.filter((node) => node.type === 'LoadImage' || node.type === 'LoadImageMask')
  const loadImage = loadImages.find((node) => node.type === 'LoadImage')
  if (loadImage !== undefined) {
    bindings.image = String(loadImage.id)
    if ((loadImage.outputs ?? []).some((output) => output.type === 'MASK')) bindings.mask = String(loadImage.id)
  }
  const loadMask = loadImages.find((node) => node.type === 'LoadImageMask')
  if (loadMask !== undefined) bindings.mask = String(loadMask.id)

  const sizeNode = nodes.find((node) => (node.inputs ?? []).some((input) => input.name === 'width')
    && (node.inputs ?? []).some((input) => input.name === 'height'))
  if (sizeNode !== undefined) {
    bindings.width = String(sizeNode.id)
    bindings.height = String(sizeNode.id)
  }
  const seedNode = nodes.find((node) => node.type === 'KSampler' || (node.inputs ?? []).some((input) => input.name === 'seed'))
  if (seedNode !== undefined) bindings.seed = String(seedNode.id)
  const boxes = nodes.find((node) => node.type === 'CreateBoundingBoxes')
  if (boxes !== undefined) bindings.bboxes = String(boxes.id)
  return bindings
}

/** Canvas roles a workflow node can declare for itself. */
export const BINDING_ROLES = ['prompt', 'image', 'mask', 'width', 'height', 'seed', 'bboxes']

/**
 * Resolve the canvas injection mapping from the workflow JSON itself.
 *
 * A node may carry `ccw: '<role>'` — or `ccw: 'size'` for a node whose width and
 * height both come from the canvas, and `ccw: 'none'` to keep a node out of
 * inference. Everything undeclared falls back to {@link inferBindings}, so a
 * workflow written by ComfyUI keeps working without any plugin metadata, and a
 * mapping the user sets once travels with the file back into ComfyUI.
 * @param workflow - ComfyUI UI-format workflow.
 * @param objectInfo - `/object_info` payload used by inference.
 */
export function bindingsFromWorkflow(workflow, objectInfo) {
  const bindings = inferBindings(workflow, objectInfo)
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : []
  const declared = []
  const excluded = new Set()
  for (const node of nodes) {
    if (node === null || typeof node !== 'object') continue
    const role = typeof node.ccw === 'string' ? node.ccw.trim() : ''
    if (role === '') continue
    if (role === 'none') excluded.add(String(node.id))
    else declared.push([String(node.id), role])
  }

  // An explicit `none` wins over inference for that node.
  for (const key of Object.keys(bindings)) {
    if (bindings[key] !== '' && excluded.has(bindings[key])) bindings[key] = ''
  }

  for (const [id, role] of declared) {
    if (role === 'size' || role === 'width' || role === 'height') {
      for (const key of Object.keys(bindings)) {
        if (bindings[key] === id && key !== 'width' && key !== 'height') bindings[key] = ''
      }
      if (role !== 'height') bindings.width = id
      if (role !== 'width') bindings.height = id
      continue
    }
    if (!BINDING_ROLES.includes(role)) continue
    // A node keeps a second role only for the image/mask pair: one LoadImage
    // feeds both the RGBA image and its alpha-derived mask.
    for (const key of Object.keys(bindings)) {
      if (bindings[key] !== id || key === role) continue
      if (role === 'image' && key === 'mask') continue
      bindings[key] = ''
    }
    bindings[role] = id
  }
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
  if (values.bboxesJson !== undefined && values.bboxesJson !== null) {
    const boxesNode = node(bindings?.bboxes)
    if (boxesNode !== null) boxesNode.inputs.bboxes = values.bboxesJson
  }
  return { prompt: clone, notes }
}
