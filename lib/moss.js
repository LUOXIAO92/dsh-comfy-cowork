/**
 * MOSS-Image layout prompt compilation.
 *
 * The compiled form must stay byte-compatible with ComfyUI's
 * comfy_extras/nodes_moss_image.py (MOSSImageLayoutPrompt):
 *   {"summary":{"caption":...},"items":[...],"bbox_coord_space":"abs_centralized","bbox_format":"yxyx"}
 * with bbox = [floor(y1)-H//2, floor(x1)-W//2, ceil(y2)-H//2, ceil(x2)-W//2].
 *
 * In the editable layout the whole-image caption is not a separate field: it is
 * one layout item whose label is `summary`. It is not spatial (MOSS has no box
 * for the summary), so it never reaches `items`; its caption becomes
 * `summary.caption`. At most one such item may exist.
 *
 * Shared by the Host half and the browser bundle; keep it free of Node/browser APIs.
 */

const LABELS = new Set(['object', 'character', 'text'])

/** The item label that carries the whole-image caption. */
export const SUMMARY_LABEL = 'summary'

export const MOSS_COORD_SPACE = 'abs_centralized'
export const MOSS_BBOX_FORMAT = 'yxyx'

export function isSummaryItem(item) {
  return item !== null && typeof item === 'object' && !Array.isArray(item) && item.label === SUMMARY_LABEL
}

/** The layout items that carry a real box (everything except the summary). */
export function spatialItems(items) {
  return (Array.isArray(items) ? items : []).filter((item) => !isSummaryItem(item))
}

/** The whole-image caption held by the one summary item, or ''. */
export function layoutSummaryCaption(items) {
  const item = (Array.isArray(items) ? items : []).find(isSummaryItem)
  return item === undefined ? '' : String(item.caption ?? '')
}

/** Order items with the summary first, keeping every other item's relative order. */
export function summaryFirst(items) {
  const list = Array.isArray(items) ? items : []
  return [...list.filter(isSummaryItem), ...list.filter((item) => !isSummaryItem(item))]
}

export function normalizeBox(box) {
  if (!Array.isArray(box) || box.length !== 4) return null
  const [x1, y1, x2, y2] = box.map((v) => Number(v))
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null
  return {
    x1: Math.min(x1, x2),
    y1: Math.min(y1, y2),
    x2: Math.max(x1, x2),
    y2: Math.max(y1, y2),
  }
}

export function boxWidth(box) {
  return Math.max(0, box.x2 - box.x1)
}

export function boxHeight(box) {
  return Math.max(0, box.y2 - box.y1)
}

/**
 * Validate a layout against the MOSS-Image constraints.
 * @param {{width:number,height:number,items?:Array}} layout
 * @returns {string[]} human-readable errors
 */
export function validateLayout(layout) {
  const errors = []
  const width = Number(layout?.width)
  const height = Number(layout?.height)
  for (const [name, value] of [['width', width], ['height', height]]) {
    if (!Number.isInteger(value) || value <= 0) errors.push(`${name} must be a positive integer`)
    else if (value % 16 !== 0) errors.push(`${name} must be a multiple of 16 (MOSS-Image requirement)`)
  }
  const items = Array.isArray(layout?.items) ? layout.items : []
  if (items.length === 0) return errors
  const summaries = items.filter(isSummaryItem)
  if (summaries.length > 1) errors.push('only one whole-image description item (label summary) is allowed')
  for (const item of summaries) {
    if (!String(item?.caption ?? '').trim()) errors.push('the whole-image description item (label summary) must not be empty')
  }
  const boxes = spatialItems(items)
  if (boxes.length > 0 && summaries.length === 0) {
    errors.push('the layout needs one whole-image description item (label summary)')
  }
  boxes.forEach((item, index) => {
    const at = `items[${index}]`
    if (!LABELS.has(item?.label)) errors.push(`${at}.label must be object, character or text (box ${index + 1})`)
    if (!String(item?.caption ?? '').trim()) errors.push(`${at}.caption must not be empty (box ${index + 1})`)
    if (item?.label === 'text' && !String(item?.text ?? '').trim()) errors.push(`${at}.text is required for a text item`)
    const box = normalizeBox(item?.bbox)
    if (box === null) {
      errors.push(`${at}.bbox must be four finite numbers [x1,y1,x2,y2]`)
      return
    }
    if (boxWidth(box) <= 0 || boxHeight(box) <= 0) errors.push(`${at}.bbox must have a positive width and height`)
    if (!(box.x1 >= 0 && box.y1 >= 0 && box.x2 <= width && box.y2 <= height)) {
      errors.push(`${at}.bbox exceeds the ${width}x${height} canvas`)
    }
  })
  return errors
}

