/** The per-session document shared by the canvas UI and the agent tools. */

import { compileMossLayout, validateLayout } from './moss.js'

export const DOC_VERSION = 1

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
    promptSource: 'user',
    promptManual: false,
    promptError: null,
    layout: {
      summary: '',
      items: [],
    },
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
  doc.layout.items = Array.isArray(doc.layout.items) ? doc.layout.items : []
  doc.ui = { ...base.ui, ...(raw.ui && typeof raw.ui === 'object' ? clone(raw.ui) : {}) }
  doc.runs = Array.isArray(raw.runs) ? raw.runs.slice(0, 50) : []
  doc.prompt = typeof doc.prompt === 'string' ? doc.prompt : ''
  doc.layout.summary = typeof doc.layout.summary === 'string' ? doc.layout.summary : ''
  if (!['image', 'layout'].includes(doc.mode)) doc.mode = 'image'
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
