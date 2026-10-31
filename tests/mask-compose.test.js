import test from 'node:test'
import assert from 'node:assert/strict'
import { decodePng, encodePng } from '../lib/png.js'
import { composeMaskedImage } from '../lib/mask-compose.js'

function image(size, channels, paint) {
  const data = Buffer.alloc(size * size * channels)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const at = (y * size + x) * channels
      const samples = paint(x, y)
      for (let index = 0; index < channels; index += 1) data[at + index] = samples[index]
    }
  }
  return encodePng(size, size, channels, data)
}

test('derives an RGBA whose alpha is 1 - mask', () => {
  const canvas = image(4, 4, () => [200, 40, 30, 255])
  const mask = image(4, 1, (x, y) => (x === 1 && y === 2 ? [255] : [0]))
  const composed = composeMaskedImage(canvas, mask)
  const decoded = decodePng(composed)
  assert.equal(decoded.width, 4)
  assert.equal(decoded.channels, 4)
  const alphaAt = (x, y) => decoded.data[(y * 4 + x) * 4 + 3]
  assert.equal(alphaAt(1, 2), 0)
  assert.equal(alphaAt(0, 0), 255)
  const red = decoded.data.slice(0, 3)
  assert.deepEqual([...red], [200, 40, 30])
})

test('uses the brush alpha for a transparent-backed mask', () => {
  const canvas = image(3, 4, () => [10, 20, 30, 255])
  const brush = image(3, 4, (x, y) => (x === 2 && y === 0 ? [255, 255, 255, 128] : [0, 0, 0, 0]))
  const decoded = decodePng(composeMaskedImage(canvas, brush))
  const alphaAt = (x, y) => decoded.data[(y * 3 + x) * 4 + 3]
  assert.equal(alphaAt(2, 0), 127)
  assert.equal(alphaAt(0, 0), 255)
})

test('refuses mismatched or undecodable pairs', () => {
  const canvas = image(4, 4, () => [255, 255, 255, 255])
  const mask = image(3, 3, () => [0])
  assert.equal(composeMaskedImage(canvas, mask), null)
  assert.equal(composeMaskedImage(Buffer.from('not a png'), mask), null)
  assert.equal(composeMaskedImage(canvas, null), null)
})
