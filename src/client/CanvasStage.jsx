import * as React from 'react'
import {
  canvasToBlob,
  composeRgba,
  createCanvas,
  drawDot,
  drawShape,
  drawStrokeSegment,
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
  const all = draft ? [...boxes, draft] : boxes
  all.forEach((item, index) => {
    const [x1, y1, x2, y2] = item.bbox
    const selected = item.id === selectedId || item === draft
    ctx.strokeStyle = selected ? '#4cc9f0' : 'rgba(76,201,240,0.65)'
    ctx.lineWidth = selected ? 2 / scale : line
    ctx.setLineDash(draft && item === draft ? [6 / scale, 4 / scale] : [])
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
    if (selected && !draft) {
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

/**
 * Live preview of a mask rectangle/ellipse while dragging: mask tint plus a
 * dashed outline in the mask colour and no index badge, so it never reads as a
 * layout box.
 */
function drawShapePreview(ctx, gesture, scale, color) {
  const [x1, y1, x2, y2] = normalizeBox(gesture.start, gesture.current)
  const width = x2 - x1
  const height = y2 - y1
  if (width < 1 || height < 1) return
  ctx.save()
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = 1.5 / scale
  ctx.setLineDash([5 / scale, 4 / scale])
  ctx.beginPath()
  if (gesture.shape === 'ellipse') ctx.ellipse(x1 + width / 2, y1 + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2)
  else ctx.rect(x1, y1, width, height)
  ctx.globalAlpha = 0.16
  ctx.fill()
  ctx.globalAlpha = 1
  ctx.stroke()
  ctx.restore()
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
    onBoxCreate,
    onBoxCommit,
    onBoxSelect,
    onMaskReady,
    onMessage,
    onDeleteKey,
  } = props

  const containerRef = useRef(null)
  const stageRef = useRef(null)
  const imageRef = useRef(null)
  const maskDisplayRef = useRef(null)
  const overlayRef = useRef(null)
  const rawRef = useRef(null)
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
  const [overlayTick, setOverlayTick] = useState(0)
  const [cursor, setCursor] = useState('crosshair')

  settingsRef.current = maskSettings
  viewRef.current = view

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

  function drawMaskPreview(fromRaw) {
    const display = maskDisplayRef.current
    const source = fromRaw ? rawRef.current : processedRef.current
    if (!display || !source) return
    const ctx = display.getContext('2d')
    ctx.globalCompositeOperation = 'source-over'
    ctx.clearRect(0, 0, display.width, display.height)
    const tinted = tintedMask(source, maskSettings.color, maskSettings.opacity)
    ctx.drawImage(tinted.canvas, 0, 0)
    display.style.opacity = maskSettings.visible ? String(maskSettings.opacity) : '0'
    ctx.globalCompositeOperation = 'source-over'
  }

  function refreshProcessed() {
    const raw = rawRef.current
    if (!raw) return
    processedRef.current = processMask(raw, settingsRef.current)
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
    // A mask rectangle/ellipse is not a layout box: it gets the mask tint and
    // no index badge, so the two never read as the same object.
    if (gesture?.kind === 'shape') {
      drawShapePreview(ctx, gesture, viewRef.current.scale, maskSettings.color ?? '#ff3b30')
    }
  }

  useEffect(() => {
    drawOverlay()
  }, [boxes, selectedId, draftBox, overlayTick, view.scale])

  useEffect(() => {
    const raw = createCanvas(limit.width, limit.height)
    const processed = createCanvas(limit.width, limit.height)
    rawRef.current = raw
    processedRef.current = processed
    undoRef.current = []
    redoRef.current = []
    for (const canvas of [maskDisplayRef.current, overlayRef.current]) {
      if (!canvas) continue
      canvas.width = limit.width
      canvas.height = limit.height
    }
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
            if (cancelled || bitmap === null || rawRef.current === null) return
            rawRef.current.getContext('2d').drawImage(bitmap, 0, 0, limit.width, limit.height)
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

  function pushUndo() {
    const raw = rawRef.current
    if (!raw) return
    const bytesPerSnapshot = raw.width * raw.height * 4
    const cap = clamp(Math.floor((192 * 1024 * 1024) / Math.max(1, bytesPerSnapshot)), 4, 12)
    const ctx = raw.getContext('2d')
    undoRef.current.push(ctx.getImageData(0, 0, raw.width, raw.height))
    while (undoRef.current.length > cap) undoRef.current.shift()
    redoRef.current = []
  }

  function restore(snapshot) {
    const raw = rawRef.current
    if (!raw || !snapshot) return
    raw.getContext('2d').putImageData(snapshot, 0, 0)
    refreshProcessed()
    scheduleMaskExport()
  }

  function undo() {
    const snapshot = undoRef.current.pop()
    const raw = rawRef.current
    if (snapshot === undefined || !raw) return
    redoRef.current.push(raw.getContext('2d').getImageData(0, 0, raw.width, raw.height))
    restore(snapshot)
  }

  function redo() {
    const snapshot = redoRef.current.pop()
    const raw = rawRef.current
    if (snapshot === undefined || !raw) return
    undoRef.current.push(raw.getContext('2d').getImageData(0, 0, raw.width, raw.height))
    restore(snapshot)
  }

  function clearMask() {
    const raw = rawRef.current
    if (!raw) return
    pushUndo()
    raw.getContext('2d').clearRect(0, 0, raw.width, raw.height)
    refreshProcessed()
    scheduleMaskExport()
  }

  async function exportBlobs() {
    const raw = rawRef.current
    if (!raw) throw new Error('canvas is not ready')
    const processed = processMask(raw, settingsRef.current)
    processedRef.current = processed
    const maskBlob = await canvasToBlob(processed)
    let rgbaBlob = null
    if (imageRef.current && imageRef.current.complete && imageRef.current.naturalWidth > 0) {
      const rgba = composeRgba(imageRef.current, processed, limit.width, limit.height)
      rgbaBlob = await canvasToBlob(rgba)
    }
    return { maskBlob, rgbaBlob, hasMask: hasMaskPixels(processed), canvas: processed }
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
    exportNow: async () => {
      const blobs = await exportBlobs()
      await onMaskReady?.(blobs)
      return blobs
    },
    hasMask: () => (rawRef.current ? hasMaskPixels(rawRef.current) : false),
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
      if (!rawRef.current) return
      pushUndo()
      const stroke = {
        kind: 'stroke',
        erase: tool === 'eraser',
        last: point,
      }
      gestureRef.current = stroke
      drawDot(rawRef.current.getContext('2d'), point, {
        size: brush.size,
        opacity: brush.opacity,
        erase: stroke.erase,
      })
      drawMaskPreview(true)
      return
    }

    if (tool === 'rect' || tool === 'ellipse') {
      gestureRef.current = { kind: 'shape', shape: tool, start: point, current: point }
      setOverlayTick((value) => value + 1)
      return
    }

    if (tool === 'box' || tool === 'select') {
      const hit = hitTest(boxes, point, viewRef.current.scale, selectedId)
      if (hit !== null) {
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
      drawStrokeSegment(rawRef.current.getContext('2d'), gesture.last, point, {
        size: brush.size,
        hardness: brush.hardness,
        opacity: brush.opacity,
        erase: gesture.erase,
      })
      gesture.last = point
      drawMaskPreview(true)
      return
    }
    if (gesture.kind === 'shape' || gesture.kind === 'newbox') {
      gesture.current = point
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
      const raw = rawRef.current
      if (!raw) return
      pushUndo()
      drawShape(raw.getContext('2d'), gesture, {
        opacity: brush.opacity,
        erase: tool === 'eraser',
      })
      refreshProcessed()
      scheduleMaskExport()
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
      onDeleteKey?.()
    },
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
    onPointerLeave: (event) => {
      if (gestureRef.current?.kind === 'pan') onPointerUp(event)
    },
    onDoubleClick: fit,
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
  React.createElement('div', { className: 'ccw-zoom-hint', 'aria-hidden': true },
    React.createElement('span', { className: 'ccw-zoom-dot' }),
    React.createElement('span', null, `${Math.round(view.scale * 100)}%`)))
})
