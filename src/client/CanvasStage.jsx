import * as React from 'react'
import {
  canvasToBlob,
  composeRgba,
  createCanvas,
  drawDot,
  drawStrokeSegment,
  fillMaskShape,
  hasMaskPixels,
  processMask,
  tintedMask,
} from './mask.js'

const { forwardRef, useEffect, useImperativeHandle, useRef, useState } = React

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function normalizeBox(a, b) {
  return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)]
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
    ctx.strokeStyle = selected ? '#4cc9f0' : 'rgba(76,201,240,0.65)'
    ctx.lineWidth = selected ? 2 / scale : line
    ctx.setLineDash(isDraft ? [6 / scale, 4 / scale] : [])
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1)
    ctx.setLineDash([])
    const label = String(index + 1).padStart(2, '0')
    const fontPx = 11 / scale
    ctx.font = `${fontPx}px ui-sans-serif, system-ui, sans-serif`
    const textWidth = ctx.measureText(label).width
    const pad = 3 / scale
    const labelHeight = fontPx + pad * 2
    ctx.fillStyle = selected ? '#4cc9f0' : 'rgba(76,201,240,0.85)'
    ctx.fillRect(x1, y1, textWidth + pad * 2, labelHeight)
    ctx.fillStyle = '#06202b'
    ctx.fillText(label, x1 + pad, y1 + fontPx + pad * 0.7)
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
    onBoxSelect,
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
  const shapesRef = useRef(shapeList)
  shapesRef.current = shapeList

  useEffect(() => {
    if (gestureRef.current !== null) return
    setShapeList(Array.isArray(shapes) ? shapes : [])
  }, [shapes])

  settingsRef.current = maskSettings
  viewRef.current = view
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
      const live = draft !== null && draft.id === shape.id ? { ...shape, bbox: draft.bbox } : shape
      fillMaskShape(ctx, live, live.opacity ?? 1, 'source-over', true)
    }
    if (draft !== null && draft.id === '__draft__') fillMaskShape(ctx, draft, draft.opacity ?? 1, 'source-over', true)
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
    display.style.opacity = maskSettings.visible ? String(maskSettings.opacity) : '0'
    ctx.globalCompositeOperation = 'source-over'
  }

  function refreshProcessed() {
    const composite = buildComposite()
    if (!composite) return
    processedRef.current = processMask(composite, settingsRef.current)
    drawMaskPreview(false)
    setOverlayTick((value) => value + 1)
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
    return { base, region, bbox: [minX, minY, maxX, maxY] }
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

  function appendShapeHoles(touched, point) {
    if (!Array.isArray(touched)) return
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
  }

  useEffect(() => {
    drawOverlay()
  }, [boxes, selectedId, draftBox, overlayTick, view.scale, shapeList, selectedShape, comments, selectedComment])

  // Shapes live in the composite mask, so a new list needs a new raster.
  useEffect(() => {
    refreshProcessed()
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

  useEffect(() => {
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
    const key = `${imageUrl ?? ''}|${limit.width}x${limit.height}`
    if (loadedKeyRef.current !== key) {
      loadedKeyRef.current = key
      if (imageUrl) {
        let cancelled = false
        const asset = (name) => `/api/comfy-coworking/asset?session=${encodeURIComponent(sessionId)}&name=${name}&v=${Date.now()}`
        fetch(asset('mask-brush.png'))
          .then((response) => (response.ok ? response.blob() : null))
          .then(async (blob) => {
            const brushOnly = blob !== null
            const source = blob ?? (await (await fetch(asset('mask.png'))).blob())
            return { bitmap: blob === null && source.size === 0 ? null : await createImageBitmap(source), brushOnly }
          })
          .then(({ bitmap, brushOnly }) => {
            if (cancelled || bitmap === null || paintRef.current === null) return
            paintRef.current.getContext('2d').drawImage(bitmap, 0, 0, limit.width, limit.height)
            if (!brushOnly) eraseShapesFromPaint()
            refreshProcessed()
          })
          .catch(() => {})
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
  }, [maskSettings.feather, maskSettings.grow, maskSettings.inverted, maskSettings.color, maskSettings.opacity, maskSettings.visible])

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
    if (tool === 'comment') {
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
      fit()
      return
    }
    onBoxSelect?.(hit.box.id)
    setCaptionEdit({ kind: 'box', id: hit.box.id, value: String(hit.box.caption ?? ''), bbox: hit.box.bbox.slice() })
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
    const box = boxes.find((item) => item.id === edit.id)
    if (box === undefined || String(box.caption ?? '') === edit.value) return
    onBoxCaption?.(box, edit.value)
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

  function removeSelectedShape() {
    const id = selectedShapeRef.current
    if (id === null) return false
    pushUndo()
    const next = shapesRef.current.filter((shape) => shape.id !== id)
    setSelectedShape(null)
    setShapeList(next)
    commitShapes(next)
    refreshProcessed()
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
    scheduleMaskExport()
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
    return { maskBlob, brushBlob, rgbaBlob, hasMask: hasMaskPixels(processed), canvas: processed, shapes: shapesRef.current }
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
      onDeleteKey?.()
    },
    clearSelection: () => {
      setSelectedShape(null)
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

    if (tool === 'comment') {
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
      onCommentSelect?.(null)
      gestureRef.current = { kind: 'comment-new', start: point, current: point }
      setOverlayTick((value) => value + 1)
      return
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
        opacity: brush.opacity,
        erase: stroke.erase,
      })
      buildComposite()
      drawMaskPreview(true)
      return
    }

    if (tool === 'rect' || tool === 'ellipse') {
      gestureRef.current = { kind: 'shape', shape: tool, start: point, current: point }
      setOverlayTick((value) => value + 1)
      return
    }

    if (tool === 'select') {
      const shapeHit = hitTestShapes(shapeListRef.current, point, viewRef.current.scale, selectedShapeRef.current)
      if (shapeHit !== null) {
        setSelectedShape(shapeHit.shape.id)
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
    }

    if (tool === 'box' || tool === 'select') {
      const hit = hitTest(boxes, point, viewRef.current.scale, selectedId)
      if (hit !== null) {
        setSelectedShape(null)
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
        gestureRef.current = { kind: 'newbox', start: point, current: point }
        setOverlayTick((value) => value + 1)
      } else {
        onBoxSelect?.(null)
        // Grabbing painted mask (brush/eraser result) lets the whole mask move.
        const region = extractPaintRegion(point)
        if (region !== null) {
          pushUndo()
          gestureRef.current = { kind: 'paint-move', start: point, ...region }
        }
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
        hardness: brush.hardness,
        opacity: brush.opacity,
        erase: gesture.erase,
      })
      if (gesture.erase) appendShapeHoles(gesture.holes, point)
      gesture.last = point
      buildComposite()
      drawMaskPreview(true)
      return
    }
    if (gesture.kind === 'comment-new') {
      gesture.current = point
      const [x1, y1, x2, y2] = normalizeBox(gesture.start, point)
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
      gesture.current = point
      const [x1, y1, x2, y2] = normalizeBox(gesture.start, point)
      const draft = { id: '__draft__', kind: gesture.shape, bbox: [x1, y1, x2, y2], opacity: brush.opacity }
      draftShapeRef.current = draft
      buildComposite(draft)
      drawMaskPreview(true)
      setOverlayTick((value) => value + 1)
      return
    }
    if (gesture.kind === 'newbox') {
      gesture.current = point
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
        const next = cloneShapes(shapesRef.current)
        setShapeList(next)
        commitShapes(next)
      }
      refreshProcessed()
      scheduleMaskExport()
      return
    }
    if (gesture.kind === 'paint-move') {
      refreshProcessed()
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
          opacity: brush.opacity,
        }
        const next = [...shapesRef.current, shape]
        setShapeList(next)
        commitShapes(next)
        refreshProcessed()
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
        const next = shapesRef.current.map((shape) => (shape.id === draft.id ? { ...shape, bbox: draft.bbox } : shape))
        setShapeList(next)
        commitShapes(next)
        refreshProcessed()
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
      React.createElement('span', { className: 'ccw-caption-editor-title', key: 'title' }, captionEdit.kind === 'comment' ? tr('captionEditor.commentTitle') : tr('captionEditor.title')),
      React.createElement('textarea', {
        key: 'input',
        autoFocus: true,
        rows: 3,
        value: captionEdit.value,
        placeholder: captionEdit.kind === 'comment' ? tr('comment.placeholder') : tr('layout.caption'),
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
        onBlur: () => commitCaption(),
      }),
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
