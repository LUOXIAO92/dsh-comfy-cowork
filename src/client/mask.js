/** Canvas 2D mask helpers (browser only). */

export function createCanvas(width, height) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width))
  canvas.height = Math.max(1, Math.round(height))
  return canvas
}

export function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) reject(new Error('could not encode canvas'))
      else resolve(blob)
    }, 'image/png')
  })
}

export function drawDot(ctx, point, { size, opacity, erase }) {
  ctx.save()
  ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over'
  ctx.globalAlpha = Math.max(0, Math.min(1, opacity))
  ctx.fillStyle = '#ffffff'
  ctx.beginPath()
  ctx.arc(point.x, point.y, Math.max(0.5, size / 2), 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/**
 * Paint one stroke segment. The mask is a stencil: every stroke is a hard,
 * full-alpha line, and softness is the feather slider's job alone (a1111 has no
 * brush hardness either, only Mask blur).
 */
export function drawStrokeSegment(ctx, from, to, { size, opacity, erase }) {
  ctx.save()
  ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over'
  ctx.globalAlpha = Math.max(0, Math.min(1, opacity))
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = Math.max(1, size)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(from.x, from.y)
  ctx.lineTo(to.x, to.y)
  ctx.stroke()
  ctx.restore()
}

/**
 * Paint one vector mask shape (a rect or ellipse object with a pixel bbox) onto
 * a mask canvas. Shapes stay editable objects; the eraser layer cuts them at
 * composite time instead of destroying them.
 */
export function fillMaskShape(ctx, shape, opacity = 1, composite = 'source-over', withHoles = false) {
  const bbox = Array.isArray(shape?.bbox) ? shape.bbox.map(Number) : []
  if (bbox.length !== 4 || !bbox.every(Number.isFinite)) return
  const x = Math.min(bbox[0], bbox[2])
  const y = Math.min(bbox[1], bbox[3])
  const w = Math.abs(bbox[2] - bbox[0])
  const h = Math.abs(bbox[3] - bbox[1])
  if (w < 0.5 || h < 0.5) return
  ctx.save()
  ctx.globalCompositeOperation = composite
  ctx.globalAlpha = Math.max(0, Math.min(1, Number(opacity) || 0))
  ctx.fillStyle = '#ffffff'
  ctx.beginPath()
  const points = Array.isArray(shape.points) ? shape.points : []
  if (shape.kind === 'path' && points.length >= 3) {
    const first = points[0]
    ctx.moveTo(Number(first[0]) || 0, Number(first[1]) || 0)
    for (let index = 1; index < points.length; index += 1) {
      ctx.lineTo(Number(points[index][0]) || 0, Number(points[index][1]) || 0)
    }
    ctx.closePath()
  } else if (shape.kind === 'ellipse') {
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2)
  } else {
    ctx.rect(x, y, w, h)
  }
  ctx.fill()
  ctx.restore()
  if (withHoles) drawShapeHoles(ctx, shape, bbox)
}

/**
 * Erase strokes cut a shape while keeping its bbox: the hole is stored on the
 * shape in normalized coordinates so it moves and scales with the shape and
 * never acts as a canvas-wide stencil.
 */
function drawShapeHoles(ctx, shape, bbox) {
  const holes = Array.isArray(shape?.holes) ? shape.holes : []
  if (holes.length === 0) return
  const x = Math.min(bbox[0], bbox[2])
  const y = Math.min(bbox[1], bbox[3])
  const w = Math.abs(bbox[2] - bbox[0])
  const h = Math.abs(bbox[3] - bbox[1])
  const unit = Math.max(1, Math.max(w, h))
  ctx.save()
  ctx.globalCompositeOperation = 'destination-out'
  ctx.strokeStyle = '#ffffff'
  ctx.fillStyle = '#ffffff'
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const hole of holes) {
    const points = Array.isArray(hole?.points) ? hole.points : []
    if (points.length === 0) continue
    const diameter = Math.max(1, (Number(hole.width) || 0) * unit)
    ctx.lineWidth = diameter
    const mapped = points
      .filter((point) => Array.isArray(point) && point.length === 2)
      .map((point) => [x + point[0] * w, y + point[1] * h])
    if (mapped.length === 0) continue
    if (mapped.length === 1) {
      ctx.beginPath()
      ctx.arc(mapped[0][0], mapped[0][1], diameter / 2, 0, Math.PI * 2)
      ctx.fill()
      continue
    }
    ctx.beginPath()
    ctx.moveTo(mapped[0][0], mapped[0][1])
    for (let index = 1; index < mapped.length; index += 1) ctx.lineTo(mapped[index][0], mapped[index][1])
    ctx.stroke()
  }
  ctx.restore()
}

