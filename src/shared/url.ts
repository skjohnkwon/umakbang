/** Shared between the protocol handler in main and the URL builder exposed to the renderer. */

export const UMAKBANG_FILE_SCHEME = 'umakbang-file'

/** Builds a URL the renderer can hand to an <audio> element or fetch(). */
export function toUmakbangFileUrl(absolutePath: string): string {
  return `${UMAKBANG_FILE_SCHEME}://media/${encodeURIComponent(absolutePath)}`
}

/**
 * The same file, typed as something to look at rather than something to hear.
 *
 * The host is what the handler reads to choose a family of Content-Type, and it exists
 * because `.mp4` is honestly ambiguous: in this library it is nearly always an audio
 * container, and the protocol has always served it as `audio/mp4` so the transport can play
 * it. A `<video>` element given `audio/mp4` plays the sound and draws nothing at all, which
 * looks exactly like a broken layer. Rather than guess from the extension, the caller says
 * which it wants - it is the one thing at the call site that is never in doubt.
 */
export function toUmakbangVisualUrl(absolutePath: string): string {
  return `${UMAKBANG_FILE_SCHEME}://visual/${encodeURIComponent(absolutePath)}`
}

/** Which family a request asked for. Anything unrecognised is treated as media. */
export function urlFamily(url: string): 'media' | 'visual' {
  try {
    return new URL(url).host === 'visual' ? 'visual' : 'media'
  } catch {
    return 'media'
  }
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
