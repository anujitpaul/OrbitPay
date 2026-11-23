import { LIMITS } from './types'

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp'])
const MAX_FILE_BYTES = 12 * 1024 * 1024
const MAX_SIDE = 720

/**
 * Turns a user's picture into a small JPEG preview that is safe to store and to put in a link.
 * The file is decoded and redrawn on a canvas, so metadata (such as GPS) is dropped and nothing but pixels survives.
 */
export async function makePreview(file: File): Promise<string> {
  if (!ALLOWED.has(file.type)) throw new Error('Use a JPEG, PNG or WebP image.')
  if (file.size > MAX_FILE_BYTES) throw new Error('That image is larger than 12 MB.')
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('That image could not be read.')
  })
  try {
    for (const [side, quality] of [[MAX_SIDE, 0.72], [600, 0.62], [480, 0.55], [360, 0.5]] as const) {
      const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Images are not supported in this browser.')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      const url = canvas.toDataURL('image/jpeg', quality)
      if (url.length <= LIMITS.imageChars) return url
    }
    throw new Error('That image is too detailed to attach. Try a smaller one.')
  } finally {
    bitmap.close()
  }
}
