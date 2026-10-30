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

function stamp(ctx, x, y, radius, hardness, opacity, erase) {
  const solid = Math.max(0.01, Math.min(0.99, hardness))
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, Math.max(0.5, radius))
  gradient.addColorStop(0, `rgba(255,255,255,${opacity})`)
  gradient.addColorStop(solid, `rgba(255,255,255,${opacity})`)
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.save()
  ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over'
  ctx.fillStyle = gradient
  ctx.beginPath()
  ctx.arc(x, y, Math.max(0.5, radius), 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
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

export function drawStrokeSegment(ctx, from, to, { size, hardness, opacity, erase }) {
  const radius = Math.max(0.5, size / 2)
  if (hardness >= 0.97) {
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
    return
  }
  const dx = to.x - from.x
  const dy = to.y - from.y
  const distance = Math.hypot(dx, dy)
  const spacing = Math.max(0.75, size * 0.14)
  const steps = Math.max(1, Math.ceil(distance / spacing))
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps
    stamp(ctx, from.x + dx * t, from.y + dy * t, radius, hardness, opacity, erase)
  }
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
export function processMask(raw, { feather = 0, grow = 0, inverted = false } = {}) {
  let current = createCanvas(raw.width, raw.height)
  current.getContext('2d').drawImage(raw, 0, 0)

  const amount = Math.round(Number(grow) || 0)
  if (amount > 0) current = dilate(current, amount)
  else if (amount < 0) current = invertCanvas(dilate(invertCanvas(current), -amount))

  if (inverted) current = invertCanvas(current)

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
