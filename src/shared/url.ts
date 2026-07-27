/** Shared between the protocol handler in main and the URL builder exposed to the renderer. */

export const UMAKBANG_FILE_SCHEME = 'umakbang-file'

/** Builds a URL the renderer can hand to an <audio> element or fetch(). */
export function toUmakbangFileUrl(absolutePath: string): string {
  return `${UMAKBANG_FILE_SCHEME}://media/${encodeURIComponent(absolutePath)}`
}

export function fromUmakbangFileUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    const encoded = parsed.pathname.replace(/^\//, '')
    if (!encoded) return null
    return decodeURIComponent(encoded)
  } catch {
    return null
  }
}
