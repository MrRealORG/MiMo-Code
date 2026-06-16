const startsWith = (bytes: Uint8Array, prefix: number[]) => prefix.every((value, index) => bytes[index] === value)

export function isPdfAttachment(mime: string) {
  return mime === "application/pdf"
}

export function isMedia(mime: string) {
  return mime.startsWith("image/") || isPdfAttachment(mime)
}

export function isImageAttachment(mime: string) {
  return mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet"
}

/**
 * Image MIME types accepted by the MiMo API.
 * Files with other image/* MIME types (e.g. image/x-icon, image/tiff)
 * will be rejected by the API with a 400 error, so we filter them out
 * before sending to avoid repeated failures across conversation turns.
 * See: https://github.com/XiaomiMiMo/MiMo-Code/issues/351
 */
export const SUPPORTED_IMAGE_MIMES = new Set([
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])

export function isSupportedImageMime(mime: string): boolean {
  return SUPPORTED_IMAGE_MIMES.has(mime)
}

export function sniffAttachmentMime(bytes: Uint8Array, fallback: string) {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"
  if (startsWith(bytes, [0x42, 0x4d])) return "image/bmp"
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) {
    return "image/webp"
  }

  return fallback
}
