/** The per-session document shared by the canvas UI and the agent tools. */

import { SUMMARY_LABEL, compileMossLayout, summaryFirst, validateLayout } from './moss.js'

export const DOC_VERSION = 1

/** Longest comment text kept in the document; the rest of an oversized paste is dropped. */
export const COMMENT_TEXT_LIMIT = 8000

const COMMENT_SOURCES = new Set(['user', 'agent'])

export const MASK_DEFAULTS = {
  feather: 8,
  grow: 0,
  inverted: false,
  visible: true,
  color: '#ff3b30',
  opacity: 0.45,
  rev: 0,
}

export function newDoc(sessionId, now = Date.now()) {
  return {
    version: DOC_VERSION,
    sessionId,
    rev: 0,
    createdAt: now,
    updatedAt: now,
    mode: 'image',
    enabled: false,
    // Tools stay with the chat after the canvas closes. Removing them rewrites
    // the request prefix and costs one full-context cache miss, so only an
    // explicit unload clears this flag.
    toolsPinned: false,
    canvas: {
      width: 1024,
      height: 1024,
      image: null,
      background: 'checker',
    },
    mask: { ...MASK_DEFAULTS },
    prompt: '',
    negative: '',
    promptSource: 'user',
    promptManual: false,
    promptError: null,
    layout: {
      // The whole-image caption is not a field of its own: it is one layout
      // item whose label is `summary`, so it is drawn and edited like the boxes.
      items: [],
    },
    comments: [],
    selected: null,
    workflow: null,
    runs: [],
    ui: {
      openSeq: 0,
      notice: null,
    },
  }
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function canvasDimension(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback
}

/** Whether a value is a box with four finite numbers and a positive area. */
export function isUsableBbox(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return false
  const [x1, y1, x2, y2] = bbox.map(Number)
  return [x1, y1, x2, y2].every(Number.isFinite) && x2 > x1 && y2 > y1
}

/**
 * Clamp a bbox into the canvas. A box entirely outside would collapse to a
 * zero-area line, so it is pulled back to a small visible sliver at the edge.
 */
export function clampBboxToCanvas(bbox, width, height) {
  if (!isUsableBbox(bbox)) return bbox
  const w = canvasDimension(width, 1024)
  const h = canvasDimension(height, 1024)
  const [x1, y1, x2, y2] = bbox.map(Number)
  const clampNumber = (value, max) => Math.min(max, Math.max(0, value))
  const size = Math.max(1, Math.min(8, w, h))
  let a = clampNumber(Math.min(x1, x2), w)
  let b = clampNumber(Math.max(x1, x2), w)
  let c = clampNumber(Math.min(y1, y2), h)
  let d = clampNumber(Math.max(y1, y2), h)
  if (b - a < 1) {
    if (a >= w) { a = Math.max(0, w - size); b = w }
    else { b = Math.min(w, a + size) }
  }
  if (d - c < 1) {
    if (c >= h) { c = Math.max(0, h - size); d = h }
    else { d = Math.min(h, c + size) }
  }
  return [a, c, b, d]
}

/**
 * A compact on-canvas handle for the whole-image description item.
 *
 * The caption is global, so its box never has to cover the image: a small box
 * near the top-left is enough to click, drag, and double-click for the full
 * text. MOSS ignores this geometry; only the caption is compiled.
 */
export function defaultSummaryBbox(width, height) {
  const w = canvasDimension(width, 1024)
  const h = canvasDimension(height, 1024)
  const boxW = Math.max(8, Math.min(320, w - 32))
  const boxH = Math.max(8, Math.min(140, h - 32))
  const x = Math.max(0, Math.min(16, w - boxW))
  const y = Math.max(0, Math.min(16, h - boxH))
  return [x, y, x + boxW, y + boxH]
}

/** A numeric coordinate, accepting numeric strings from older documents. */
function commentCoordinate(value) {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '') return Number(value)
  return Number.NaN
}

/**
 * Coerce one comment bbox into four pixel integers inside the canvas.
 * Returns null when the box is not four finite numbers or has no area left
 * after clamping (for example a box entirely outside the canvas).
 */
export function normalizeCommentBbox(raw, width, height) {
  if (!Array.isArray(raw) || raw.length !== 4) return null
  const values = raw.map(commentCoordinate)
  if (!values.every(Number.isFinite)) return null
  const w = canvasDimension(width, 1024)
  const h = canvasDimension(height, 1024)
  const clamp = (value, max) => Math.min(max, Math.max(0, value))
  const left = Math.round(Math.min(values[0], values[2]))
  const top = Math.round(Math.min(values[1], values[3]))
  const right = Math.round(Math.max(values[0], values[2]))
  const bottom = Math.round(Math.max(values[1], values[3]))
  const bbox = [clamp(left, w), clamp(top, h), clamp(right, w), clamp(bottom, h)]
  return bbox[2] > bbox[0] && bbox[3] > bbox[1] ? bbox : null
}

function commentTimestamp(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : fallback
}

