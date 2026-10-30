/** Minimal image dimension reader for PNG/JPEG/WebP/GIF (no dependencies). */

export function imageSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null
  if (buffer.readUInt32BE(0) === 0x89504e47) {
    if (buffer.toString('ascii', 12, 16) !== 'IHDR' || buffer.length < 24) return null
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), type: 'png' }
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = buffer[offset + 1]
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2
        continue
      }
      const length = buffer.readUInt16BE(offset + 2)
      if (length < 2) return null
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5), type: 'jpeg' }
      }
      offset += 2 + length
    }
    return null
  }
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buffer.toString('ascii', 12, 16)
    if (chunk === 'VP8X' && buffer.length >= 30) {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3),
        type: 'webp',
      }
    }
    if (chunk === 'VP8 ' && buffer.length >= 30) {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff, type: 'webp' }
    }
    if (chunk === 'VP8L' && buffer.length >= 25) {
      const bits = buffer.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, type: 'webp' }
    }
    return null
  }
  if (buffer.toString('ascii', 0, 3) === 'GIF' && buffer.length >= 10) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8), type: 'gif' }
  }
  return null
}
