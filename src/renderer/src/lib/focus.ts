/**
 * Taking focus away from something that is still letting go of it.
 *
 * A Radix menu unmounts a frame or two after the action it triggered has already opened
 * an editor, and when its focused item disappears the browser drops focus on the body.
 * A single `focus()` at mount loses that race: the editor is on screen, visibly ready,
 * and every keystroke goes nowhere. That is a horrible thing to ship, and an easy one to
 * miss, because synthetic events in a test never reproduce it.
 *
 * So rather than focusing once, keep claiming it for a few frames until it sticks.
 */
export function claimFocus(
  element: HTMLElement | null,
  onClaim?: (element: HTMLElement) => void,
  /** Frames to keep trying. A menu teardown settles well inside this. */
  frames = 20
): () => void {
  if (!element) return () => {}

  let remaining = frames
  let handle = 0

  const attempt = (): void => {
    if (document.activeElement !== element) {
      element.focus()
      onClaim?.(element)
    }
    if (remaining-- > 0 && document.activeElement !== element) {
      handle = requestAnimationFrame(attempt)
    }
  }

  attempt()
  return () => cancelAnimationFrame(handle)
}