export function drawShape(ctx, shape, { opacity, erase }) {
  const x = Math.min(shape.start.x, shape.end.x)
  const y = Math.min(shape.start.y, shape.end.y)
  const w = Math.abs(shape.end.x - shape.start.x)
  const h = Math.abs(shape.end.y - shape.start.y)
  if (w < 0.5 || h < 0.5) return
  ctx.save()
  ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over'
  ctx.globalAlpha = Math.max(0, Math.min(1, opacity))
  ctx.fillStyle = '#ffffff'
  ctx.beginPath()
  if (shape.kind === 'ellipse') ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2)
  else ctx.rect(x, y, w, h)
  ctx.fill()
  ctx.restore()
}

function invertCanvas(source) {
  const canvas = createCanvas(source.width, source.height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.globalCompositeOperation = 'destination-out'
  ctx.drawImage(source, 0, 0)
  return canvas
}

function dilate(source, radius) {
  const canvas = createCanvas(source.width, source.height)
  const ctx = canvas.getContext('2d')
  const steps = 24
  for (let i = 0; i < steps; i += 1) {
    const angle = (i / steps) * Math.PI * 2
    ctx.drawImage(source, Math.cos(angle) * radius, Math.sin(angle) * radius)
  }
  ctx.drawImage(source, 0, 0)
  return canvas
}

/**
 * Apply grow/shrink, inversion, and feather to a raw white-on-transparent mask.
 * Returns a new canvas; the raw mask is never mutated.
 */
export function processMask(raw, { feather = 0, grow = 0 } = {}) {
  let current = createCanvas(raw.width, raw.height)
  current.getContext('2d').drawImage(raw, 0, 0)

  const amount = Math.round(Number(grow) || 0)
  if (amount > 0) current = dilate(current, amount)
  else if (amount < 0) current = invertCanvas(dilate(invertCanvas(current), -amount))

  const blur = Math.round(Number(feather) || 0)
  if (blur > 0) {
    const feathered = createCanvas(raw.width, raw.height)
    const ctx = feathered.getContext('2d')
    ctx.filter = `blur(${blur}px)`
    ctx.drawImage(current, 0, 0)
    ctx.filter = 'none'
    current = feathered
  }
  return current
}

export function tintedMask(processed, color, opacity) {
  const canvas = createCanvas(processed.width, processed.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(processed, 0, 0)
  ctx.globalCompositeOperation = 'source-in'
  ctx.fillStyle = color
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.globalCompositeOperation = 'source-over'
  return { canvas, opacity: Math.max(0, Math.min(1, opacity)) }
}

export function composeRgba(image, mask, width, height) {
  // ComfyUI's LoadImage returns MASK = 1 - alpha. White in our mask means
  // "editable", so the exported RGBA must be transparent there: alpha = 1 - mask.
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0, width, height)
  ctx.globalCompositeOperation = 'destination-out'
  ctx.drawImage(mask, 0, 0, width, height)
  ctx.globalCompositeOperation = 'source-over'
  return canvas
}

export function hasMaskPixels(canvas) {
  const size = 128
  const scale = Math.min(1, size / Math.max(canvas.width, canvas.height))
  const probe = createCanvas(Math.max(1, Math.round(canvas.width * scale)), Math.max(1, Math.round(canvas.height * scale)))
  const ctx = probe.getContext('2d')
  ctx.drawImage(canvas, 0, 0, probe.width, probe.height)
  const data = ctx.getImageData(0, 0, probe.width, probe.height).data
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] > 4) return true
  }
  return false
}
