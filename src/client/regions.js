/**
 * Mask region model, browser side.
 *
 * The painted mask is one raster, but the user edits "independent masks": each
 * visibly separate blob gets its own local repaint prompt and its own inpaint
 * pass. A region is therefore a connected component of the painted mask, and
 * its identity has to survive erasing, adding strokes, and splitting/merging.
 *
 * Everything here is pure and DOM-free so node tests can drive it: the caller
 * owns the canvases, this module only works on alpha maps, component labels and
 * downsampled samples.
 */

/** Components thinner than this are antialias specks, not user intent. */
export const MIN_REGION_AREA = 64

/** Downsample factor used to match new components against the previous ones. */
export const SAMPLE_SCALE = 4

/** Alpha at or above this counts as painted. */
const PAINT_THRESHOLD = 128

/** A component inherits a region when at least this share of its sample overlaps. */
const MATCH_SHARE = 0.08
const MATCH_MIN_CELLS = 4

let idCounter = 0

/** Region ids land in asset file names, so keep them to a safe alphabet. */
export function defaultMakeId() {
  idCounter += 1
  return `mr-${Date.now().toString(36)}-${idCounter.toString(36)}`
}

/**
 * Label the connected painted areas of an alpha map (4-neighbour connectivity).
 *
 * @param alpha - one byte per pixel, row-major.
 * @param width - canvas width in pixels.
 * @param height - canvas height in pixels.
 * @returns dense component indices in `labels` (0 = unpainted) and one entry per
 *   surviving component, ordered top-left first: `{ index, area, bbox }`.
 */
export function labelComponents(alpha, width, height, { threshold = PAINT_THRESHOLD, minArea = MIN_REGION_AREA } = {}) {
  const total = width * height
  const labels = new Int32Array(total)
  const stack = new Int32Array(total)
  const found = []
  let next = 0
  for (let start = 0; start < total; start += 1) {
    if (alpha[start] < threshold || labels[start] !== 0) continue
    next += 1
    labels[start] = next
    let top = 1
    stack[0] = start
    let area = 0
    let minX = width
    let minY = height
    let maxX = -1
    let maxY = -1
    while (top > 0) {
      top -= 1
      const pixel = stack[top]
      area += 1
      const x = pixel % width
      const y = (pixel - x) / width
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      if (x > 0) {
        const at = pixel - 1
        if (labels[at] === 0 && alpha[at] >= threshold) {
          labels[at] = next
          stack[top] = at
          top += 1
        }
      }
      if (x + 1 < width) {
        const at = pixel + 1
        if (labels[at] === 0 && alpha[at] >= threshold) {
          labels[at] = next
          stack[top] = at
          top += 1
        }
      }
      if (y > 0) {
        const at = pixel - width
        if (labels[at] === 0 && alpha[at] >= threshold) {
          labels[at] = next
          stack[top] = at
          top += 1
        }
      }
      if (y + 1 < height) {
        const at = pixel + width
        if (labels[at] === 0 && alpha[at] >= threshold) {
          labels[at] = next
          stack[top] = at
          top += 1
        }
      }
    }
    found.push({ index: next, area, bbox: [minX, minY, maxX + 1, maxY + 1] })
  }

  if (!found.some((component) => component.area < minArea)) return { labels, components: found }

  // Drop specks and close the index gaps so indices stay dense.
  const remap = new Int32Array(next + 1)
  const components = []
  for (const component of found) {
    if (component.area < minArea) continue
    components.push({ index: components.length + 1, area: component.area, bbox: component.bbox })
    remap[component.index] = components.length
  }
  for (let pixel = 0; pixel < total; pixel += 1) {
    const label = labels[pixel]
    if (label !== 0) labels[pixel] = remap[label]
  }
  return { labels, components }
}

const sampleWidth = (width, scale) => Math.max(1, Math.ceil(width / scale))
const sampleHeight = (height, scale) => Math.max(1, Math.ceil(height / scale))

/**
 * Downsample each component to a coarse 0/1 sample used for identity matching.
 * A cell is set when any of its pixels belongs to the component, so a stroke
 * that merely shifts a few pixels stays recognisably the same region.
 *
 * @returns one Uint8Array per component, in `components` order.
 */
export function sampleComponents(labels, components, width, height, scale = SAMPLE_SCALE) {
  const gw = sampleWidth(width, scale)
  const gh = sampleHeight(height, scale)
  const samples = components.map(() => new Uint8Array(gw * gh))
  for (let y = 0; y < height; y += 1) {
    const row = Math.floor(y / scale) * gw
    for (let x = 0; x < width; x += 1) {
      const label = labels[y * width + x]
      if (label === 0) continue
      samples[label - 1][row + Math.floor(x / scale)] = 1
    }
  }
  return samples
}

/** Number of set cells in a sample. */
function sampleArea(sample) {
  let area = 0
  for (let i = 0; i < sample.length; i += 1) area += sample[i]
  return area
}

/** Intersection size of two 0/1 samples. */
function overlap(a, b) {
  let shared = 0
  for (let i = 0; i < a.length; i += 1) if (a[i] === 1 && b[i] === 1) shared += 1
  return shared
}

