/** The per-session document shared by the canvas UI and the agent tools. */

import { compileMossLayout, validateLayout } from './moss.js'

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
      summary: '',
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
  doc.layout = { ...base.layout, ...(raw.layout && typeof raw.layout === 'object' ? clone(raw.layout) : {}) }
  doc.layout.items = Array.isArray(doc.layout.items)
    ? doc.layout.items.map((item, index) => {
        if (item === null || typeof item !== 'object') return item
        return { ...item, id: typeof item.id === 'string' && item.id !== '' ? item.id : `box-${index + 1}` }
      })
    : []
  doc.ui = { ...base.ui, ...(raw.ui && typeof raw.ui === 'object' ? clone(raw.ui) : {}) }
  doc.comments = normalizeComments(raw.comments, doc.canvas.width, doc.canvas.height)
  doc.runs = Array.isArray(raw.runs) ? raw.runs.slice(0, 50) : []
  doc.prompt = typeof doc.prompt === 'string' ? doc.prompt : ''
  doc.negative = typeof doc.negative === 'string' ? doc.negative : ''
  doc.layout.summary = typeof doc.layout.summary === 'string' ? doc.layout.summary : ''
  if (!['image', 'layout'].includes(doc.mode)) doc.mode = 'image'
  // A layout error only means something while there are boxes to compile; an
  // old error must not outlive the boxes it complained about.
  if (doc.layout.items.length === 0) doc.promptError = null
  return doc
}

export function compileDocPrompt(doc) {
  if (!Array.isArray(doc.layout.items) || doc.layout.items.length === 0) {
    return { prompt: doc.prompt, error: null, compiled: false }
  }
  try {
    const prompt = compileMossLayout({
      width: doc.canvas.width,
      height: doc.canvas.height,
      summary: doc.layout.summary,
      items: doc.layout.items,
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
    summary: doc.layout.summary,
    items: doc.layout.items,
  })
}

export function publicDoc(doc) {
  return clone(doc)
}
