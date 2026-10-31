import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { decodePng, maskExtent } from '../lib/png.js'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** CRC is not verified by the reader, so a zero word keeps the fixture small. */
function chunk(type, data) {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(data.length, 0)
  header.write(type, 4, 'latin1')
  return Buffer.concat([header, data, Buffer.alloc(4)])
}

function makePng(width, height, channels, paint) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = channels === 4 ? 6 : channels === 3 ? 2 : channels === 2 ? 4 : 0
  const stride = width * channels
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    for (let x = 0; x < width; x += 1) {
      const samples = paint(x, y)
      if (samples === null || samples === undefined) continue
      const at = y * (stride + 1) + 1 + x * channels
      for (let index = 0; index < channels; index += 1) raw[at + index] = samples[index] ?? 0
    }
  }
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

test('decodes an RGBA png and reports the painted mask bbox', () => {
  const png = makePng(6, 4, 4, (x, y) => (x >= 1 && x <= 3 && y >= 1 && y <= 2 ? [255, 255, 255, 255] : null))
  const decoded = decodePng(png)
  assert.equal(decoded.width, 6)
  assert.equal(decoded.height, 4)
  assert.equal(decoded.channels, 4)
  assert.deepEqual(maskExtent(decoded), { bbox: [1, 1, 3, 2], pixels: 6 })
})

test('decodes a grayscale mask', () => {
  const png = makePng(5, 5, 1, (x, y) => (x === 2 && y === 3 ? [255] : null))
  const decoded = decodePng(png)
  assert.equal(decoded.channels, 1)
  assert.deepEqual(maskExtent(decoded), { bbox: [2, 3, 2, 3], pixels: 1 })
})

test('ignores fully transparent white pixels', () => {
  const png = makePng(3, 3, 4, (x, y) => (x === 1 && y === 1 ? [255, 255, 255, 0] : null))
  assert.equal(maskExtent(decodePng(png)), null)
})

test('rejects data that is not a supported png', () => {
  assert.equal(decodePng(Buffer.from('not a png')), null)
  assert.equal(decodePng(SIGNATURE), null)
})