/**
 * Keep region identity across mask edits.
 *
 * Every component takes the previous region it overlaps most (if enough): a
 * stroke that extends a blob keeps its prompt, a blob split in two duplicates
 * it (both halves were one edit), a stroke that bridges two blobs keeps the
 * larger blob's prompt and drops the other, and paint in a new place starts an
 * empty region of its own. Inherited regions keep their creation order, new ones
 * are appended, so the run order is the order the user painted.
 *
 * @param options - current components and samples, previous regions carrying a
 *   `sample` each, an id factory and the clock.
 * @returns regions in run order: `{ id, prompt, promptSource, createdAt, order,
 *   bbox, componentIndex, sample }`.
 */
export function assignRegions({ components, samples, previous = [], makeId = defaultMakeId, now = Date.now() }) {
  const claimed = new Set()
  const regions = []
  let maxOrder = 0
  for (const region of previous) {
    if (Number.isFinite(region.order)) maxOrder = Math.max(maxOrder, region.order)
  }

  for (const component of components) {
    const sample = samples[component.index - 1]
    const area = sampleArea(sample)
    let best = null
    let bestOverlap = 0
    for (const region of previous) {
      if (!(region.sample instanceof Uint8Array)) continue
      const shared = overlap(sample, region.sample)
      if (shared > bestOverlap) {
        bestOverlap = shared
        best = region
      }
    }
    const enough = best !== null && bestOverlap >= Math.max(MATCH_MIN_CELLS, area * MATCH_SHARE)
    if (!enough) {
      maxOrder += 1
      regions.push({
        id: makeId(),
        prompt: '',
        promptSource: 'user',
        createdAt: now,
        order: maxOrder,
        bbox: component.bbox,
        componentIndex: component.index,
        sample,
      })
      continue
    }
    // A split half keeps the prompt but needs its own id; the first claimant
    // keeps the original id so a reload still finds the same asset.
    const keepId = !claimed.has(best.id)
    if (keepId) claimed.add(best.id)
    regions.push({
      id: keepId ? best.id : makeId(),
      prompt: typeof best.prompt === 'string' ? best.prompt : '',
      promptSource: best.promptSource === 'agent' ? 'agent' : 'user',
      createdAt: Number.isFinite(best.createdAt) ? best.createdAt : now,
      order: Number.isFinite(best.order) ? best.order : maxOrder + 1,
      bbox: component.bbox,
      componentIndex: component.index,
      sample,
    })
  }

  regions.sort((a, b) => a.order - b.order || a.componentIndex - b.componentIndex)
  return regions
}

/** Bounding-box intersection over the smaller box, 0..1. */
export function bboxScore(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 4 || b.length !== 4) return 0
  const width = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
  const height = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
  const intersection = width * height
  if (intersection === 0) return 0
  const areaA = Math.max(1, (a[2] - a[0]) * (a[3] - a[1]))
  const areaB = Math.max(1, (b[2] - b[0]) * (b[3] - b[1]))
  return intersection / Math.min(areaA, areaB)
}

/** Largest component by bounding-box area. */
function largestRegion(regions) {
  let largest = regions[0]
  let largestArea = 0
  for (const region of regions) {
    const area = (region.bbox[2] - region.bbox[0]) * (region.bbox[3] - region.bbox[1])
    if (area > largestArea) {
      largestArea = area
      largest = region
    }
  }
  return largest
}

/**
 * First sync of a page: the document holds region prompts but no samples (they
 * are runtime-only), so match components to the persisted regions by bounding
 * box and give each the prompt it had.
 *
 * A document with no regions but a legacy `mask.prompt` seeds the largest
 * component, which is what a single-mask run used to do.
 */
export function seedRegions({ components, samples, docRegions = [], legacyPrompt = '', makeId = defaultMakeId, now = Date.now() }) {
  const regions = []
  for (const component of components) {
    let best = null
    let bestScore = 0
    for (const region of docRegions) {
      const score = bboxScore(component.bbox, region.bbox)
      if (score > bestScore) {
        bestScore = score
        best = region
      }
    }
    const source = best !== null && bestScore >= 0.5 ? best : null
    regions.push({
      id: source !== null && typeof source.id === 'string' && source.id !== '' ? source.id : makeId(),
      prompt: source !== null && typeof source.prompt === 'string' ? source.prompt : '',
      promptSource: source !== null && source.promptSource === 'agent' ? 'agent' : 'user',
      createdAt: source !== null && Number.isFinite(source.createdAt) ? source.createdAt : now,
      order: source !== null ? Number(docRegions.indexOf(source)) : docRegions.length + component.index,
      bbox: component.bbox,
      componentIndex: component.index,
      sample: samples[component.index - 1],
    })
  }
  const legacy = String(legacyPrompt ?? '')
  if (regions.length > 0 && legacy.trim() !== '' && docRegions.length === 0) {
    largestRegion(regions).prompt = legacy
  }
  regions.sort((a, b) => a.order - b.order || a.componentIndex - b.componentIndex)
  return regions
}
