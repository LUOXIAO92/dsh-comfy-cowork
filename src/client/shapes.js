/**
 * Split a rasterised mask shape into its connected pieces.
 *
 * The eraser is raster-first, so a rect or ellipse that is cut in two must
 * become two independent objects (the same way a brush stroke naturally splits
 * into disconnected islands). The pieces are returned as `path` shapes with an
 * absolute polygon outline, which keeps them cheap to draw and easy to move.
 */

import { createCanvas, fillMaskShape } from './mask.js'

function floodComponents(mask, width, height) {
  const seen = new Uint8Array(width * height)
  const components = []
  const stack = []
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] === 0 || seen[index] === 1) continue
    const startX = index % width
    const startY = (index - startX) / width
    const pixels = []
    let minX = startX
    let maxX = startX
    let minY = startY
    let maxY = startY
    stack.length = 0
    stack.push(index)
    seen[index] = 1
    while (stack.length > 0) {
      const current = stack.pop()
      const x = current % width
      const y = (current - x) / width
      pixels.push(current)
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      if (x > 0 && mask[current - 1] === 1 && seen[current - 1] === 0) {
        seen[current - 1] = 1
        stack.push(current - 1)
      }
      if (x + 1 < width && mask[current + 1] === 1 && seen[current + 1] === 0) {
        seen[current + 1] = 1
        stack.push(current + 1)
      }
      if (y > 0 && mask[current - width] === 1 && seen[current - width] === 0) {
        seen[current - width] = 1
        stack.push(current - width)
      }
      if (y + 1 < height && mask[current + width] === 1 && seen[current + width] === 0) {
        seen[current + width] = 1
        stack.push(current + width)
      }
    }
    components.push({ pixels, bbox: [minX, minY, maxX, maxY] })
  }
  return components
}

/**
 * Trace the outer contour of one connected component with a Moore-neighbour
 * walk, then drop collinear points so the polygon stays small.
 */
function traceOutline(pixels, bbox, width, height) {
  const set = new Set(pixels)
  const [minX, minY, maxX, maxY] = bbox
  const inside = (x, y) => x >= 0 && y >= 0 && x < width && y < height && set.has(y * width + x)
  let startX = -1
  let startY = -1
  for (let y = minY; y <= maxY && startX < 0; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (inside(x, y)) {
        startX = x
        startY = y
        break
      }
    }
  }
  if (startX < 0) return []
  const directions = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]
  const points = [[startX, startY]]
  let x = startX
  let y = startY
  let direction = 6
  const limit = pixels.length * 8 + 64
  for (let step = 0; step < limit; step += 1) {
    let found = false
    for (let offset = 0; offset < 8; offset += 1) {
      const next = (direction + offset + 6) % 8
      const nx = x + directions[next][0]
      const ny = y + directions[next][1]
      if (inside(nx, ny)) {
        x = nx
        y = ny
        direction = next
        points.push([x, y])
        found = true
        break
      }
    }
    if (!found) break
    if (x === startX && y === startY && points.length > 2) break
  }
  const simplified = []
  for (let index = 0; index < points.length; index += 1) {
    const previous = simplified[simplified.length - 1]
    const current = points[index]
    if (previous !== undefined && previous[0] === current[0] && previous[1] === current[1]) continue
    const nextPoint = points[(index + 1) % points.length]
    const collinear = previous !== undefined
      && nextPoint !== undefined
      && Math.sign(current[0] - previous[0]) === Math.sign(nextPoint[0] - current[0])
      && Math.sign(current[1] - previous[1]) === Math.sign(nextPoint[1] - current[1])
    if (collinear) continue
    simplified.push(current)
  }
  return simplified
}

/**
 * Rasterise a shape and return its visually separate pieces, or null when the
 * shape is still one piece.
 */
export function splitShapePieces(shape, width, height, makeId) {
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  fillMaskShape(ctx, shape, 1, 'source-over', true)
  const data = ctx.getImageData(0, 0, width, height).data
  const mask = new Uint8Array(width * height)
  for (let index = 0; index < mask.length; index += 1) {
    mask[index] = data[index * 4 + 3] > 64 ? 1 : 0
  }
  const components = floodComponents(mask, width, height)
  if (components.length <= 1) return null
  const pieces = []
  for (const component of components) {
    if (component.pixels.length < 12) continue
    const outline = traceOutline(component.pixels, component.bbox, width, height)
    if (outline.length < 3) continue
    pieces.push({
      id: makeId(),
      kind: 'path',
      bbox: component.bbox.slice(),
      points: outline,
      holes: [],
    })
  }
  return pieces.length > 0 ? pieces : null
}

/** Map a path shape's polygon onto a new bbox (move or resize). */
export function remapPathPoints(shape, previousBBox, nextBBox) {
  if (shape.kind !== 'path' || !Array.isArray(shape.points)) return shape.points
  const [px1, py1, px2, py2] = previousBBox
  const [nx1, ny1, nx2, ny2] = nextBBox
  const scaleX = (nx2 - nx1) / Math.max(1, px2 - px1)
  const scaleY = (ny2 - ny1) / Math.max(1, py2 - py1)
  return shape.points.map((point) => [
    nx1 + (point[0] - px1) * scaleX,
    ny1 + (point[1] - py1) * scaleY,
  ])
}