function compileItem(item, width, height) {
  const box = normalizeBox(item.bbox)
  const w2 = Math.floor(width / 2)
  const h2 = Math.floor(height / 2)
  const result = {
    label: item.label,
    caption: String(item.caption ?? ''),
  }
  if (item.label === 'text') result.text = String(item.text ?? '')
  const palette = Array.isArray(item.palette) ? item.palette.filter((c) => typeof c === 'string' && c.trim() !== '') : []
  if (palette.length > 0) result.palette = palette
  result.bbox = [
    Math.floor(box.y1) - h2,
    Math.floor(box.x1) - w2,
    Math.ceil(box.y2) - h2,
    Math.ceil(box.x2) - w2,
  ]
  return result
}

/**
 * Compile the editable layout into the exact string MOSS-Image consumes.
 * Throws when the layout is invalid, so callers surface a concrete reason.
 */
export function compileMossLayout(layout) {
  const errors = validateLayout(layout)
  if (errors.length > 0) throw new Error(errors.join('; '))
  const items = spatialItems(layout.items)
  const compiled = {
    summary: { caption: layoutSummaryCaption(layout.items).trim() },
    items: items.map((item) => compileItem(item, layout.width, layout.height)),
    bbox_coord_space: MOSS_COORD_SPACE,
    bbox_format: MOSS_BBOX_FORMAT,
  }
  return JSON.stringify(compiled)
}

/**
 * Convert a pixel box to the 0..1000 normalized yxyx form ComfyUI's
 * CreateBoundingBoxes accepts via its `bboxes` JSON string input.
 */
export function boxToNormalized(box, width, height) {
  const b = normalizeBox(box)
  if (b === null) throw new Error('bbox must be four numbers')
  const grid = (value) => Math.max(0, Math.min(1000, Math.round(value)))
  return [
    grid((b.y1 / height) * 1000),
    grid((b.x1 / width) * 1000),
    grid((b.y2 / height) * 1000),
    grid((b.x2 / width) * 1000),
  ]
}

/**
 * Build the `elements` payload accepted by CreateBoundingBoxes / the
 * MOSSImageLayoutPrompt node's upstream `element` input. The summary item is
 * not spatial, so it contributes no element; its caption is the node's prompt.
 */
export function layoutToElements(layout) {
  return spatialItems(layout.items).map((item) => {
    const element = {
      type: item.label === 'text' ? 'text' : 'obj',
      bbox: boxToNormalized(item.bbox, layout.width, layout.height),
    }
    if (item.label === 'text') element.text = String(item.text ?? '')
    element.desc = String(item.caption ?? '')
    const palette = Array.isArray(item.palette) ? item.palette.filter((c) => typeof c === 'string' && c.trim() !== '') : []
    if (palette.length > 0) element.color_palette = palette.slice(0, 5)
    return element
  })
}

/** Whether a string looks like a compiled MOSS layout prompt. */
export function isCompiledMossPrompt(text) {
  if (typeof text !== 'string') return false
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return false
  try {
    const value = JSON.parse(trimmed)
    return value !== null && typeof value === 'object' && value.bbox_coord_space === MOSS_COORD_SPACE && Array.isArray(value.items)
  } catch {
    return false
  }
}

/**
 * Parse a compiled MOSS prompt back into the editable layout for the given canvas.
 * The summary caption becomes the unique summary item, placed over the canvas.
 * Used when a user pastes or hand-edits the compiled textbox.
 */
export function parseCompiledMossPrompt(text, width, height) {
  const value = JSON.parse(text)
  if (value === null || typeof value !== 'object' || !Array.isArray(value.items)) throw new Error('not a compiled MOSS layout prompt')
  if (value.bbox_coord_space !== MOSS_COORD_SPACE || value.bbox_format !== MOSS_BBOX_FORMAT) {
    throw new Error(`unsupported coordinate form ${String(value.bbox_coord_space)}/${String(value.bbox_format)}`)
  }
  if (!Number.isInteger(width) || !Number.isInteger(height)) throw new Error('canvas size is not set')
  const w2 = Math.floor(width / 2)
  const h2 = Math.floor(height / 2)
  const items = []
  const summary = String(value.summary?.caption ?? '')
  if (summary.trim() !== '') {
    items.push({
      id: 'box-summary',
      label: SUMMARY_LABEL,
      caption: summary,
      text: '',
      bbox: [0, 0, width, height],
      palette: [],
      tags: [],
    })
  }
  value.items.forEach((item, index) => {
    if (!Array.isArray(item.bbox) || item.bbox.length !== 4) throw new Error(`items[${index}].bbox is invalid`)
    const [y0, x0, y1, x1] = item.bbox
    items.push({
      id: `box-${index + 1}`,
      label: LABELS.has(item.label) ? item.label : 'object',
      caption: String(item.caption ?? ''),
      text: item.label === 'text' ? String(item.text ?? '') : '',
      bbox: [x0 + w2, y0 + h2, x1 + w2, y1 + h2],
      palette: Array.isArray(item.palette) ? item.palette : [],
      tags: [],
    })
  })
  return { items }
}
