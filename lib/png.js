/**
 * Minimal PNG reader for the mask assets.
 *
 * The canvas masks are browser `toBlob('image/png')` files (8-bit RGBA) or
 * images generated beside them, so only the non-interlaced 8-bit subset is
 * supported. The point is not image processing: `state` needs the painted
 * region's bounding box so the agent can see where the user masked without
 * fetching every asset and decoding it itself.
 */

import { deflateSync, inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/**
 * Decode one PNG into raw 8-bit samples.
 *
 * @param buffer - PNG bytes.
 * @returns `{ width, height, channels, data }`, or null when unsupported/corrupt.
 */
export function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer)
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) return null
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const chunks = []
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    if (offset + 12 + length > buffer.length) return null
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') {
      chunks.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0
  if (width === 0 || height === 0 || bitDepth !== 8 || channels === 0 || interlace !== 0) return null
  let raw
  try {
    raw = inflateSync(Buffer.concat(chunks))
  } catch {
    return null
  }
  const stride = width * channels
  if (raw.length < (stride + 1) * height) return null
  const out = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const rowStart = y * (stride + 1) + 1
    const dst = y * stride
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? out[dst + x - channels] : 0
      const b = y > 0 ? out[dst - stride + x] : 0
      const c = x >= channels && y > 0 ? out[dst - stride + x - channels] : 0
      const value = raw[rowStart + x]
      let decoded
      if (filter === 0) decoded = value
      else if (filter === 1) decoded = value + a
      else if (filter === 2) decoded = value + b
      else if (filter === 3) decoded = value + ((a + b) >> 1)
      else if (filter === 4) decoded = value + paeth(a, b, c)
      else return null
      out[dst + x] = decoded & 0xff
    }
  }
  return { width, height, channels, data: out }
}

/** One mask pixel counts as painted when it is bright and not transparent. */
function isPainted(data, index, channels) {
  if (channels === 1) return data[index] > 128
  if (channels === 2) return data[index] > 128 && data[index + 1] > 8
  if (channels === 3) return data[index] > 128 && data[index + 1] > 128 && data[index + 2] > 128
  return data[index + 3] > 8 && (data[index] > 128 || data[index + 1] > 128 || data[index + 2] > 128)
}

/**
 * Bounding box of the painted mask pixels.
 *
 * @param png - decoded PNG.
 * @returns `{ bbox: [x1, y1, x2, y2], pixels }` in image pixels, or null when nothing is painted.
 */
export function maskExtent(png) {
  if (png === null || png === undefined) return null
  const { width, height, channels, data } = png
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  let count = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!isPainted(data, (y * width + x) * channels, channels)) continue
      count += 1
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  return count === 0 ? null : { bbox: [minX, minY, maxX, maxY], pixels: count }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let value = n
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[n] = value >>> 0
  }
  return table
})()

function crc32(buffer) {
  let value = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) value = CRC_TABLE[(value ^ buffer[index]) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(data.length, 0)
  header.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  const body = Buffer.concat([header.subarray(4, 8), data])
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([header, data, crc])
}

/**
 * Encode raw 8-bit samples as a non-interlaced PNG.
 *
 * @param width - image width.
 * @param height - image height.
 * @param channels - 1 (gray), 3 (RGB) or 4 (RGBA).
 * @param data - width*height*channels samples.
 * @returns PNG bytes.
 */
export function encodePng(width, height, channels, data) {
  const colorType = channels === 4 ? 6 : channels === 3 ? 2 : channels === 1 ? 0 : -1
  if (colorType < 0) throw new Error(`unsupported png channel count: ${channels}`)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = colorType
  const stride = width * channels
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}
