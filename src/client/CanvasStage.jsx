import * as React from 'react'
import {
  canvasToBlob,
  composeRgba,
  createCanvas,
  drawDot,
  drawStrokeSegment,
  fillMaskShape,
  hasMaskPixels,
  maskCutout,
  processMask,
  tintedMask,
} from './mask.js'
import {
  assignRegions,
  bboxScore,
  labelComponents,
  regionSyncAction,
  sampleComponents,
  seedRegions,
} from './regions.js'
import { remapPathPoints, splitShapePieces } from './shapes.js'
import { ColorField } from './ColorField.jsx'

const { forwardRef, useEffect, useImperativeHandle, useRef, useState } = React

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

const MASK_TOOLS = new Set(['brush', 'eraser', 'rect', 'ellipse', 'select'])

/**
 * Number chips on the painted regions, so a prompt can be matched to a blob.
 * The overlay canvas is CSS-scaled with the stage, so every size is divided by
 * the view scale to keep the chip constant on screen.
 */
function drawRegionBadges(ctx, regions, scale, color) {
  if (!Array.isArray(regions) || regions.length === 0) return
  const radius = 9 / scale
  const fontPx = 11 / scale
  const pad = 3 / scale
  ctx.save()
  ctx.font = `600 ${fontPx}px ui-sans-serif, system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let index = 0; index < regions.length; index += 1) {
    const region = regions[index]
    const [x1, y1] = region.bbox
    const cx = x1 + radius + pad
    const cy = y1 + radius + pad
    // A hollow chip means "no prompt yet": that region will run empty.
    const empty = String(region.prompt ?? '').trim() === ''
    ctx.beginPath()
    ctx.arc(cx, cy, radius, 0, Math.PI * 2)
    ctx.globalAlpha = empty ? 0.34 : 0.94
    ctx.fillStyle = color
    ctx.fill()
    ctx.globalAlpha = 1
    ctx.lineWidth = 1.2 / scale
    ctx.strokeStyle = color
    if (empty) ctx.stroke()
    ctx.fillStyle = '#ffffff'
    ctx.fillText(String(index + 1), cx, cy + 0.5 / scale)
  }
  ctx.restore()
}

function normalizeBox(a, b) {
  return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)]
}

/**
 * A pointer can leave the artboard while a drag is captured (the padding around
 * the stage is still the wrap's hit area). New layout boxes, mask shapes and
 * comments must never be born outside it: they would be stored, invisible, and
 * — for mask shapes — impossible to remove without clearing the mask.
 */
function clampPoint(point, limits) {
  return { x: clamp(point.x, 0, limits.width), y: clamp(point.y, 0, limits.height) }
}

function resizeBox(box, handle, point, limits) {
  let [x1, y1, x2, y2] = box
  if (handle.includes('w')) x1 = point.x
  if (handle.includes('e')) x2 = point.x
  if (handle.includes('n')) y1 = point.y
  if (handle.includes('s')) y2 = point.y
  x1 = clamp(x1, 0, limits.width)
  x2 = clamp(x2, 0, limits.width)
  y1 = clamp(y1, 0, limits.height)
  y2 = clamp(y2, 0, limits.height)
  if (x2 - x1 < 2) {
    if (handle.includes('w')) x1 = x2 - 2
    else x2 = x1 + 2
  }
  if (y2 - y1 < 2) {
    if (handle.includes('n')) y1 = y2 - 2
    else y2 = y1 + 2
  }
  return [x1, y1, x2, y2]
}

function wrapLines(ctx, text, maxWidth, maxLines) {
  const lines = []
  let line = ''
  for (const char of String(text ?? '')) {
    const candidate = line + char
    if (ctx.measureText(candidate).width > maxWidth && line !== '') {
      lines.push(line)
      line = char
      if (lines.length >= maxLines) return lines
    } else {
      line = candidate
    }
  }
  if (line !== '' && lines.length < maxLines) lines.push(line)
  return lines
}

function drawBoxOverlay(ctx, boxes, selectedId, scale, draft) {
  const line = 1.5 / scale
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  // A draft of an existing box replaces it in place, so dragging a box keeps
  // its own number; only a brand-new box joins the end of the list.
  const all = draft === null
    ? boxes
    : draft.id === '__draft__'
      ? [...boxes, draft]
      : boxes.map((box) => (box.id === draft.id ? { ...box, bbox: draft.bbox } : box))
  all.forEach((item, index) => {
    const [x1, y1, x2, y2] = item.bbox
    const isDraft = draft !== null && item.id === draft.id
    const selected = item.id === selectedId || isDraft
    // The whole-image description is a layout item too, but it has no spatial
    // meaning; amber marks it apart from the cyan object boxes.
    const isSummary = String(item.label ?? '') === 'summary'
    const accent = isSummary ? '#f5a623' : '#4cc9f0'
    ctx.strokeStyle = selected ? accent : isSummary ? 'rgba(245,166,35,0.75)' : 'rgba(76,201,240,0.65)'
    ctx.lineWidth = selected ? 2.2 / scale : line
    ctx.setLineDash(isSummary ? [8 / scale, 5 / scale] : isDraft ? [6 / scale, 4 / scale] : [])
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1)
    ctx.setLineDash([])
    // Translucent tint plus the type/caption written inside the box, so the
    // annotation reads clearly on top of any picture.
    const fontPx = 11 / scale
    const pad = 3 / scale
    ctx.save()
    ctx.beginPath()
    ctx.rect(x1, y1, x2 - x1, y2 - y1)
    ctx.clip()
    ctx.fillStyle = isSummary
      ? (selected ? 'rgba(245,166,35,0.18)' : 'rgba(245,166,35,0.10)')
      : (selected ? 'rgba(76,201,240,0.16)' : 'rgba(76,201,240,0.10)')
    ctx.fillRect(x1, y1, x2 - x1, y2 - y1)
    const label = isSummary ? 'S' : String(index + 1).padStart(2, '0')
    ctx.font = `600 ${fontPx}px ui-sans-serif, system-ui, sans-serif`
    const textWidth = ctx.measureText(label).width
    const labelHeight = fontPx + 6 / scale
    ctx.fillStyle = selected ? accent : isSummary ? 'rgba(245,166,35,0.9)' : 'rgba(76,201,240,0.9)'
    ctx.fillRect(x1, y1, textWidth + 8 / scale, labelHeight)
    ctx.fillStyle = '#06202b'
    ctx.fillText(label, x1 + 4 / scale, y1 + fontPx + 1 / scale)
    const type = String(item.label ?? 'object')
    const caption = String(item.caption ?? '').trim()
    if (x2 - x1 > 34 / scale) {
      ctx.font = `${fontPx}px ui-sans-serif, system-ui, sans-serif`
      ctx.lineWidth = 2.4 / scale
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)'
      ctx.fillStyle = isSummary ? '#ffd08a' : '#9be7ff'
      const typeX = x1 + textWidth + 8 / scale + pad * 2
      ctx.strokeText(type, typeX, y1 + fontPx + 1 / scale)
      ctx.fillText(type, typeX, y1 + fontPx + 1 / scale)
      if (caption !== '') {
        ctx.fillStyle = '#ffffff'
        const maxWidth = Math.max(24 / scale, x2 - x1 - pad * 2)
        const top = y1 + labelHeight + fontPx + 3 / scale
        const maxLines = Math.max(1, Math.floor((y2 - top - pad) / (fontPx * 1.35)))
        const lines = wrapLines(ctx, caption, maxWidth, maxLines)
        lines.forEach((value, row) => {
          const ty = top + row * fontPx * 1.35
          ctx.strokeText(value, x1 + pad, ty)
          ctx.fillText(value, x1 + pad, ty)
        })
      }
    }
    ctx.restore()
    if (selected && !isDraft) {
      const r = 4 / scale
      for (const [hx, hy] of [
        [x1, y1], [(x1 + x2) / 2, y1], [x2, y1],
        [x2, (y1 + y2) / 2], [x2, y2], [(x1 + x2) / 2, y2],
        [x1, y2], [x1, (y1 + y2) / 2],
      ]) {
        ctx.fillStyle = '#ffffff'
        ctx.strokeStyle = '#1b6d8a'
        ctx.lineWidth = 1 / scale
        ctx.beginPath()
        ctx.rect(hx - r, hy - r, r * 2, r * 2)
        ctx.fill()
        ctx.stroke()
      }
    }
  })
}

function hitTestShapes(shapes, point, scale, selectedId) {
  const threshold = 9 / scale
  const selected = shapes.find((shape) => shape.id === selectedId)
  if (selected !== undefined) {
    const [x1, y1, x2, y2] = selected.bbox
    const handles = [
      ['nw', x1, y1], ['n', (x1 + x2) / 2, y1], ['ne', x2, y1],
      ['e', x2, (y1 + y2) / 2], ['se', x2, y2], ['s', (x1 + x2) / 2, y2],
      ['sw', x1, y2], ['w', x1, (y1 + y2) / 2],
    ]
    for (const [handle, hx, hy] of handles) {
      if (Math.abs(point.x - hx) <= threshold && Math.abs(point.y - hy) <= threshold) {
        return { kind: 'resize', handle, shape: selected }
      }
    }
  }
  for (let index = shapes.length - 1; index >= 0; index -= 1) {
    const [x1, y1, x2, y2] = shapes[index].bbox
    if (point.x >= x1 && point.x <= x2 && point.y >= y1 && point.y <= y2) {
      return { kind: 'move', shape: shapes[index] }
    }
  }
  return null
}

/** Dashed outline per mask shape plus resize handles for the selected one. */
function drawShapeObjects(ctx, shapes, selectedId, scale, color, draft) {
  const all = draft === null
    ? shapes
    : draft.id === '__draft__'
      ? [...shapes, draft]
      : shapes.map((shape) => (shape.id === draft.id ? { ...shape, bbox: draft.bbox } : shape))
  for (const shape of all) {
    const [x1, y1, x2, y2] = shape.bbox
    const isDraft = draft !== null && shape.id === draft.id
    const selected = shape.id === selectedId || isDraft
    // A mask is painted, not a layout box: no dashed frame. Only the selected
    // shape gets a thin outline so its handles have something to attach to.
    if (!selected) continue
    ctx.save()
    ctx.strokeStyle = color
    ctx.globalAlpha = 0.95
    ctx.lineWidth = 1.4 / scale
    ctx.beginPath()
    if (shape.kind === 'ellipse') {
      ctx.ellipse(x1 + (x2 - x1) / 2, y1 + (y2 - y1) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2)
    } else {
      ctx.rect(x1, y1, x2 - x1, y2 - y1)
    }
    ctx.stroke()
    ctx.restore()
    if (!isDraft) {
      const r = 4 / scale
      for (const [hx, hy] of [
        [x1, y1], [(x1 + x2) / 2, y1], [x2, y1],
        [x2, (y1 + y2) / 2], [x2, y2], [(x1 + x2) / 2, y2],
        [x1, y2], [x1, (y1 + y2) / 2],
      ]) {
        ctx.fillStyle = '#ffffff'
        ctx.strokeStyle = color
        ctx.lineWidth = 1 / scale
        ctx.beginPath()
        ctx.rect(hx - r, hy - r, r * 2, r * 2)
        ctx.fill()
        ctx.stroke()
      }
    }
  }
}

const COMMENT_COLOR = '#f59e0b'

/** Comment boxes: an amber annotation with the note drawn right on the image. */
function drawComments(ctx, comments, selectedId, scale, draft) {
  const all = draft === null
    ? comments
    : draft.id === '__draft__'
      ? [...comments, draft]
      : comments.map((comment) => (comment.id === draft.id ? { ...comment, bbox: draft.bbox } : comment))
  const line = 1.5 / scale
  all.forEach((comment, index) => {
    const [x1, y1, x2, y2] = comment.bbox
    const selected = comment.id === selectedId || (draft !== null && comment.id === draft.id)
    ctx.save()
    ctx.fillStyle = 'rgba(245, 158, 11, 0.14)'
    ctx.fillRect(x1, y1, x2 - x1, y2 - y1)
    ctx.strokeStyle = COMMENT_COLOR
    ctx.lineWidth = selected ? 2.2 / scale : line
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1)
    const label = `C${index + 1}`
    const fontPx = 11 / scale
    ctx.font = `600 ${fontPx}px ui-sans-serif, system-ui, sans-serif`
    const chipWidth = ctx.measureText(label).width + 8 / scale
    ctx.fillStyle = COMMENT_COLOR
    ctx.fillRect(x1, y1, chipWidth, fontPx + 6 / scale)
    ctx.fillStyle = '#3a2400'
    ctx.fillText(label, x1 + 4 / scale, y1 + fontPx + 1 / scale)
    const text = String(comment.text ?? '').trim()
    if (text !== '') {
      ctx.font = `${fontPx}px ui-sans-serif, system-ui, sans-serif`
      ctx.lineWidth = 2.4 / scale
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)'
      ctx.fillStyle = '#ffffff'
      const pad = 5 / scale
      const chipHeight = fontPx + 6 / scale
      const top = y1 + chipHeight + fontPx + 4 / scale
      const maxLines = Math.max(1, Math.floor((y2 - top - pad) / (fontPx * 1.35)))
      if (maxLines >= 1) {
        const lines = []
        let lineText = ''
        for (const char of text) {
          const candidate = lineText + char
          if (ctx.measureText(candidate).width > Math.max(20 / scale, x2 - x1 - pad * 2) && lineText !== '') {
            lines.push(lineText)
            lineText = char
          } else {
            lineText = candidate
          }
        }
        if (lineText !== '') lines.push(lineText)
        lines.slice(0, maxLines).forEach((value, row) => {
          const ty = top + row * fontPx * 1.35
          ctx.strokeText(value, x1 + pad, ty)
          ctx.fillText(value, x1 + pad, ty)
        })
      }
    }
    if (selected) {
      const r = 4 / scale
      for (const [hx, hy] of [
        [x1, y1], [(x1 + x2) / 2, y1], [x2, y1],
        [x2, (y1 + y2) / 2], [x2, y2], [(x1 + x2) / 2, y2],
        [x1, y2], [x1, (y1 + y2) / 2],
      ]) {
        ctx.fillStyle = '#ffffff'
        ctx.strokeStyle = COMMENT_COLOR
        ctx.lineWidth = 1 / scale
        ctx.beginPath()
        ctx.rect(hx - r, hy - r, r * 2, r * 2)
        ctx.fill()
        ctx.stroke()
      }
    }
    ctx.restore()
  })
}

function drawPaintSelection(ctx, bbox, scale, color) {
  if (bbox === null || bbox === undefined) return
  const [x1, y1, x2, y2] = bbox
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = 1.4 / scale
  ctx.strokeRect(x1, y1, x2 - x1, y2 - y1)
  const r = 4 / scale
  for (const [hx, hy] of [
    [x1, y1], [(x1 + x2) / 2, y1], [x2, y1],
    [x2, (y1 + y2) / 2], [x2, y2], [(x1 + x2) / 2, y2],
    [x1, y2], [x1, (y1 + y2) / 2],
  ]) {
    ctx.fillStyle = '#ffffff'
    ctx.strokeStyle = color
    ctx.lineWidth = 1 / scale
    ctx.beginPath()
    ctx.rect(hx - r, hy - r, r * 2, r * 2)
    ctx.fill()
    ctx.stroke()
  }
  ctx.restore()
}

function hitTestComments(comments, point, scale, selectedId) {
  const threshold = 9 / scale
  const selected = comments.find((comment) => comment.id === selectedId)
  if (selected !== undefined) {
    const [x1, y1, x2, y2] = selected.bbox
    const handles = [
      ['nw', x1, y1], ['n', (x1 + x2) / 2, y1], ['ne', x2, y1],
      ['e', x2, (y1 + y2) / 2], ['se', x2, y2], ['s', (x1 + x2) / 2, y2],
      ['sw', x1, y2], ['w', x1, (y1 + y2) / 2],
    ]
    for (const [handle, hx, hy] of handles) {
      if (Math.abs(point.x - hx) <= threshold && Math.abs(point.y - hy) <= threshold) {
        return { kind: 'resize', handle, comment: selected }
      }
    }
  }
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const [x1, y1, x2, y2] = comments[index].bbox
    if (point.x >= x1 && point.x <= x2 && point.y >= y1 && point.y <= y2) {
      return { kind: 'move', comment: comments[index] }
    }
  }
  return null
}

function hitTest(boxes, point, scale, selectedId) {
  const threshold = 9 / scale
  const selected = boxes.find((box) => box.id === selectedId)
  if (selected) {
    const [x1, y1, x2, y2] = selected.bbox
    const handles = [
      ['nw', x1, y1], ['n', (x1 + x2) / 2, y1], ['ne', x2, y1],
      ['e', x2, (y1 + y2) / 2], ['se', x2, y2], ['s', (x1 + x2) / 2, y2],
      ['sw', x1, y2], ['w', x1, (y1 + y2) / 2],
    ]
    for (const [handle, hx, hy] of handles) {
      if (Math.abs(point.x - hx) <= threshold && Math.abs(point.y - hy) <= threshold) {
        return { kind: 'resize', handle, box: selected }
      }
    }
  }
  for (let i = boxes.length - 1; i >= 0; i -= 1) {
    const [x1, y1, x2, y2] = boxes[i].bbox
    if (point.x >= x1 && point.x <= x2 && point.y >= y1 && point.y <= y2) {
      return { kind: 'move', box: boxes[i] }
    }
  }
  return null
}

export const CanvasStage = forwardRef(function CanvasStage(props, ref) {
  const {
    sessionId,
    imageUrl,
    width,
    height,
    tool,
    brush,
    maskSettings,
    boxes,
    selectedId,
    shapes,
    onShapesChange,
    comments,
    selectedComment,
    onCommentCreate,
    onCommentCommit,
    onCommentText,
    onCommentSelect,
    onBoxCreate,
    onBoxCommit,
    onBoxCaption,
    onBoxEdit,
    onBoxSelect,
    maskRegions,
    legacyMaskPrompt,
    onRegionsChange,
    onMaskReady,
    onMessage,
    onDeleteKey,
    t,
  } = props
  const tr = typeof t === 'function' ? t : (key) => key

  const containerRef = useRef(null)
  const stageRef = useRef(null)
  const imageRef = useRef(null)
  const maskDisplayRef = useRef(null)
  const overlayRef = useRef(null)
  const paintRef = useRef(null)
  const compositeRef = useRef(null)
  const processedRef = useRef(null)
  const undoRef = useRef([])
  const redoRef = useRef([])
  const gestureRef = useRef(null)
  const viewRef = useRef({ scale: 1, x: 0, y: 0 })
  const settingsRef = useRef(maskSettings)
  const loadedKeyRef = useRef('')
  const exportTimerRef = useRef(null)
  const spaceRef = useRef(false)
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 })
  const [draftBox, setDraftBox] = useState(null)
  const draftBoxRef = useRef(null)
  const [captionEdit, setCaptionEdit] = useState(null)
  const ringRef = useRef(null)
  const draftShapeRef = useRef(null)
  const draftCommentRef = useRef(null)
  const commentListRef = useRef([])
  const selectedCommentRef = useRef(null)
  const shapeListRef = useRef([])
  const selectedShapeRef = useRef(null)
  const [overlayTick, setOverlayTick] = useState(0)
  const [cursor, setCursor] = useState('crosshair')
  const [shapeList, setShapeList] = useState(() => (Array.isArray(shapes) ? shapes : []))
  const [selectedShape, setSelectedShape] = useState(null)
  const [paintSelection, setPaintSelection] = useState(null)
  const paintSelectionRef = useRef(null)
  paintSelectionRef.current = paintSelection
  const paintDraftRef = useRef(null)
  const shapesRef = useRef(shapeList)
  shapesRef.current = shapeList
  // Per-region mask prompts: identity survives edits by matching the previous
  // components (see regions.js), and the labels of the last sync serve both
  // hit-testing (double-click opens a region's prompt) and the per-region
  // cutouts exported for the inpaint passes.
  const regionListRef = useRef([])
  const regionLabelsRef = useRef(null)
  const regionKeyRef = useRef('')
  const regionSeededRef = useRef(false)
  // The mask asset is fetched after mount; until it lands the composite is
  // empty, which must not be mistaken for "the mask has no regions".
  const maskLoadedRef = useRef(false)
  const docRegionsRef = useRef(Array.isArray(maskRegions) ? maskRegions : [])
  docRegionsRef.current = Array.isArray(maskRegions) ? maskRegions : []
  const legacyPromptRef = useRef(typeof legacyMaskPrompt === 'string' ? legacyMaskPrompt : '')
  legacyPromptRef.current = typeof legacyMaskPrompt === 'string' ? legacyMaskPrompt : ''

  useEffect(() => {
    if (gestureRef.current !== null) return
    setShapeList(Array.isArray(shapes) ? shapes : [])
  }, [shapes])

  settingsRef.current = maskSettings
  viewRef.current = view
  const regionsPropKey = JSON.stringify(Array.isArray(maskRegions) ? maskRegions : [])

  // A document that arrives after the first sync (an empty mount, or an agent
  // that loaded a mask with a prompt) still gets its single legacy prompt onto
  // the painted region: the first sync had nothing to seed from.
  const legacySeededRef = useRef(false)
  useEffect(() => {
    const legacy = String(legacyMaskPrompt ?? '')
    if (legacySeededRef.current || legacy.trim() === '') return
    if (Array.isArray(maskRegions) && maskRegions.length > 0) {
      legacySeededRef.current = true
      return
    }
    const regions = regionListRef.current
    if (regions.length === 0) return
    let largest = regions[0]
    let largestArea = 0
    for (const region of regions) {
      const area = (region.bbox[2] - region.bbox[0]) * (region.bbox[3] - region.bbox[1])
      if (area > largestArea) {
        largestArea = area
        largest = region
      }
    }
    largest.prompt = legacy
    legacySeededRef.current = true
    publishRegions()
    setOverlayTick((value) => value + 1)
  }, [legacyMaskPrompt, regionsPropKey])

  // The document is the shared truth for prompts (the agent may write one), so
  // an incoming region list updates the live prompts without touching identity.
  useEffect(() => {
    if (!Array.isArray(maskRegions) || maskRegions.length === 0) return
    let changed = false
    for (const incoming of maskRegions) {
      const region = regionListRef.current.find((item) => item.id === incoming.id)
      if (region === undefined) continue
      const prompt = typeof incoming.prompt === 'string' ? incoming.prompt : ''
      if (region.prompt !== prompt) {
        region.prompt = prompt
        changed = true
      }
      const source = incoming.promptSource === 'agent' ? 'agent' : 'user'
      if (region.promptSource !== source) {
        region.promptSource = source
        changed = true
      }
    }
    if (changed) setOverlayTick((value) => value + 1)
  }, [regionsPropKey])
  shapeListRef.current = shapeList
  selectedShapeRef.current = selectedShape
  commentListRef.current = Array.isArray(comments) ? comments : []
  selectedCommentRef.current = selectedComment ?? null

  const limit = { width: Math.max(1, width), height: Math.max(1, height) }

  function setStageView(next) {
    viewRef.current = next
    setView(next)
  }

  function fit() {
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const w = limit.width
    const h = limit.height
    if (rect.width <= 4 || rect.height <= 4) return
    const pad = 18
    const scale = clamp(Math.min((rect.width - pad * 2) / w, (rect.height - pad * 2) / h), 0.02, 12)
    setStageView({
      scale,
      x: (rect.width - w * scale) / 2,
      y: (rect.height - h * scale) / 2,
    })
  }

  /**
   * The mask is brush pixels plus vector rect/ellipse shapes. The eraser cuts
   * pixels directly (never a global stencil) and stores holes on the shapes, so
   * erasing empty canvas leaves nothing behind and moving a mask never gets cut
   * by where the eraser happened to pass.
   */
  function buildComposite(draft = null) {
    const paint = paintRef.current
    if (!paint) return null
    const composite = createCanvas(limit.width, limit.height)
    const ctx = composite.getContext('2d')
    ctx.drawImage(paint, 0, 0)
    for (const shape of shapesRef.current) {
      let live = shape
      if (draft !== null && draft.id === shape.id) {
        live = { ...shape, bbox: draft.bbox }
        if (shape.kind === 'path') live.points = remapPathPoints(shape, shape.bbox, draft.bbox)
      }
      fillMaskShape(ctx, live, 1, 'source-over', true)
    }
    if (draft !== null && draft.id === '__draft__') fillMaskShape(ctx, draft, 1, 'source-over', true)
    compositeRef.current = composite
    return composite
  }

  function drawMaskPreview(fromComposite) {
    const display = maskDisplayRef.current
    if (!display) return
    const source = fromComposite ? compositeRef.current : processedRef.current
    if (!source) return
    const ctx = display.getContext('2d')
    ctx.globalCompositeOperation = 'source-over'
    ctx.clearRect(0, 0, display.width, display.height)
    const tinted = tintedMask(source, maskSettings.color, maskSettings.opacity)
    ctx.drawImage(tinted.canvas, 0, 0)
    // The overlay is always drawn while a mask exists; its opacity is the only
    // display knob, so the red tint can never hide the selection entirely.
    display.style.opacity = String(maskSettings.opacity)
    ctx.globalCompositeOperation = 'source-over'
  }

  function refreshProcessed() {
    const composite = buildComposite()
    if (!composite) return
    processedRef.current = processMask(composite, settingsRef.current)
    drawMaskPreview(false)
    setOverlayTick((value) => value + 1)
  }

  /** One byte of paint coverage per pixel, from the composited mask. */
  function compositeAlpha(composite) {
    const { width: w, height: h } = composite
    const data = composite.getContext('2d').getImageData(0, 0, w, h).data
    const alpha = new Uint8Array(w * h)
    for (let pixel = 0; pixel < alpha.length; pixel += 1) alpha[pixel] = data[pixel * 4 + 3]
    return alpha
  }

  /**
   * Hand the current region metadata to the tab, which persists it. Compared by
   * value so a document echo never triggers another save.
   */
  function publishRegions() {
    const meta = regionListRef.current.map((region) => ({
      id: region.id,
      prompt: region.prompt ?? '',
      promptSource: region.promptSource === 'agent' ? 'agent' : 'user',
      bbox: region.bbox.slice(),
      createdAt: region.createdAt,
    }))
    const key = JSON.stringify(meta)
    if (key === regionKeyRef.current) return
    regionKeyRef.current = key
    onRegionsChange?.(meta)
  }

  /**
   * Re-derive the mask regions from the composed mask.
   *
   * The first sync after mount seeds prompts from the document (a reload has no
   * runtime samples); later syncs carry identity forward by overlap, so
   * extending a blob keeps its prompt while a new blob starts empty. `pin`
   * reattaches an identity that moved as a whole (the select tool dragging a
   * painted island), because a moved blob no longer overlaps its old position.
   */
  function syncRegions({ pin = null } = {}) {
    const composite = compositeRef.current
    if (!composite) return
    const w = composite.width
    const h = composite.height
    const hasSeedData = docRegionsRef.current.length > 0 || String(legacyPromptRef.current ?? '').trim() !== ''
    const { labels, components } = labelComponents(compositeAlpha(composite), w, h)
    const action = regionSyncAction({
      seeded: regionSeededRef.current,
      maskLoaded: maskLoadedRef.current,
      hasSeedData,
      componentCount: components.length,
    })
    if (action === 'wait') return
    const samples = sampleComponents(labels, components, w, h)
    regionLabelsRef.current = labels
    let next
    if (action === 'seed') {
      regionSeededRef.current = true
      next = seedRegions({
        components,
        samples,
        docRegions: docRegionsRef.current,
        legacyPrompt: legacyPromptRef.current,
      })
    } else {
      next = assignRegions({ components, samples, previous: regionListRef.current })
    }
    if (pin !== null && next.length > 0 && !next.some((region) => region.id === pin.id)) {
      let best = null
      let bestScore = 0
      for (const region of next) {
        const score = bboxScore(region.bbox, pin.bbox)
        if (score > bestScore) {
          bestScore = score
          best = region
        }
      }
      if (best !== null && bestScore > 0) {
        best.id = pin.id
        best.prompt = pin.prompt ?? ''
        best.promptSource = pin.promptSource === 'agent' ? 'agent' : 'user'
        if (Number.isFinite(pin.createdAt)) best.createdAt = pin.createdAt
        if (Number.isFinite(pin.order)) best.order = pin.order
        next.sort((a, b) => a.order - b.order || a.componentIndex - b.componentIndex)
      }
    }
    regionListRef.current = next
    publishRegions()
    setOverlayTick((value) => value + 1)
  }

  /** The region under a canvas-space point, or null. */
  function regionAtPoint(point) {
    const labels = regionLabelsRef.current
    const composite = compositeRef.current
    if (labels === null || composite === null) return null
    const x = Math.round(point.x)
    const y = Math.round(point.y)
    if (x < 0 || y < 0 || x >= composite.width || y >= composite.height) return null
    const label = labels[y * composite.width + x]
    if (label === 0) return null
    return regionListRef.current.find((region) => region.componentIndex === label) ?? null
  }

  /**
   * Pull the connected painted region under a point out of the brush layer.
   * Dragging then moves only that stroke, even though every stroke is raster.
   */
  function extractPaintRegion(point) {
    const paint = paintRef.current
    if (!paint) return null
    const ctx = paint.getContext('2d')
    const width = paint.width
    const height = paint.height
    const image = ctx.getImageData(0, 0, width, height)
    const data = image.data
    const sx = Math.round(point.x)
    const sy = Math.round(point.y)
    if (sx < 0 || sy < 0 || sx >= width || sy >= height) return null
    if ((data[(sy * width + sx) * 4 + 3] ?? 0) < 12) return null
    const seen = new Uint8Array(width * height)
    const stack = [sy * width + sx]
    let minX = sx
    let maxX = sx
    let minY = sy
    let maxY = sy
    let count = 0
    while (stack.length > 0) {
      const index = stack.pop()
      if (seen[index] === 1) continue
      if ((data[index * 4 + 3] ?? 0) < 12) continue
      seen[index] = 1
      count += 1
      const x = index % width
      const y = (index - x) / width
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      if (x > 0) stack.push(index - 1)
      if (x + 1 < width) stack.push(index + 1)
      if (y > 0) stack.push(index - width)
      if (y + 1 < height) stack.push(index + width)
    }
    if (count === 0) return null
    const regionWidth = maxX - minX + 1
    const regionHeight = maxY - minY + 1
    const region = createCanvas(regionWidth, regionHeight)
    const regionCtx = region.getContext('2d')
    const regionImage = regionCtx.createImageData(regionWidth, regionHeight)
    const base = new ImageData(new Uint8ClampedArray(data), width, height)
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const source = y * width + x
        if (seen[source] !== 1) continue
        const target = ((y - minY) * regionWidth + (x - minX)) * 4
        regionImage.data[target] = data[source * 4]
        regionImage.data[target + 1] = data[source * 4 + 1]
        regionImage.data[target + 2] = data[source * 4 + 2]
        regionImage.data[target + 3] = data[source * 4 + 3]
        base.data[source * 4 + 3] = 0
      }
    }
    regionCtx.putImageData(regionImage, 0, 0)
    return { base, region, bbox: [minX, minY, maxX, maxY], mask: seen }
  }

  /**
   * mask.png bakes shapes into pixels. Shapes are also kept as editable vector
   * objects, so cut them back out of the loaded raster or deleting a shape
   * would leave its paint behind.
   */
  function eraseShapesFromPaint() {
    const paint = paintRef.current
    if (!paint) return
    const ctx = paint.getContext('2d')
    for (const shape of shapesRef.current) fillMaskShape(ctx, shape, 1, 'destination-out', true)
  }

  /** Rebuild a selection mask from the island canvas after it has been moved. */
  function maskFromRegion(region, originX, originY) {
    const mask = new Uint8Array(limit.width * limit.height)
    const data = region.getContext('2d').getImageData(0, 0, region.width, region.height).data
    for (let y = 0; y < region.height; y += 1) {
      for (let x = 0; x < region.width; x += 1) {
        if (data[(y * region.width + x) * 4 + 3] < 12) continue
        const globalX = Math.round(originX) + x
        const globalY = Math.round(originY) + y
        if (globalX < 0 || globalY < 0 || globalX >= limit.width || globalY >= limit.height) continue
        mask[globalY * limit.width + globalX] = 1
      }
    }
    return mask
  }

  /** Which shapes the eraser is currently cutting, with their hole strokes. */
  function beginShapeHoles(point) {
    const radius = brush.size / 2
    const touched = []
    for (const shape of shapesRef.current) {
      const [x1, y1, x2, y2] = shape.bbox
      if (point.x < x1 - radius || point.x > x2 + radius || point.y < y1 - radius || point.y > y2 + radius) continue
      const width = Math.max(1, x2 - x1)
      const height = Math.max(1, y2 - y1)
      if (!Array.isArray(shape.holes)) shape.holes = []
      const hole = {
        width: brush.size / Math.max(1, Math.max(x2 - x1, y2 - y1)),
        points: [[(point.x - x1) / width, (point.y - y1) / height]],
      }
      shape.holes.push(hole)
      touched.push({ shape, hole, x1, y1, width, height })
    }
    return touched
  }

  function appendShapeHoles(touched, point, previous) {
    if (!Array.isArray(touched)) return
    const tracked = new Set(touched.map((entry) => entry.shape.id))
    const radius = brush.size / 2
    const from = previous ?? point
    // A stroke that starts outside a shape and crosses it must start cutting
    // where it enters, not only where it began.
    for (const shape of shapesRef.current) {
      if (tracked.has(shape.id)) continue
      const [x1, y1, x2, y2] = shape.bbox
      if (Math.max(point.x, from.x) + radius < x1) continue
      if (Math.min(point.x, from.x) - radius > x2) continue
      if (Math.max(point.y, from.y) + radius < y1) continue
      if (Math.min(point.y, from.y) - radius > y2) continue
      const width = Math.max(1, x2 - x1)
      const height = Math.max(1, y2 - y1)
      if (!Array.isArray(shape.holes)) shape.holes = []
      const hole = { width: brush.size / Math.max(1, Math.max(x2 - x1, y2 - y1)), points: [] }
      const startPoint = { x: Math.min(Math.max(from.x, x1), x2), y: Math.min(Math.max(from.y, y1), y2) }
      hole.points.push([(startPoint.x - x1) / width, (startPoint.y - y1) / height])
      shape.holes.push(hole)
      touched.push({ shape, hole, x1, y1, width, height })
    }
    for (const entry of touched) {
      entry.hole.points.push([(point.x - entry.x1) / entry.width, (point.y - entry.y1) / entry.height])
    }
  }

  function cloneShapes(list) {
    return list.map((shape) => ({
      ...shape,
      bbox: shape.bbox.slice(),
      holes: (shape.holes ?? []).map((hole) => ({ ...hole, points: hole.points.map((point) => point.slice()) })),
    }))
  }

  function setDraft(value) {
    draftBoxRef.current = value
    setDraftBox(value)
  }

  function drawOverlay() {
    const overlay = overlayRef.current
    if (!overlay) return
    const ctx = overlay.getContext('2d')
    const gesture = gestureRef.current
    let draft = draftBoxRef.current
    if (gesture?.kind === 'newbox') {
      const [x1, y1, x2, y2] = normalizeBox(gesture.start, gesture.current)
      draft = { id: '__draft__', bbox: [x1, y1, x2, y2], label: 'object' }
    }
    drawBoxOverlay(ctx, boxes, selectedId, viewRef.current.scale, draft)
    let shapeDraft = draftShapeRef.current
    if (gesture?.kind === 'shape') {
      const [x1, y1, x2, y2] = normalizeBox(gesture.start, gesture.current)
      shapeDraft = { id: '__draft__', kind: gesture.shape, bbox: [x1, y1, x2, y2] }
    }
    drawShapeObjects(ctx, shapeListRef.current, selectedShapeRef.current, viewRef.current.scale, maskSettings.color ?? '#ff3b30', shapeDraft)
    drawComments(ctx, commentListRef.current, selectedCommentRef.current, viewRef.current.scale, draftCommentRef.current)
    drawPaintSelection(ctx, paintDraftRef.current ?? paintSelectionRef.current?.bbox ?? null, viewRef.current.scale, maskSettings.color ?? '#ff3b30')
    if (MASK_TOOLS.has(tool)) drawRegionBadges(ctx, regionListRef.current, viewRef.current.scale, maskSettings.color ?? '#ff3b30')
  }

  useEffect(() => {
    drawOverlay()
  }, [boxes, selectedId, draftBox, overlayTick, view.scale, shapeList, selectedShape, comments, selectedComment, tool])

  // Shapes live in the composite mask, so a new list needs a new raster and a
  // fresh set of regions (a reloaded document's shapes are the only mask there).
  useEffect(() => {
    refreshProcessed()
    syncRegions()
  }, [shapeList])

  // Keep the display canvas matched to the artboard (it can mount before the
  // size effect has resized it).
  useEffect(() => {
    const display = maskDisplayRef.current
    const overlay = overlayRef.current
    for (const canvas of [display, overlay]) {
      if (!canvas || canvas.width === limit.width) continue
      canvas.width = limit.width
      canvas.height = limit.height
    }
  }, [limit.width, limit.height])

  const regionImageRef = useRef(null)

  useEffect(() => {
    if (regionImageRef.current !== imageUrl) {
      regionImageRef.current = imageUrl
      regionSeededRef.current = false
      regionListRef.current = []
      regionLabelsRef.current = null
      regionKeyRef.current = ''
      maskLoadedRef.current = false
    }
    paintRef.current = createCanvas(limit.width, limit.height)
    compositeRef.current = createCanvas(limit.width, limit.height)
    processedRef.current = createCanvas(limit.width, limit.height)
    undoRef.current = []
    redoRef.current = []
    for (const canvas of [maskDisplayRef.current, overlayRef.current]) {
      if (!canvas) continue
      canvas.width = limit.width
      canvas.height = limit.height
    }
    buildComposite()
    drawMaskPreview(true)
    drawOverlay()
    if (!imageUrl) {
      // No asset to wait for: an empty composite is the truth right away.
      maskLoadedRef.current = true
      syncRegions()
    }
    const key = `${imageUrl ?? ''}|${limit.width}x${limit.height}`
    if (loadedKeyRef.current !== key) {
      loadedKeyRef.current = key
      if (imageUrl) {
        let cancelled = false
        const asset = (name) => `/api/comfy-cowork/asset?session=${encodeURIComponent(sessionId)}&name=${name}&v=${Date.now()}`
        fetch(asset('mask-brush.png'))
          .then((response) => (response.ok ? response.blob() : null))
          .then(async (blob) => {
            const brushOnly = blob !== null
            const source = blob ?? (await (await fetch(asset('mask.png'))).blob())
            return { bitmap: blob === null && source.size === 0 ? null : await createImageBitmap(source), brushOnly }
          })
          .then(({ bitmap, brushOnly }) => {
            if (cancelled || paintRef.current === null) return
            if (bitmap !== null) {
              paintRef.current.getContext('2d').drawImage(bitmap, 0, 0, limit.width, limit.height)
              if (!brushOnly) eraseShapesFromPaint()
            }
            maskLoadedRef.current = true
            refreshProcessed()
            syncRegions()
          })
          .catch(() => {
            // A failed asset read must not leave the stage waiting forever.
            maskLoadedRef.current = true
            syncRegions()
          })
        return () => {
          cancelled = true
        }
      }
    }
    return undefined
  }, [imageUrl, limit.width, limit.height, sessionId])

  useEffect(() => {
    fit()
    const container = containerRef.current
    if (!container) return undefined
    const observer = new ResizeObserver(() => {
      const rect = container.getBoundingClientRect()
      if (rect.width > 4 && rect.height > 4) fit()
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [imageUrl, limit.width, limit.height])

  useEffect(() => {
    const timer = setTimeout(() => refreshProcessed(), 50)
    return () => clearTimeout(timer)
  }, [maskSettings.feather, maskSettings.grow, maskSettings.color, maskSettings.opacity])

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.code === 'Space') spaceRef.current = true
    }
    const onKeyUp = (event) => {
      if (event.code === 'Space') spaceRef.current = false
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined
    const onWheel = (event) => {
      event.preventDefault()
      const rect = container.getBoundingClientRect()
      const current = viewRef.current
      const factor = Math.exp(-event.deltaY * 0.0015)
      const nextScale = clamp(current.scale * factor, 0.02, 16)
      const cx = event.clientX - rect.left
      const cy = event.clientY - rect.top
      const imageX = (cx - current.x) / current.scale
      const imageY = (cy - current.y) / current.scale
      setStageView({
        scale: nextScale,
        x: cx - imageX * nextScale,
        y: cy - imageY * nextScale,
      })
    }
    container.addEventListener('wheel', onWheel, { passive: false })
    return () => container.removeEventListener('wheel', onWheel)
  }, [])

  useEffect(() => {
    if (gestureRef.current === null) setDraft(null)
  }, [boxes])

  useEffect(() => () => {
    if (exportTimerRef.current !== null) clearTimeout(exportTimerRef.current)
  }, [])

  function pointOf(event) {
    const rect = stageRef.current.getBoundingClientRect()
    return {
      x: ((event.clientX - rect.left) / rect.width) * limit.width,
      y: ((event.clientY - rect.top) / rect.height) * limit.height,
    }
  }

  /** Double-clicking a box opens its caption in place; empty space still fits. */
  function onStageDoubleClick(event) {
    const point = pointOf(event)
    {
      const hitComment = hitTestComments(commentListRef.current, point, viewRef.current.scale, selectedCommentRef.current)
      if (hitComment !== null) {
        onCommentSelect?.(hitComment.comment.id)
        setCaptionEdit({
          kind: 'comment',
          id: hitComment.comment.id,
          value: String(hitComment.comment.text ?? ''),
          bbox: hitComment.comment.bbox.slice(),
        })
        return
      }
    }
    const hit = hitTest(boxes, point, viewRef.current.scale, selectedId)
    if (hit === null) {
      const region = regionAtPoint(point)
      if (region === null) {
        fit()
        return
      }
      // With the brush armed, the two clicks of a double-click have already
      // painted dots; they are an editing gesture here, not paint.
      if (tool === 'brush' || tool === 'eraser') {
        undo()
        undo()
      }
      const target = regionAtPoint(point)
      if (target === null) {
        fit()
        return
      }
      setCaptionEdit({ kind: 'mask', id: target.id, value: target.prompt ?? '', bbox: target.bbox.slice() })
      return
    }
    onBoxSelect?.(hit.box.id)
    setCaptionEdit({
      kind: 'box',
      id: hit.box.id,
      value: String(hit.box.caption ?? ''),
      bbox: hit.box.bbox.slice(),
      label: hit.box.label,
      text: String(hit.box.text ?? ''),
      palette: Array.isArray(hit.box.palette) ? hit.box.palette : [],
    })
  }

  function commitCaption() {
    const edit = captionEdit
    setCaptionEdit(null)
    if (edit === null) return
    if (edit.kind === 'comment') {
      const comment = commentListRef.current.find((item) => item.id === edit.id)
      if (comment === undefined || String(comment.text ?? '') === edit.value) return
      onCommentText?.(edit.id, edit.value)
      return
    }
    if (edit.kind === 'mask') {
      const region = regionListRef.current.find((item) => item.id === edit.id)
      if (region === undefined || String(region.prompt ?? '') === edit.value) return
      region.prompt = edit.value
      region.promptSource = 'user'
      publishRegions()
      return
    }
    const box = boxes.find((item) => item.id === edit.id)
    if (box === undefined) return
    const label = edit.label ?? box.label
    const patch = { caption: edit.value, label }
    if (label === 'text') patch.text = edit.text ?? ''
    const changed = String(box.caption ?? '') !== edit.value
      || box.label !== label
      || (label === 'text' && String(box.text ?? '') !== (edit.text ?? ''))
    if (!changed) return
    if (typeof onBoxEdit === 'function') onBoxEdit(box, patch)
    else onBoxCaption?.(box, edit.value)
  }

  /** Move the brush-size ring under the pointer without re-rendering the canvas. */
  function moveBrushRing(event) {
    const ring = ringRef.current
    const container = containerRef.current
    if (ring === null || container === null) return
    const rect = container.getBoundingClientRect()
    ring.style.left = `${event.clientX - rect.left}px`
    ring.style.top = `${event.clientY - rect.top}px`
    ring.style.opacity = '1'
  }

  function snapshot() {
    const paint = paintRef.current
    if (!paint) return null
    return {
      paint: paint.getContext('2d').getImageData(0, 0, paint.width, paint.height),
      shapes: shapesRef.current.map((shape) => ({ ...shape, bbox: shape.bbox.slice(), holes: (shape.holes ?? []).map((hole) => ({ ...hole, points: hole.points.map((point) => point.slice()) })) })),
    }
  }

  function pushUndo() {
    const next = snapshot()
    if (next === null) return
    const bytesPerSnapshot = next.paint.data.length
    const cap = clamp(Math.floor((192 * 1024 * 1024) / Math.max(1, bytesPerSnapshot)), 4, 12)
    undoRef.current.push(next)
    while (undoRef.current.length > cap) undoRef.current.shift()
    redoRef.current = []
  }

  function restore(next) {
    const paint = paintRef.current
    if (!paint || !next) return
    paint.getContext('2d').putImageData(next.paint, 0, 0)
    setShapeList(next.shapes)
    commitShapes(next.shapes, { silent: true })
    refreshProcessed()
    syncRegions()
    scheduleMaskExport()
  }

  function undo() {
    const next = undoRef.current.pop()
    const current = snapshot()
    if (next === undefined || current === null) return
    redoRef.current.push(current)
    restore(next)
  }

  function redo() {
    const next = redoRef.current.pop()
    const current = snapshot()
    if (next === undefined || current === null) return
    undoRef.current.push(current)
    restore(next)
  }

  /** Delete the selected brush island (the painted region picked with the arrow). */
  function removeSelectedPaint() {
    const selection = paintSelectionRef.current
    const paint = paintRef.current
    if (selection === null || !paint) return false
    pushUndo()
    const [bx1, by1, bx2, by2] = selection.bbox.map((value) => Math.round(value))
    const width = Math.max(1, bx2 - bx1 + 1)
    const height = Math.max(1, by2 - by1 + 1)
    const ctx = paint.getContext('2d')
    const image = ctx.getImageData(bx1, by1, width, height)
    const mask = selection.mask
    const fullWidth = paint.width
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const globalIndex = (by1 + y) * fullWidth + (bx1 + x)
        if (mask[globalIndex] === 1) image.data[(y * width + x) * 4 + 3] = 0
      }
    }
    ctx.putImageData(image, bx1, by1)
    setPaintSelection(null)
    refreshProcessed()
    syncRegions()
    scheduleMaskExport()
    return true
  }

  function removeSelectedShape() {
    const id = selectedShapeRef.current
    if (id === null) return false
    pushUndo()
    const next = shapesRef.current.filter((shape) => shape.id !== id)
    setSelectedShape(null)
    setShapeList(next)
    commitShapes(next)
    refreshProcessed()
    syncRegions()
    scheduleMaskExport()
    return true
  }

  function clearMask() {
    const paint = paintRef.current
    if (!paint) return
    pushUndo()
    paint.getContext('2d').clearRect(0, 0, paint.width, paint.height)
    setSelectedShape(null)
    setShapeList([])
    commitShapes([], { silent: true })
    refreshProcessed()
    syncRegions()
    scheduleMaskExport()
  }

  /**
   * One canonical cutout per region, for that region's inpaint pass. The union
   * mask cannot stand in: each pass must be handed only its own pixels, with
   * the same feather/grow the user set once for the whole mask.
   */
  async function exportRegionBlobs() {
    const labels = regionLabelsRef.current
    const regions = regionListRef.current
    if (labels === null || regions.length === 0) return []
    const w = limit.width
    const h = limit.height
    const blobs = []
    for (const region of regions) {
      const mask = createCanvas(w, h)
      const ctx = mask.getContext('2d')
      const image = ctx.createImageData(w, h)
      const [x1, y1, x2, y2] = region.bbox
      for (let y = Math.max(0, y1); y < Math.min(h, y2); y += 1) {
        const row = y * w
        for (let x = Math.max(0, x1); x < Math.min(w, x2); x += 1) {
          if (labels[row + x] === region.componentIndex) image.data[(row + x) * 4 + 3] = 255
        }
      }
      ctx.putImageData(image, 0, 0)
      const processedRegion = processMask(mask, settingsRef.current)
      blobs.push({ id: region.id, blob: await canvasToBlob(maskCutout(processedRegion)) })
    }
    return blobs
  }

  async function exportBlobs() {
    const composite = buildComposite()
    if (!composite) throw new Error('canvas is not ready')
    const processed = processMask(composite, settingsRef.current)
    processedRef.current = processed
    const maskBlob = await canvasToBlob(processed)
    // The brush layer is exported separately so reloading restores exactly the
    // strokes that were drawn, without the vector shapes baked in.
    const brushBlob = await canvasToBlob(paintRef.current ?? createCanvas(limit.width, limit.height))
    let rgbaBlob = null
    if (imageRef.current && imageRef.current.complete && imageRef.current.naturalWidth > 0) {
      const rgba = composeRgba(imageRef.current, processed, limit.width, limit.height)
      rgbaBlob = await canvasToBlob(rgba)
    }
    const regionBlobs = await exportRegionBlobs()
    return {
      maskBlob,
      brushBlob,
      rgbaBlob,
      regionBlobs,
      hasMask: hasMaskPixels(processed),
      canvas: processed,
      shapes: shapesRef.current,
    }
  }

  /** Persist the vector shapes; `silent` skips the round trip (undo/redo). */
  function commitShapes(next, options = {}) {
    shapesRef.current = next
    if (options.silent !== true) onShapesChange?.(next)
  }

  function scheduleMaskExport() {
    if (exportTimerRef.current !== null) clearTimeout(exportTimerRef.current)
    exportTimerRef.current = setTimeout(async () => {
      exportTimerRef.current = null
      try {
        const blobs = await exportBlobs()
        await onMaskReady?.(blobs)
      } catch (error) {
        onMessage?.(error.message)
      }
    }, 260)
  }

  useImperativeHandle(ref, () => ({
    fit,
    undo,
    redo,
    clearMask,
    deleteSelection: () => {
      if (removeSelectedShape()) return
      if (removeSelectedPaint()) return
      onDeleteKey?.()
    },
    clearSelection: () => {
      setSelectedShape(null)
      setPaintSelection(null)
      onBoxSelect?.(null)
    },
    exportNow: async () => {
      const blobs = await exportBlobs()
      await onMaskReady?.(blobs)
      return blobs
    },
    hasMask: () => (processedRef.current ? hasMaskPixels(processedRef.current) : false),
    zoomBy: (factor) => {
      const container = containerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      const current = viewRef.current
      const nextScale = clamp(current.scale * factor, 0.02, 16)
      const cx = rect.width / 2
      const cy = rect.height / 2
      const imageX = (cx - current.x) / current.scale
      const imageY = (cy - current.y) / current.scale
      setStageView({ scale: nextScale, x: cx - imageX * nextScale, y: cy - imageY * nextScale })
    },
  }))

  function onPointerDown(event) {
    if (event.button === 1 || tool === 'pan' || spaceRef.current || event.altKey) {
      gestureRef.current = {
        kind: 'pan',
        startX: event.clientX,
        startY: event.clientY,
        view: viewRef.current,
      }
      setCursor('grabbing')
      try {
        containerRef.current?.setPointerCapture(event.pointerId)
      } catch {}
      return
    }
    if (event.button !== 0) return
    const point = pointOf(event)
    try {
      containerRef.current?.setPointerCapture(event.pointerId)
    } catch {}

    if (tool === 'comment' || tool === 'select') {
      const hit = hitTestComments(commentListRef.current, point, viewRef.current.scale, selectedCommentRef.current)
      if (hit !== null) {
        onCommentSelect?.(hit.comment.id)
        onBoxSelect?.(null)
        setSelectedShape(null)
        gestureRef.current = {
          kind: 'comment-edit',
          mode: hit.kind,
          handle: hit.handle,
          comment: hit.comment,
          original: hit.comment.bbox.slice(),
          start: point,
        }
        return
      }
      if (tool === 'comment') {
        onCommentSelect?.(null)
        const start = clampPoint(point, limit)
        gestureRef.current = { kind: 'comment-new', start, current: start }
        setOverlayTick((value) => value + 1)
      }
      // In select mode a miss falls through to shapes and layout boxes.
    }

    if (tool === 'brush' || tool === 'eraser') {
      const layer = paintRef.current
      if (!layer) return
      pushUndo()
      const stroke = {
        kind: 'stroke',
        erase: tool === 'eraser',
        last: point,
      }
      if (stroke.erase) stroke.holes = beginShapeHoles(point)
      gestureRef.current = stroke
      drawDot(layer.getContext('2d'), point, {
        size: brush.size,
        // The mask is a stencil: a stroke always paints full alpha and a hard
        // edge; the feather slider is the only thing that softens it.
        opacity: 1,
        erase: stroke.erase,
      })
      buildComposite()
      drawMaskPreview(true)
      return
    }

    if (tool === 'rect' || tool === 'ellipse') {
      const start = clampPoint(point, limit)
      gestureRef.current = { kind: 'shape', shape: tool, start, current: start }
      setOverlayTick((value) => value + 1)
      return
    }

    if (tool === 'select') {
      const shapeHit = hitTestShapes(shapeListRef.current, point, viewRef.current.scale, selectedShapeRef.current)
      if (shapeHit !== null) {
        setSelectedShape(shapeHit.shape.id)
        setPaintSelection(null)
        onCommentSelect?.(null)
        onBoxSelect?.(null)
        gestureRef.current = {
          kind: 'shape-edit',
          mode: shapeHit.kind,
          handle: shapeHit.handle,
          shape: shapeHit.shape,
          original: shapeHit.shape.bbox.slice(),
          start: point,
        }
        setOverlayTick((value) => value + 1)
        return
      }
      setSelectedShape(null)
      setPaintSelection(null)
    }

    if (tool === 'box' || tool === 'select') {
      const hit = hitTest(boxes, point, viewRef.current.scale, selectedId)
      if (hit !== null) {
        setSelectedShape(null)
        setPaintSelection(null)
        onCommentSelect?.(null)
        onBoxSelect?.(hit.box.id)
        gestureRef.current = {
          kind: 'box',
          mode: hit.kind,
          handle: hit.handle,
          box: hit.box,
          original: hit.box.bbox.slice(),
          start: point,
        }
        return
      }
      if (tool === 'box') {
        const start = clampPoint(point, limit)
        gestureRef.current = { kind: 'newbox', start, current: start }
        setOverlayTick((value) => value + 1)
      } else {
        onBoxSelect?.(null)
        onCommentSelect?.(null)
        // Clicking painted mask selects that connected stroke: it gets a frame,
        // can be dragged, and Delete/Backspace removes it.
        const region = extractPaintRegion(point)
        if (region !== null) {
          pushUndo()
          setPaintSelection({ bbox: region.bbox, mask: region.mask })
          // A moved blob no longer overlaps its old pixels, so its prompt would
          // look like a brand-new region after the drop: pin the identity.
          const under = regionAtPoint(point)
          const pin = under === null
            ? null
            : { id: under.id, prompt: under.prompt, promptSource: under.promptSource, createdAt: under.createdAt, order: under.order, bbox: region.bbox }
          gestureRef.current = { kind: 'paint-move', start: point, pin, ...region }
        } else {
          setPaintSelection(null)
        }
        setOverlayTick((value) => value + 1)
      }
    }
  }

  function onPointerMove(event) {
    moveBrushRing(event)
    const gesture = gestureRef.current
    if (gesture === null) return
    if (gesture.kind === 'pan') {
      setStageView({
        scale: gesture.view.scale,
        x: gesture.view.x + (event.clientX - gesture.startX),
        y: gesture.view.y + (event.clientY - gesture.startY),
      })
      return
    }
    const point = pointOf(event)
    if (gesture.kind === 'stroke') {
      const layer = paintRef.current
      if (layer === null) return
      drawStrokeSegment(layer.getContext('2d'), gesture.last, point, {
        size: brush.size,
        opacity: 1,
        erase: gesture.erase,
      })
      if (gesture.erase) appendShapeHoles(gesture.holes, point, gesture.last)
      gesture.last = point
      buildComposite()
      drawMaskPreview(true)
      return
    }
    if (gesture.kind === 'comment-new') {
      gesture.current = clampPoint(point, limit)
      const [x1, y1, x2, y2] = normalizeBox(gesture.start, gesture.current)
      draftCommentRef.current = { id: '__draft__', bbox: [x1, y1, x2, y2], text: '' }
      setOverlayTick((value) => value + 1)
      return
    }
    if (gesture.kind === 'comment-edit') {
      const original = gesture.original
      let next
      if (gesture.mode === 'move') {
        const dx = point.x - gesture.start.x
        const dy = point.y - gesture.start.y
        next = [original[0] + dx, original[1] + dy, original[2] + dx, original[3] + dy]
        const w = next[2] - next[0]
        const h = next[3] - next[1]
        if (next[0] < 0) next = [0, next[1], w, next[3]]
        if (next[1] < 0) next = [next[0], 0, next[2], h]
        if (next[2] > limit.width) next = [limit.width - w, next[1], limit.width, next[3]]
        if (next[3] > limit.height) next = [next[0], limit.height - h, next[2], limit.height]
      } else {
        next = resizeBox(original, gesture.handle, point, limit)
      }
      draftCommentRef.current = { ...gesture.comment, bbox: next }
      setOverlayTick((value) => value + 1)
      return
    }
    if (gesture.kind === 'shape') {
      gesture.current = clampPoint(point, limit)
      const [x1, y1, x2, y2] = normalizeBox(gesture.start, gesture.current)
      const draft = { id: '__draft__', kind: gesture.shape, bbox: [x1, y1, x2, y2] }
      draftShapeRef.current = draft
      buildComposite(draft)
      drawMaskPreview(true)
      setOverlayTick((value) => value + 1)
      return
    }
    if (gesture.kind === 'newbox') {
      gesture.current = clampPoint(point, limit)
      setOverlayTick((value) => value + 1)
      return
    }
    if (gesture.kind === 'shape-edit') {
      const original = gesture.original
      let next
      if (gesture.mode === 'move') {
        const dx = point.x - gesture.start.x
        const dy = point.y - gesture.start.y
        next = [original[0] + dx, original[1] + dy, original[2] + dx, original[3] + dy]
        const w = next[2] - next[0]
        const h = next[3] - next[1]
        if (next[0] < 0) next = [0, next[1], w, next[3]]
        if (next[1] < 0) next = [next[0], 0, next[2], h]
        if (next[2] > limit.width) next = [limit.width - w, next[1], limit.width, next[3]]
        if (next[3] > limit.height) next = [next[0], limit.height - h, next[2], limit.height]
      } else {
        next = resizeBox(original, gesture.handle, point, limit)
      }
      const draft = { ...gesture.shape, bbox: next }
      draftShapeRef.current = draft
      buildComposite(draft)
      drawMaskPreview(true)
      setOverlayTick((value) => value + 1)
      return
    }
    if (gesture.kind === 'paint-move') {
      const paint = paintRef.current
      if (!paint) return
      const ctx = paint.getContext('2d')
      const [bx1, by1, bx2, by2] = gesture.bbox
      const dx = clamp(Math.round(point.x - gesture.start.x), -bx1, Math.max(-bx1, limit.width - 1 - bx2))
      const dy = clamp(Math.round(point.y - gesture.start.y), -by1, Math.max(-by1, limit.height - 1 - by2))
      ctx.putImageData(gesture.base, 0, 0)
      ctx.drawImage(gesture.region, gesture.bbox[0] + dx, gesture.bbox[1] + dy)
      paintDraftRef.current = [bx1 + dx, by1 + dy, bx2 + dx, by2 + dy]
      setOverlayTick((value) => value + 1)
      buildComposite()
      drawMaskPreview(true)
      return
    }
    if (gesture.kind === 'box') {
      const original = gesture.original
      let next
      if (gesture.mode === 'move') {
        const dx = point.x - gesture.start.x
        const dy = point.y - gesture.start.y
        next = [
          original[0] + dx, original[1] + dy, original[2] + dx, original[3] + dy,
        ]
        const w = next[2] - next[0]
        const h = next[3] - next[1]
        if (next[0] < 0) next = [0, next[1], w, next[3]]
        if (next[1] < 0) next = [next[0], 0, next[2], h]
        if (next[2] > limit.width) next = [limit.width - w, next[1], limit.width, next[3]]
        if (next[3] > limit.height) next = [next[0], limit.height - h, next[2], limit.height]
      } else {
        next = resizeBox(original, gesture.handle, point, limit)
      }
      setDraft({ ...gesture.box, id: gesture.box.id, bbox: next })
    }
  }

  async function onPointerUp(event) {
    const gesture = gestureRef.current
    gestureRef.current = null
    setCursor('crosshair')
    if (gesture === null) return
    if (gesture.kind === 'comment-new') {
      draftCommentRef.current = null
      const [x1, y1, x2, y2] = normalizeBox(gesture.start, gesture.current)
      setOverlayTick((value) => value + 1)
      if (x2 - x1 >= 6 && y2 - y1 >= 6) {
        await onCommentCreate?.([Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2)])
      }
      return
    }
    if (gesture.kind === 'comment-edit') {
      const draft = draftCommentRef.current
      draftCommentRef.current = null
      setOverlayTick((value) => value + 1)
      if (draft !== null) {
        const bbox = draft.bbox.map((value) => Math.round(value))
        if (bbox[0] !== Math.round(gesture.comment.bbox[0]) || bbox[1] !== Math.round(gesture.comment.bbox[1]) || bbox[2] !== Math.round(gesture.comment.bbox[2]) || bbox[3] !== Math.round(gesture.comment.bbox[3])) {
          await onCommentCommit?.({ ...gesture.comment, bbox })
        }
      }
      return
    }

    if (gesture.kind === 'stroke') {
      if (gesture.erase && Array.isArray(gesture.holes) && gesture.holes.length > 0) {
        // A cut rect/ellipse becomes independent pieces, like erased strokes do.
        const touchedIds = new Set(gesture.holes.map((entry) => entry.shape.id))
        const next = []
        for (const shape of cloneShapes(shapesRef.current)) {
          if (!touchedIds.has(shape.id)) {
            next.push(shape)
            continue
          }
          const pieces = splitShapePieces(shape, limit.width, limit.height, () => `ms-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`)
          if (pieces === null) next.push(shape)
          else next.push(...pieces)
        }
        setSelectedShape(null)
        setShapeList(next)
        commitShapes(next)
      }
      refreshProcessed()
      syncRegions()
      scheduleMaskExport()
      return
    }
    if (gesture.kind === 'paint-move') {
      const draft = paintDraftRef.current
      paintDraftRef.current = null
      if (draft !== null) {
        // The island moved: its selection mask must follow, otherwise Delete
        // would cut the pixels that are still where the drag started.
        setPaintSelection({ bbox: draft, mask: maskFromRegion(gesture.region, draft[0], draft[1]) })
      }
      setOverlayTick((value) => value + 1)
      refreshProcessed()
      syncRegions({ pin: gesture.pin ?? null })
      scheduleMaskExport()
      return
    }
    if (gesture.kind === 'shape') {
      draftShapeRef.current = null
      const [x1, y1, x2, y2] = normalizeBox(gesture.start, gesture.current)
      if (x2 - x1 >= 2 && y2 - y1 >= 2) {
        pushUndo()
        const shape = {
          id: `ms-${Date.now().toString(36)}`,
          kind: gesture.shape,
          bbox: [x1, y1, x2, y2],
        }
        const next = [...shapesRef.current, shape]
        setShapeList(next)
        commitShapes(next)
        refreshProcessed()
        syncRegions()
        scheduleMaskExport()
      }
      setOverlayTick((value) => value + 1)
      return
    }
    if (gesture.kind === 'shape-edit') {
      const draft = draftShapeRef.current
      draftShapeRef.current = null
      if (draft !== null) {
        pushUndo()
        const next = shapesRef.current.map((shape) => {
          if (shape.id !== draft.id) return shape
          if (shape.kind === 'path') {
            return { ...shape, bbox: draft.bbox, points: remapPathPoints(shape, shape.bbox, draft.bbox) }
          }
          return { ...shape, bbox: draft.bbox }
        })
        setShapeList(next)
        commitShapes(next)
        refreshProcessed()
        syncRegions()
        scheduleMaskExport()
      }
      setOverlayTick((value) => value + 1)
      return
    }
    if (gesture.kind === 'newbox') {
      const [x1, y1, x2, y2] = normalizeBox(gesture.start, gesture.current)
      if (x2 - x1 >= 4 && y2 - y1 >= 4) {
        await onBoxCreate?.([x1, y1, x2, y2])
      }
      setDraft(null)
      return
    }
    if (gesture.kind === 'box') {
      const draft = draftBoxRef.current
      setDraft(null)
      if (draft !== null) await onBoxCommit?.({ ...gesture.box, bbox: draft.bbox })
    }
  }

  let captionEditor = null
  if (captionEdit !== null) {
    const summaryBox = boxes.find((box) => box.label === 'summary') ?? null
    const container = containerRef.current
    const rect = container === null ? { width: 0, height: 0 } : container.getBoundingClientRect()
    const scale = view.scale
    const [x1, y1, x2, y2] = captionEdit.bbox
    const width = clamp(Math.max(200, (x2 - x1) * scale), 200, 360)
    const left = clamp(view.x + x1 * scale, 6, Math.max(6, rect.width - width - 6))
    const top = clamp(view.y + y1 * scale, 6, Math.max(6, rect.height - 140))
    captionEditor = React.createElement('div', {
      className: 'ccw-caption-editor',
      style: { left: `${left}px`, top: `${top}px`, width: `${width}px` },
      onPointerDown: (event) => event.stopPropagation(),
      onDoubleClick: (event) => event.stopPropagation(),
    }, [
      captionEdit.kind === 'comment'
        ? React.createElement('span', { className: 'ccw-caption-editor-title', key: 'title' }, tr('captionEditor.commentTitle'))
        : captionEdit.kind === 'mask'
          ? React.createElement('div', { className: 'ccw-caption-editor-meta', key: 'meta' }, [
              React.createElement('span', { className: 'ccw-caption-editor-badge', key: 'badge' },
                String(regionListRef.current.findIndex((region) => region.id === captionEdit.id) + 1).padStart(2, '0')),
              React.createElement('span', { className: 'ccw-caption-editor-chip', key: 'label' }, tr('captionEditor.maskTitle')),
            ])
          : React.createElement('div', { className: 'ccw-caption-editor-meta', key: 'meta' }, [
            React.createElement('span', { className: 'ccw-caption-editor-badge', key: 'badge' },
              String(boxes.findIndex((box) => box.id === captionEdit.id) + 1).padStart(2, '0')),
            React.createElement('span', {
              className: `ccw-caption-editor-chip is-${captionEdit.label ?? 'object'}`,
              key: 'type',
            }, tr(`box.type.${captionEdit.label ?? 'object'}`)),
            Array.isArray(captionEdit.palette) && captionEdit.palette.length > 0
              ? React.createElement('span', { className: 'ccw-caption-editor-palette', key: 'palette' },
                  captionEdit.palette.slice(0, 5).map((color, index) => React.createElement('span', {
                    key: `${color}-${index}`,
                    className: 'ccw-caption-editor-swatch',
                    style: { background: color },
                  })))
              : null,
          ]),
      captionEdit.kind !== 'box'
        ? null
        : React.createElement('label', { className: 'ccw-caption-editor-type', key: 'type' },
            React.createElement('span', null, tr('box.label')),
            React.createElement('select', {
              value: captionEdit.label ?? 'object',
              onChange: (event) => {
                const nextLabel = event.target.value
                const current = { ...captionEdit, label: nextLabel }
                setCaptionEdit(current)
                const box = boxes.find((item) => item.id === current.id)
                if (box !== undefined && typeof onBoxEdit === 'function') {
                  const patch = { label: nextLabel, caption: current.value }
                  if (nextLabel === 'text') patch.text = current.text ?? ''
                  onBoxEdit(box, patch)
                }
              },
            }, [
              React.createElement('option', { key: 'object', value: 'object' }, tr('box.type.object')),
              React.createElement('option', { key: 'character', value: 'character' }, tr('box.type.character')),
              React.createElement('option', { key: 'text', value: 'text' }, tr('box.type.text')),
              React.createElement('option', {
                key: 'summary',
                value: 'summary',
                disabled: summaryBox !== null && summaryBox.id !== captionEdit.id,
              }, tr('box.type.summary')),
            ])),
      captionEdit.kind === 'box' && captionEdit.label === 'text'
        ? React.createElement('label', { className: 'ccw-caption-editor-type', key: 'visible' },
            React.createElement('span', null, tr('box.text')),
            React.createElement('input', {
              type: 'text',
              value: captionEdit.text ?? '',
              onChange: (event) => setCaptionEdit({ ...captionEdit, text: event.target.value }),
              onKeyDown: (event) => {
                event.stopPropagation()
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault()
                  commitCaption()
                }
              },
            }))
        : null,
      captionEdit.kind === 'box'
        ? React.createElement('span', { className: 'ccw-caption-editor-label', key: 'caption-label' }, captionEdit.label === 'summary' ? tr('layout.summary') : tr('box.caption'))
        : null,
      React.createElement('textarea', {
        key: 'input',
        autoFocus: true,
        rows: 3,
        value: captionEdit.value,
        placeholder: captionEdit.kind === 'comment'
          ? tr('comment.placeholder')
          : captionEdit.kind === 'mask' ? tr('mask.promptPlaceholder') : tr('layout.caption'),
        onChange: (event) => setCaptionEdit({ ...captionEdit, value: event.target.value }),
        onKeyDown: (event) => {
          event.stopPropagation()
          if (event.key === 'Escape') {
            event.preventDefault()
            setCaptionEdit(null)
          } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            commitCaption()
          }
        },
        onBlur: (event) => {
          const next = event.relatedTarget
          if (next !== null && typeof next === 'object' && typeof event.currentTarget.parentElement?.contains === 'function' && event.currentTarget.parentElement.contains(next)) return
          commitCaption()
        },
      }),
      captionEdit.kind === 'box'
        ? React.createElement('div', { className: 'ccw-caption-editor-palette-row', key: 'palette-row' }, [
            React.createElement('span', { className: 'ccw-caption-editor-label', key: 'palette-label' }, tr('box.palette')),
            React.createElement('div', { className: 'ccw-palette', key: 'palette' }, [
              ...(Array.isArray(captionEdit.palette) ? captionEdit.palette : []).map((color, index) =>
                React.createElement(ColorField, {
                  key: `${index}-${color}`,
                  value: color,
                  label: tr('box.palette'),
                  t: tr,
                  onChange: (nextColor) => {
                    const palette = (captionEdit.palette ?? []).slice()
                    palette[index] = nextColor
                    const next = { ...captionEdit, palette }
                    setCaptionEdit(next)
                    const box = boxes.find((item) => item.id === captionEdit.id)
                    if (box !== undefined && typeof onBoxEdit === 'function') {
                      onBoxEdit(box, { label: next.label, caption: next.value, palette, text: next.text ?? '' })
                    }
                  },
                  onRemove: () => {
                    const palette = (captionEdit.palette ?? []).filter((_, at) => at !== index)
                    const next = { ...captionEdit, palette }
                    setCaptionEdit(next)
                    const box = boxes.find((item) => item.id === captionEdit.id)
                    if (box !== undefined && typeof onBoxEdit === 'function') {
                      onBoxEdit(box, { label: next.label, caption: next.value, palette, text: next.text ?? '' })
                    }
                  },
                })),
              (captionEdit.palette ?? []).length < 5
                ? React.createElement('button', {
                    key: 'add',
                    type: 'button',
                    className: 'ccw-btn ccw-btn-ghost ccw-btn-small',
                    onClick: () => {
                      const palette = [...(captionEdit.palette ?? []), '#cccccc']
                      setCaptionEdit({ ...captionEdit, palette })
                      const box = boxes.find((item) => item.id === captionEdit.id)
                      if (box !== undefined && typeof onBoxEdit === 'function') {
                        onBoxEdit(box, { label: captionEdit.label, caption: captionEdit.value, palette, text: captionEdit.text ?? '' })
                      }
                    },
                  }, React.createElement('span', null, '+'), React.createElement('span', null, tr('box.paletteAdd')))
                : null,
            ]),
          ])
        : null,
      React.createElement('span', { className: 'ccw-caption-editor-hint', key: 'hint' }, tr('captionEditor.hint')),
    ])
  }

  const stageStyle = {
    width: `${Math.max(1, limit.width * view.scale)}px`,
    height: `${Math.max(1, limit.height * view.scale)}px`,
    transform: `translate(${view.x}px, ${view.y}px)`,
  }

  return React.createElement('div', {
    className: `ccw-stage-wrap ccw-tool-${tool} ${imageUrl ? 'has-image' : 'is-empty'}`,
    ref: containerRef,
    tabIndex: 0,
    onPointerDown: (event) => {
      // Focus the stage so Delete/Backspace reach the canvas instead of the page.
      containerRef.current?.focus?.()
      onPointerDown(event)
    },
    onKeyDown: (event) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return
      event.preventDefault()
      if (removeSelectedShape()) return
      if (removeSelectedPaint()) return
      onDeleteKey?.()
    },
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
    onPointerEnter: () => {
      if (ringRef.current !== null) ringRef.current.style.opacity = '1'
    },
    onPointerLeave: (event) => {
      if (ringRef.current !== null) ringRef.current.style.opacity = '0'
      if (gestureRef.current?.kind === 'pan') onPointerUp(event)
    },
    onDoubleClick: onStageDoubleClick,
  },
  React.createElement('div', { className: 'ccw-stage', ref: stageRef, style: stageStyle },
    imageUrl
      ? React.createElement('img', {
          ref: imageRef,
          className: 'ccw-stage-image',
          src: imageUrl,
          alt: '',
          draggable: false,
          onLoad: () => {
            fit()
            refreshProcessed()
          },
        })
      : null,
    React.createElement('canvas', { ref: maskDisplayRef, className: 'ccw-stage-layer ccw-stage-mask' }),
    React.createElement('canvas', { ref: overlayRef, className: 'ccw-stage-layer ccw-stage-overlay' })),
  React.createElement('div', {
    key: 'ring',
    ref: ringRef,
    className: `ccw-brush-ring ${tool === 'eraser' ? 'is-eraser' : ''}`,
    'aria-hidden': true,
    style: {
      width: `${Math.max(6, brush.size * view.scale)}px`,
      height: `${Math.max(6, brush.size * view.scale)}px`,
      display: tool === 'brush' || tool === 'eraser' ? 'block' : 'none',
    },
  }),
  captionEditor,
  React.createElement('div', { key: 'zoom', className: 'ccw-zoom-hint', 'aria-hidden': true },
    React.createElement('span', { className: 'ccw-zoom-dot' }),
    React.createElement('span', null, `${Math.round(view.scale * 100)}%`)))
})
