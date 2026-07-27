import type { Transition, Variants } from 'motion/react'

/**
 * Shared motion presets.
 *
 * Everything here is short and small-amplitude - this is a working tool, and animation
 * that delays getting to a file is a cost, not a feature. Nothing animates the
 * virtualised file rows: they mount and unmount constantly while scrolling, and
 * animating them would undo the work that keeps a 300k-file list smooth.
 */

/** Fast out, gentle settle. */
export const EASE = [0.22, 1, 0.36, 1] as const

export const QUICK: Transition = { duration: 0.16, ease: EASE }
export const SETTLE: Transition = { duration: 0.24, ease: EASE }

/** Page-level swap between the browser and the stats view. */
export const pageVariants: Variants = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0, transition: SETTLE },
  exit: { opacity: 0, y: -4, transition: QUICK }
}

/** Container that reveals its children in sequence. */
export const staggerContainer: Variants = {
  initial: {},
  animate: { transition: { staggerChildren: 0.035, delayChildren: 0.02 } }
}

export const staggerItem: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: SETTLE }
}

/** Expanding a folder in the sidebar. */
export const collapseVariants: Variants = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1, transition: SETTLE },
  exit: { height: 0, opacity: 0, transition: QUICK }
}
