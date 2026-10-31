/**
 * Build the inpaint input from the canvas image and its mask.
 *
 * The browser normally uploads `canvas_rgba.png` (the image with the mask cut
 * out of its alpha channel) beside `mask.png`. A fresh host, or a mask painted
 * right after an image swap, may have only the mask; deriving the RGBA here
 * keeps a run from silently ignoring what the user painted. ComfyUI's
 * LoadImage returns MASK = 1 - alpha, so painted areas must be transparent.
 */

import { decodePng, encodePng } from './png.js'

/**
 * @param imageBuffer - canvas.png bytes (PNG only; another format returns null).
 * @param maskBuffer - mask.png bytes; white/opaque marks the editable area.
 * @returns PNG bytes with the mask cut from the alpha channel, or null when the
 *   pair cannot be decoded or does not match.
 */
export function composeMaskedImage(imageBuffer, maskBuffer) {
  if (!imageBuffer || !maskBuffer) return null
  let image
  let mask
  try {
    image = decodePng(imageBuffer)
    mask = decodePng(maskBuffer)
  } catch {
    return null
  }
  if (image === null || mask === null) return null
  if (image.width !== mask.width || image.height !== mask.height) return null
  const { width, height } = image
  const out = Buffer.alloc(width * height * 4)
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const src = pixel * image.channels
    const m = pixel * mask.channels
    const gray = image.channels === 1 || image.channels === 2
    const alpha = image.channels === 4 ? image.data[src + 3] / 255 : image.channels === 2 ? image.data[src + 1] / 255 : 1
    const painted = mask.channels === 4
      ? mask.data[m + 3] / 255
      : mask.channels === 2
        ? mask.data[m + 1] / 255
        : mask.data[m] / 255
    const dst = pixel * 4
    out[dst] = image.data[src]
    out[dst + 1] = gray ? image.data[src] : image.data[src + 1]
    out[dst + 2] = gray ? image.data[src] : image.data[src + 2]
    out[dst + 3] = Math.round(alpha * (1 - painted) * 255)
  }
  return encodePng(width, height, 4, out)
}
