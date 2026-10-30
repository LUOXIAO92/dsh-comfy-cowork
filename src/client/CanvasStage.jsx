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
  const line = 1.4 / scale
  const all = draft === null
    ? shapes
    : draft.id === '__draft__'
      ? [...shapes, draft]
      : shapes.map((shape) => (shape.id === draft.id ? { ...shape, bbox: draft.bbox } : shape))
  for (const shape of all) {
    const [x1, y1, x2, y2] = shape.bbox
    const isDraft = draft !== null && shape.id === draft.id
    const selected = shape.id === selectedId || isDraft
    ctx.save()
    ctx.strokeStyle = color
    ctx.globalAlpha = selected ? 0.95 : 0.5
    ctx.lineWidth = selected ? 1.8 / scale : line
    ctx.setLineDash(isDraft ? [6 / scale, 4 / scale] : [5 / scale, 4 / scale])
    ctx.beginPath()
    if (shape.kind === 'ellipse') {
      ctx.ellipse(x1 + (x2 - x1) / 2, y1 + (y2 - y1) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2)
    } else {
      ctx.rect(x1, y1, x2 - x1, y2 - y1)
    }
    ctx.stroke()
    ctx.restore()
    if (selected && !isDraft) {
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
  const eraseRef = useRef(null)
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
   * The mask is three layers: brush strokes, vector rect/ellipse shapes and
   * eraser cuts. Shapes stay editable objects even when part of them is erased.
   */
  function buildComposite() {
    const paint = paintRef.current
    const erase = eraseRef.current
    if (!paint || !erase) return null
    const composite = createCanvas(limit.width, limit.height)
    const ctx = composite.getContext('2d')
    ctx.drawImage(paint, 0, 0)
    for (const shape of shapesRef.current) fillMaskShape(ctx, shape, shape.opacity ?? 1)
    ctx.globalCompositeOperation = 'destination-out'
    ctx.drawImage(erase, 0, 0)
    ctx.globalCompositeOperation = 'source-over'
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
  }

  useEffect(() => {
    drawOverlay()
  }, [boxes, selectedId, draftBox, overlayTick, view.scale, shapeList, selectedShape])

  useEffect(() => {
    paintRef.current = createCanvas(limit.width, limit.height)
    eraseRef.current = createCanvas(limit.width, limit.height)
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
        fetch(`/api/comfy-coworking/asset?session=${encodeURIComponent(sessionId)}&name=mask.png&v=${Date.now()}`)
          .then((response) => (response.ok ? response.blob() : null))
          .then((blob) => (blob === null ? null : createImageBitmap(blob)))
          .then((bitmap) => {
            if (cancelled || bitmap === null || paintRef.current === null) return
            paintRef.current.getContext('2d').drawImage(bitmap, 0, 0, limit.width, limit.height)
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
    const hit = hitTest(boxes, point, viewRef.current.scale, selectedId)
    if (hit === null) {
      fit()
      return
    }
    onBoxSelect?.(hit.box.id)
    setCaptionEdit({ id: hit.box.id, value: String(hit.box.caption ?? ''), bbox: hit.box.bbox.slice() })
  }

  function commitCaption() {
    const edit = captionEdit
    setCaptionEdit(null)
    if (edit === null) return
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
    const erase = eraseRef.current
    if (!paint || !erase) return null
    return {
      paint: paint.getContext('2d').getImageData(0, 0, paint.width, paint.height),
      erase: erase.getContext('2d').getImageData(0, 0, erase.width, erase.height),
      shapes: shapesRef.current.map((shape) => ({ ...shape, bbox: shape.bbox.slice() })),
    }
  }

  function pushUndo() {
    const next = snapshot()
    if (next === null) return
    const bytesPerSnapshot = next.paint.data.length + next.erase.data.length
    const cap = clamp(Math.floor((192 * 1024 * 1024) / Math.max(1, bytesPerSnapshot)), 4, 12)
    undoRef.current.push(next)
    while (undoRef.current.length > cap) undoRef.current.shift()
    redoRef.current = []
  }

  function restore(next) {
    const paint = paintRef.current
    const erase = eraseRef.current
    if (!paint || !erase || !next) return
    paint.getContext('2d').putImageData(next.paint, 0, 0)
    erase.getContext('2d').putImageData(next.erase, 0, 0)
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
    const erase = eraseRef.current
    if (!paint || !erase) return
    pushUndo()
    paint.getContext('2d').clearRect(0, 0, paint.width, paint.height)
    erase.getContext('2d').clearRect(0, 0, erase.width, erase.height)
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
    let rgbaBlob = null
    if (imageRef.current && imageRef.current.complete && imageRef.current.naturalWidth > 0) {
      const rgba = composeRgba(imageRef.current, processed, limit.width, limit.height)
      rgbaBlob = await canvasToBlob(rgba)
    }
    return { maskBlob, rgbaBlob, hasMask: hasMaskPixels(processed), canvas: processed, shapes: shapesRef.current }
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

    if (tool === 'brush' || tool === 'eraser') {
      const layer = tool === 'eraser' ? eraseRef.current : paintRef.current
      if (!layer) return
      pushUndo()
      const stroke = {
        kind: 'stroke',
        erase: tool === 'eraser',
        last: point,
      }
      gestureRef.current = stroke
      drawDot(layer.getContext('2d'), point, {
        size: brush.size,
        opacity: brush.opacity,
        erase: false,
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
      const layer = gesture.erase ? eraseRef.current : paintRef.current
      if (layer === null) return
      drawStrokeSegment(layer.getContext('2d'), gesture.last, point, {
        size: brush.size,
        hardness: brush.hardness,
        opacity: brush.opacity,
        erase: false,
      })
      gesture.last = point
      buildComposite()
      drawMaskPreview(true)
      return
    }
    if (gesture.kind === 'shape' || gesture.kind === 'newbox') {
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
      draftShapeRef.current = { ...gesture.shape, bbox: next }
      setOverlayTick((value) => value + 1)
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
    if (gesture.kind === 'stroke') {
      refreshProcessed()
      scheduleMaskExport()
      return
    }
    if (gesture.kind === 'shape') {
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
      React.createElement('span', { className: 'ccw-caption-editor-title', key: 'title' }, tr('captionEditor.title')),
      React.createElement('textarea', {
        key: 'input',
        autoFocus: true,
        rows: 3,
        value: captionEdit.value,
        placeholder: tr('layout.caption'),
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
