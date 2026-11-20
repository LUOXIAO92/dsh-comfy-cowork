/** UI-side workflow inspection helpers (no ComfyUI API calls). */

const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO'])
export const SEED_CONTROLS = ['fixed', 'increment', 'decrement', 'randomize']
const CONTROL = new Set(SEED_CONTROLS)
const SEED_NAMES = new Set(['seed', 'noise_seed'])

export function inputSpecs(info) {
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

function isWidget(spec) {
  if (spec.options?.forceInput === true) return false
  if (typeof spec.type === 'string') return WIDGET_TYPES.has(spec.type)
  if (Array.isArray(spec.type)) return true
  return false
}

export function comboOptions(spec) {
  if (Array.isArray(spec.type)) return spec.type
  const options = spec.options?.options
  return Array.isArray(options) ? options : []
}

/**
 * Positional slots of one node: the value index of every widget input, plus the
 * control token a seed widget carries after its value.
 */
export function widgetSlots(node) {
  const raw = Array.isArray(node?.widgets_values) ? node.widgets_values : []
  const slots = new Map()
  let index = 0
  for (const input of node?.inputs ?? []) {
    if (input?.widget === undefined) continue
    const name = input.widget.name ?? input.name
    if (index >= raw.length) break
    const value = raw[index]
    const slot = { index, value: undefined, control: null, controlIndex: -1 }
    index += 1
    if (typeof value === 'string' && CONTROL.has(value)) continue
    slot.value = value
    slots.set(name, slot)
    if (SEED_NAMES.has(name) && typeof raw[index] === 'string' && CONTROL.has(raw[index])) {
      slot.control = raw[index]
      slot.controlIndex = index
      index += 1
    }
  }
  return slots
}

export function widgetIndex(node, name) {
  const slot = widgetSlots(node).get(name)
  return slot === undefined ? -1 : slot.index
}

/** A seed widget the graph actually drives (a linked input has no editable value). */
export function isSeedWidget(node, name) {
  if (!SEED_NAMES.has(name)) return false
  const input = (node.inputs ?? []).find((entry) => (entry?.widget?.name ?? entry?.name) === name)
  return input !== undefined && (input.link === null || input.link === undefined)
}

/** True when the seed's positional slot exists, so its control token can be written. */
export function canSetSeedControl(node, name) {
  return isSeedWidget(node, name) && widgetSlots(node).has(name)
}

/** The stored mode, with ComfyUI's own default when the file has no token yet. */
export function seedControlOf(node, name) {
  return widgetSlots(node).get(name)?.control ?? 'randomize'
}

/** Write one seed's control token into a cloned workflow. */
export function setSeedControl(workflow, nodeId, name, control) {
  const next = JSON.parse(JSON.stringify(workflow))
  if (!CONTROL.has(control)) return next
  const node = (next.nodes ?? []).find((entry) => String(entry.id) === String(nodeId))
  if (node === undefined || !Array.isArray(node.widgets_values)) return next
  const slot = widgetSlots(node).get(name)
  if (slot === undefined) return next
  if (slot.controlIndex >= 0) node.widgets_values[slot.controlIndex] = control
  else node.widgets_values.splice(slot.index + 1, 0, control)
  return next
}

export function nodeWidgets(node, info) {
  const specs = inputSpecs(info)
  const named = node.widgets_values_named !== null && typeof node.widgets_values_named === 'object' && !Array.isArray(node.widgets_values_named)
    ? node.widgets_values_named
    : null
  const values = Array.isArray(node.widgets_values) ? node.widgets_values : []
  const result = []
  for (const spec of specs) {
    if (!isWidget(spec)) continue
    const hasNamed = named !== null && Object.prototype.hasOwnProperty.call(named, spec.name)
    const index = widgetIndex(node, spec.name)
    const stored = hasNamed ? named[spec.name] : (index >= 0 && index < values.length ? values[index] : undefined)
    // Every widget the node type declares is listed; a widget the workflow never
    // stored keeps its default and is flagged, so "empty means default" stays visible.
    const fallback = spec.options?.default ?? comboOptions(spec)[0] ?? (typeof spec.type === 'string' && spec.type === 'BOOLEAN' ? false : '')
    result.push({ ...spec, value: stored === undefined ? fallback : stored, missing: stored === undefined })
  }
  return result
}

export function setNodeWidget(workflow, nodeId, name, value, info) {
  const next = JSON.parse(JSON.stringify(workflow))
  const node = (next.nodes ?? []).find((entry) => String(entry.id) === String(nodeId))
  if (node === undefined) return next
  if (node.widgets_values_named === null || typeof node.widgets_values_named !== 'object' || Array.isArray(node.widgets_values_named)) {
    node.widgets_values_named = {}
  }
  node.widgets_values_named[name] = value
  const index = widgetIndex(node, name)
  if (!Array.isArray(node.widgets_values)) node.widgets_values = []
  if (index >= 0) node.widgets_values[index] = value
  else {
    const specs = nodeWidgets(node, info)
    const position = specs.findIndex((spec) => spec.name === name)
    if (position >= 0) node.widgets_values[position] = value
  }
  return next
}

export function nodeTitle(node) {
  return node?.title || node?.type || 'Node'
}

export function nodeSize(node) {
  const width = Array.isArray(node?.size) ? Number(node.size[0]) : 240
  const height = Array.isArray(node?.size) ? Number(node.size[1]) : 120
  return {
    width: Number.isFinite(width) && width > 60 ? width : 240,
    height: Number.isFinite(height) && height > 60 ? height : 120,
  }
}

export function workflowBounds(workflow) {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : []
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const node of nodes) {
    const x = Array.isArray(node.pos) ? Number(node.pos[0]) : 0
    const y = Array.isArray(node.pos) ? Number(node.pos[1]) : 0
    const size = nodeSize(node)
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x + size.width)
    maxY = Math.max(maxY, y + size.height)
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 900, maxY: 500, width: 900, height: 500 }
  const pad = 60
  return {
    minX: minX - pad,
    minY: minY - pad,
    maxX: maxX + pad,
    maxY: maxY + pad,
    width: maxX - minX + pad * 2,
    height: maxY - minY + pad * 2,
  }
}

export function workflowLinks(workflow) {
  const result = []
  for (const raw of workflow?.links ?? []) {
    if (Array.isArray(raw) && raw.length >= 5) {
      result.push({
        id: Number(raw[0]),
        originId: Number(raw[1]),
        originSlot: Number(raw[2]),
        targetId: Number(raw[3]),
        targetSlot: Number(raw[4]),
      })
    } else if (raw !== null && typeof raw === 'object') {
      const origin = Array.isArray(raw.origin) ? raw.origin : [raw.origin_id, raw.origin_slot]
      const target = Array.isArray(raw.target) ? raw.target : [raw.target_id, raw.target_slot]
      result.push({
        id: Number(raw.id),
        originId: Number(origin[0]),
        originSlot: Number(origin[1]),
        targetId: Number(target[0]),
        targetSlot: Number(target[1]),
      })
    }
  }
  return result
}
