/**
 * Tiny PNG chunk surgery, used to embed the comment JSON inside the exported
 * RGBA image so annotations travel with the picture.
 *
 * Only needs to add one iTXt chunk before IEND; the rest of the file is copied
 * byte for byte.
 */

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let index = 0; index < 4; index += 1) out[4 + index] = type.charCodeAt(index)
  out.set(data, 8)
  const crcInput = out.subarray(4, 8 + data.length)
  view.setUint32(8 + data.length, crc32(crcInput))
  return out
}

function readUint32(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
}

/**
 * Insert an iTXt chunk (UTF-8 payload) before IEND. Returns a new blob; when
 * the input is not a PNG the original blob comes back untouched.
 */
export async function embedPngText(blob, keyword, text) {
  if (typeof Blob === 'undefined' || !(blob instanceof Blob)) return blob
  const bytes = new Uint8Array(await blob.arrayBuffer())
  if (bytes.length < 8 || SIGNATURE.some((value, index) => bytes[index] !== value)) return blob
  let offset = 8
  while (offset + 8 <= bytes.length) {
    const length = readUint32(bytes, offset)
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7])
    if (type === 'IEND') {
      const encoder = new TextEncoder()
      const key = encoder.encode(keyword)
      const payload = encoder.encode(text)
      // keyword \0 compressionFlag(0) compressionMethod(0) languageTag \0 translatedKeyword \0 text
      const data = new Uint8Array(key.length + 1 + 1 + 1 + 1 + 1 + payload.length)
      data.set(key, 0)
      let cursor = key.length + 1
      data[cursor] = 0
      cursor += 1
      data[cursor] = 0
      cursor += 1
      data[cursor] = 0
      cursor += 1
      data[cursor] = 0
      cursor += 1
      data.set(payload, cursor)
      const textChunk = chunk('iTXt', data)
      return new Blob([bytes.subarray(0, offset), textChunk, bytes.subarray(offset)], { type: 'image/png' })
    }
    offset += 12 + length
  }
  return blob
}
