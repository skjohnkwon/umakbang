import { useEffect } from 'react'
import { useLibrary } from '@/state/library'
import { applyThemeOverrides, hexToOklch, formatOklch } from '@/lib/theme'

/**
 * Keeps the runtime theme in sync with settings. Renders nothing.
 *
 * Overrides are written as inline custom properties on <html>, which beat both `:root`
 * and `.dark`.
 *
 * There was a loudness-reactive mode here that drove the tint from playback level. It was
 * removed: rewriting a theme variable several times a second invalidated the visualizers'
 * cached palette on the same cadence, which reset scroll history and made every panel
 * flash. A colour that changes constantly is not worth that.
 */
export function ThemeBridge(): null {
  const primary = useLibrary((s) => s.settings.themePrimary)
  const background = useLibrary((s) => s.settings.themeBackground)
  const visualizerStops = useLibrary((s) => s.settings.visualizerStops)

  useEffect(() => {
    applyThemeOverrides({
      ...(primary ? { primary } : {}),
      ...(background ? { background } : {})
    })
  }, [primary, background])

  // The whole ramp travels as one variable, quiet → loud, comma separated. One property
  // rather than one per stop because the number of stops is the user's business, and the
  // palette's MutationObserver only has to watch the one name.
  useEffect(() => {
    const root = document.documentElement
    if (visualizerStops.length === 0) {
      root.style.removeProperty('--visualizer-stops')
      return
    }
    const stops = visualizerStops.map((hex) => {
      const oklch = hexToOklch(hex)
      return oklch ? formatOklch(oklch) : hex
    })
    root.style.setProperty('--visualizer-stops', stops.join(', '))
  }, [visualizerStops])

  return null
}