/** Keep only well-formed, addressable comments and re-clamp them to the canvas. */
export function normalizeComments(raw, width, height, now = Date.now()) {
  if (!Array.isArray(raw)) return []
  const comments = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    if (typeof entry.id !== 'string' || entry.id === '') continue
    const bbox = normalizeCommentBbox(entry.bbox, width, height)
    if (bbox === null) continue
    const createdAt = commentTimestamp(entry.createdAt, now)
    comments.push({
      id: entry.id,
      bbox,
      text: typeof entry.text === 'string' ? entry.text.slice(0, COMMENT_TEXT_LIMIT) : '',
      source: COMMENT_SOURCES.has(entry.source) ? entry.source : 'user',
      createdAt,
      updatedAt: commentTimestamp(entry.updatedAt, createdAt),
    })
  }
  return comments
}

/** A sortable comment id: cm-<base36 timestamp>. */
export function newCommentId(now = Date.now()) {
  return `cm-${Math.floor(now).toString(36)}`
}

/**
 * Normalize the persisted layout.
 *
 * The whole-image caption used to live in `layout.summary`; it is now one
 * layout item with label `summary`. An old document that still carries the
 * string gets that item back on the canvas, so nothing is lost. Duplicates
 * (only possible through hand-edited files) are demoted to object boxes, and
 * the summary item always sits first.
 */
function normalizeLayout(raw, width, height) {
  const layout = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const items = Array.isArray(layout.items)
    ? layout.items
        .filter((item) => item !== null && typeof item === 'object' && !Array.isArray(item))
        .map((item, index) => ({ ...item, id: typeof item.id === 'string' && item.id !== '' ? item.id : `box-${index + 1}` }))
    : []
  const legacySummary = typeof layout.summary === 'string' ? layout.summary.trim() : ''
  if (legacySummary !== '' && items.length > 0 && !items.some((item) => item.label === SUMMARY_LABEL)) {
    items.unshift({
      id: 'box-summary',
      label: SUMMARY_LABEL,
      caption: layout.summary,
      text: '',
      bbox: defaultSummaryBbox(width, height),
      palette: [],
      tags: [],
    })
  }
  let sawSummary = false
  const normalized = items.map((item) => {
    if (item.label !== SUMMARY_LABEL) return item
    if (!sawSummary) {
      sawSummary = true
      // A summary item without a usable handle (an old hand-edited file, or an
      // agent that omitted the bbox) gets the compact default instead of a
      // zero-size box.
      return isUsableBbox(item.bbox) ? item : { ...item, bbox: defaultSummaryBbox(width, height) }
    }
    return { ...item, label: 'object', caption: String(item.caption ?? '') }
  })
  return { items: summaryFirst(normalized) }
}

/** Merge a persisted document over the current defaults, keeping unknown fields out. */
export function normalizeDoc(raw, sessionId) {
  const base = newDoc(sessionId)
  if (raw === null || typeof raw !== 'object') return base
  const doc = {
    ...base,
    ...clone(raw),
    version: DOC_VERSION,
    sessionId,
  }
  doc.canvas = { ...base.canvas, ...(raw.canvas && typeof raw.canvas === 'object' ? clone(raw.canvas) : {}) }
  doc.mask = { ...base.mask, ...(raw.mask && typeof raw.mask === 'object' ? clone(raw.mask) : {}) }
  doc.layout = normalizeLayout(raw.layout, doc.canvas.width, doc.canvas.height)
  doc.ui = { ...base.ui, ...(raw.ui && typeof raw.ui === 'object' ? clone(raw.ui) : {}) }
  doc.comments = normalizeComments(raw.comments, doc.canvas.width, doc.canvas.height)
  doc.runs = Array.isArray(raw.runs) ? raw.runs.slice(0, 50) : []
  doc.prompt = typeof doc.prompt === 'string' ? doc.prompt : ''
  doc.negative = typeof doc.negative === 'string' ? doc.negative : ''
  if (!['image', 'layout'].includes(doc.mode)) doc.mode = 'image'
  doc.enabled = doc.enabled === true
  // Documents written before the pin existed lost their tools when the canvas
  // closed; treat an enabled one as pinned so the switch survives the upgrade.
  doc.toolsPinned = doc.toolsPinned === true || (raw.toolsPinned === undefined && doc.enabled)
  // A layout error only means something while there are boxes to compile; an
  // old error must not outlive the boxes it complained about.
  if (doc.layout.items.length === 0) doc.promptError = null
  return doc
}

export function compileDocPrompt(doc) {
  const items = Array.isArray(doc.layout.items) ? doc.layout.items : []
  if (items.length === 0) {
    return { prompt: doc.prompt, error: null, compiled: false }
  }
  try {
    const prompt = compileMossLayout({
      width: doc.canvas.width,
      height: doc.canvas.height,
      items,
    })
    return { prompt, error: null, compiled: true }
  } catch (error) {
    return { prompt: doc.prompt, error: error instanceof Error ? error.message : String(error), compiled: false }
  }
}

export function layoutErrors(doc) {
  return validateLayout({
    width: doc.canvas.width,
    height: doc.canvas.height,
    items: doc.layout.items,
  })
}

export function publicDoc(doc) {
  return clone(doc)
}
