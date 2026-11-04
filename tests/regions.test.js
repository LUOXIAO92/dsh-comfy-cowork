import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MIN_REGION_AREA,
  SAMPLE_SCALE,
  assignRegions,
  bboxScore,
  labelComponents,
  sampleComponents,
  seedRegions,
} from '../src/client/regions.js'

/** Build a width*height alpha map and paint filled rectangles into it. */
function alphaMap(width, height, rects) {
  const alpha = new Uint8Array(width * height)
  for (const [x1, y1, x2, y2] of rects) {
    for (let y = y1; y < y2; y += 1) {
      for (let x = x1; x < x2; x += 1) alpha[y * width + x] = 255
    }
  }
  return alpha
}

/** Label + sample in one call, the way the stage does it. */
function build(width, height, rects) {
  const { labels, components } = labelComponents(alphaMap(width, height, rects), width, height)
  return { labels, components, samples: sampleComponents(labels, components, width, height) }
}

/** A previous-region list out of the current components, prompts assigned in order. */
function previousFrom(built, prompts) {
  return built.components.map((component, index) => ({
    id: `mr-${index + 1}`,
    prompt: prompts[index] ?? '',
    promptSource: 'user',
    createdAt: 1 + index,
    order: index + 1,
    bbox: component.bbox,
    componentIndex: component.index,
    sample: built.samples[index],
  }))
}

let idSeq = 0
const makeId = () => {
  idSeq += 1
  return `new-${idSeq}`
}

test('labels separate blobs and reports their boxes', () => {
  const { labels, components } = labelComponents(alphaMap(40, 30, [[2, 3, 12, 13], [20, 10, 34, 28]]), 40, 30)
  assert.equal(components.length, 2)
  assert.deepEqual(components[0].bbox, [2, 3, 12, 13])
  assert.deepEqual(components[1].bbox, [20, 10, 34, 28])
  assert.equal(components[0].area, 100)
  assert.equal(labels[3 * 40 + 2], components[0].index)
  assert.equal(labels[10 * 40 + 20], components[1].index)
})

test('drops antialias specks and keeps the indices dense', () => {
  const alpha = alphaMap(40, 30, [[2, 3, 12, 13]])
  // A lone antialiased pixel, well under the speck threshold.
  alpha[20 * 40 + 30] = 255
  assert.ok(MIN_REGION_AREA > 1)
  const { labels, components } = labelComponents(alpha, 40, 30)
  assert.equal(components.length, 1)
  assert.equal(labels[20 * 40 + 30], 0)
  assert.equal(labels[3 * 40 + 2], 1)
})

test('samples downsample whole cells and stay aligned with the components', () => {
  const built = build(40, 30, [[0, 0, 8, 8]])
  assert.equal(built.samples.length, 1)
  const sample = built.samples[0]
  const gw = Math.ceil(40 / SAMPLE_SCALE)
  assert.equal(sample.length, gw * Math.ceil(30 / SAMPLE_SCALE))
  assert.equal(sample[0], 1)
  assert.equal(sample[gw + 1], 1)
})

test('an extended blob keeps its region and prompt', () => {
  const before = build(40, 30, [[2, 2, 12, 12]])
  const previous = previousFrom(before, ['a feather'])
  const after = build(40, 30, [[2, 2, 18, 18]])
  const next = assignRegions({ components: after.components, samples: after.samples, previous, makeId })
  assert.equal(next.length, 1)
  assert.equal(next[0].id, 'mr-1')
  assert.equal(next[0].prompt, 'a feather')
})

test('paint in a new place starts an empty region after the old ones', () => {
  const before = build(40, 30, [[2, 2, 12, 12]])
  const previous = previousFrom(before, ['a feather'])
  const after = build(40, 30, [[2, 2, 12, 12], [22, 16, 34, 26]])
  const next = assignRegions({ components: after.components, samples: after.samples, previous, makeId })
  assert.equal(next.length, 2)
  assert.deepEqual(next.map((region) => region.prompt), ['a feather', ''])
  assert.equal(next[0].id, 'mr-1')
  assert.ok(next[1].id.startsWith('new-'))
})

test('a blob split in two keeps the prompt on both halves with distinct ids', () => {
  const before = build(60, 30, [[2, 2, 52, 14]])
  const previous = previousFrom(before, ['white feathers'])
  const after = build(60, 30, [[2, 2, 24, 14], [30, 2, 52, 14]])
  const next = assignRegions({ components: after.components, samples: after.samples, previous, makeId })
  assert.equal(next.length, 2)
  assert.deepEqual(next.map((region) => region.prompt), ['white feathers', 'white feathers'])
  assert.notEqual(next[0].id, next[1].id)
})

test('a stroke bridging two blobs keeps the larger prompt and drops the other', () => {
  const big = [[2, 2, 30, 20]]
  const small = [[34, 4, 40, 10]]
  const before = build(60, 30, [...big, ...small])
  const previous = previousFrom(before, ['a big edit', 'a small edit'])
  // Join them with a bar; the merged component overlaps the big blob most.
  const after = build(60, 30, [[2, 2, 30, 20], [30, 8, 40, 12]])
  const next = assignRegions({ components: after.components, samples: after.samples, previous, makeId })
  assert.equal(next.length, 1)
  assert.equal(next[0].prompt, 'a big edit')
})

test('erasing a whole blob takes its prompt with it', () => {
  const before = build(60, 30, [[2, 2, 12, 12], [30, 2, 40, 12]])
  const previous = previousFrom(before, ['first', 'second'])
  const after = build(60, 30, [[2, 2, 12, 12]])
  const next = assignRegions({ components: after.components, samples: after.samples, previous, makeId })
  assert.equal(next.length, 1)
  assert.equal(next[0].prompt, 'first')
})

test('a new empty mask has no regions', () => {
  const built = build(20, 20, [])
  assert.equal(built.components.length, 0)
  assert.deepEqual(assignRegions({ components: [], samples: [], previous: [] }), [])
})

test('seeding matches persisted prompts by bbox and falls back to the largest blob', () => {
  const built = build(60, 30, [[2, 2, 20, 18], [30, 4, 40, 14]])
  const seeded = seedRegions({
    components: built.components,
    samples: built.samples,
    docRegions: [
      { id: 'mr-a', prompt: 'left edit', promptSource: 'user', bbox: [2, 2, 20, 18] },
      { id: 'mr-b', prompt: 'right edit', promptSource: 'agent', bbox: [30, 4, 40, 14] },
    ],
    makeId,
  })
  assert.deepEqual(seeded.map((region) => region.id), ['mr-a', 'mr-b'])
  assert.deepEqual(seeded.map((region) => region.prompt), ['left edit', 'right edit'])
  assert.equal(seeded[1].promptSource, 'agent')

  const legacy = seedRegions({ components: built.components, samples: built.samples, docRegions: [], legacyPrompt: 'old single prompt', makeId })
  assert.deepEqual(legacy.map((region) => region.prompt), ['old single prompt', ''])
})

test('bboxScore reads overlap over the smaller box', () => {
  assert.equal(bboxScore([0, 0, 10, 10], [0, 0, 10, 10]), 1)
  assert.equal(bboxScore([0, 0, 10, 10], [5, 0, 15, 10]), 0.5)
  assert.equal(bboxScore([0, 0, 10, 10], [20, 0, 30, 10]), 0)
  assert.equal(bboxScore(null, [0, 0, 1, 1]), 0)
})
