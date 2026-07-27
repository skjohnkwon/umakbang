/**
 * Runtime theme overrides for Umakbang's accent ("primary") and background colours.
 *
 * STORAGE FORMAT: colours cross this module's public API as 6-digit hex strings
 * ("#4fb3c8"). Hex is what a colour input round-trips losslessly and what a JSON
 * settings file stores without ceremony. Everything written to the DOM is emitted
 * as `oklch(L C H)` because that is what index.css uses, so a derived step lands
 * on the same perceptual scale as the hand-written tokens.
 *
 * All colour maths is local: sRGB -> linear sRGB -> OKLab -> OKLCH and back
 * (Björn Ottosson's matrices). No dependencies.
 */

export interface Rgb {
  /** 0..1, gamma-encoded sRGB. */
  r: number
  g: number
  b: number
}

export interface Oklch {
  /** Perceptual lightness, 0..1. */
  l: number
  /** Chroma, ~0..0.4 for displayable sRGB. */
  c: number
  /** Hue angle in degrees, 0..360. */
  h: number
}

export interface ThemeOverrides {
  /** Accent colour as hex. Drives --primary, --primary-foreground and --ring. */
  primary?: string
  /** App background as hex. Drives the whole surface ramp and its foregrounds. */
  background?: string
}

/** CSS custom properties touched by a primary override. */
export const PRIMARY_VARS = ['--primary', '--primary-foreground', '--ring'] as const

/** CSS custom properties touched by a background override. */
export const BACKGROUND_VARS = [
  '--background',
  '--foreground',
  '--card',
  '--popover',
  '--secondary',
  '--secondary-foreground',
  '--muted',
  '--muted-foreground',
  '--accent',
  '--accent-foreground',
  '--border',
  '--input'
] as const

/** Every property this module may write, for callers that need to audit or clear them. */
export const THEME_OVERRIDE_VARS = [...PRIMARY_VARS, ...BACKGROUND_VARS] as const

/* -------------------------------------------------------------------------- */
/* hex <-> rgb                                                                 */
/* -------------------------------------------------------------------------- */

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i

/** Returns a canonical "#rrggbb" string, or null when the input is not a hex colour. */
export function normalizeHex(input: string): string | null {
  const match = HEX_RE.exec(input.trim())
  if (!match) return null
  const body = match[1].toLowerCase()
  const full =
    body.length === 3
      ? body
          .split('')
          .map((ch) => ch + ch)
          .join('')
      : body
  return `#${full}`
}

export function hexToRgb(hex: string): Rgb | null {
  const normalized = normalizeHex(hex)
  if (!normalized) return null
  const int = Number.parseInt(normalized.slice(1), 16)
  return {
    r: ((int >> 16) & 0xff) / 255,
    g: ((int >> 8) & 0xff) / 255,
    b: (int & 0xff) / 255
  }
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const channel = (value: number): string =>
    Math.round(clamp(value, 0, 1) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${channel(r)}${channel(g)}${channel(b)}`
}

/* -------------------------------------------------------------------------- */
/* rgb <-> oklch                                                               */
/* -------------------------------------------------------------------------- */

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

function linearToSrgb(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055
}

export function rgbToOklch({ r, g, b }: Rgb): Oklch {
  const lr = srgbToLinear(r)
  const lg = srgbToLinear(g)
  const lb = srgbToLinear(b)

  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)

  const okL = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const okA = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const okB = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s

  const chroma = Math.hypot(okA, okB)
  // Hue is meaningless at zero chroma; 0 keeps the value stable instead of NaN.
  const hue = chroma < 1e-6 ? 0 : ((Math.atan2(okB, okA) * 180) / Math.PI + 360) % 360
  return { l: okL, c: chroma, h: hue }
}

function oklchToLinear({ l, c, h }: Oklch): [number, number, number] {
  const rad = (h * Math.PI) / 180
  const a = Math.cos(rad) * c
  const b = Math.sin(rad) * c

  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3

  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_
  ]
}

/**
 * OKLCH -> sRGB, reducing chroma until the colour fits the sRGB gamut. Naive
 * per-channel clamping shifts hue badly on saturated colours; walking chroma down
 * preserves hue and lightness, which is what the derived tokens depend on.
 */
export function oklchToRgb(color: Oklch): Rgb {
  const inGamut = (rgb: [number, number, number]): boolean =>
    rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4)

  let linear = oklchToLinear(color)
  if (!inGamut(linear)) {
    let lo = 0
    let hi = color.c
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2
      const candidate = oklchToLinear({ ...color, c: mid })
      if (inGamut(candidate)) lo = mid
      else hi = mid
    }
    linear = oklchToLinear({ ...color, c: lo })
  }

  return {
    r: clamp(linearToSrgb(linear[0]), 0, 1),
    g: clamp(linearToSrgb(linear[1]), 0, 1),
    b: clamp(linearToSrgb(linear[2]), 0, 1)
  }
}

export function hexToOklch(hex: string): Oklch | null {
  const rgb = hexToRgb(hex)
  return rgb ? rgbToOklch(rgb) : null
}

export function oklchToHex(color: Oklch): string {
  return rgbToHex(oklchToRgb(color))
}

/** Serialises to the same shape index.css uses: `oklch(0.175 0.008 260)`. */
export function formatOklch({ l, c, h }: Oklch): string {
  const round = (value: number, places: number): number =>
    Number.isFinite(value) ? Number(value.toFixed(places)) : 0
  return `oklch(${round(clamp(l, 0, 1), 4)} ${round(Math.max(c, 0), 4)} ${round(h, 2)})`
}

/* -------------------------------------------------------------------------- */
/* contrast                                                                    */
/* -------------------------------------------------------------------------- */

function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}

/** WCAG 2.x contrast ratio, 1..21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * Contrast targets reverse-engineered from the ratios the hand-tuned tokens in
 * index.css already hit, so an overridden theme keeps Umakbang's (high) legibility
 * rather than settling for bare WCAG AA.
 */
const TARGET = {
  foreground: 15,
  mutedForeground: 5.5,
  secondaryForeground: 11.5,
  accentForeground: 12,
  /** Unreachable for mid-lightness accents on purpose: the search then returns the
   *  extreme, which is exactly the near-white the light-mode default uses. */
  primaryForeground: 7
} as const

/**
 * The *softest* foreground that still clears `target` contrast against `base`.
 *
 * Picking pure white/black by a lightness threshold breaks on mid-lightness
 * colours (a 0.62-lightness teal genuinely needs dark text, a 0.62 blue does not),
 * so we test both directions and then binary-search back toward the base so the
 * result is not needlessly harsh. A trace of the base hue keeps text from looking
 * like a foreign grey dropped on a tinted surface.
 */
function contrastingForeground(base: Oklch, target: number, chromaScale: number): Oklch {
  const baseRgb = oklchToRgb(base)
  const chroma = Math.min(base.c * chromaScale, 0.05)
  const at = (l: number): number => contrastRatio(oklchToRgb({ l, c: chroma, h: base.h }), baseRgb)

  const lightExtreme = 0.995
  const darkExtreme = 0.12
  const extreme = at(lightExtreme) >= at(darkExtreme) ? lightExtreme : darkExtreme
  if (at(extreme) < target) return { l: extreme, c: chroma, h: base.h }

  // Contrast is monotonic as we move away from base.l, so bisect for the closest
  // lightness to the base that still meets the target.
  let ok = extreme
  let fail = base.l
  for (let i = 0; i < 20; i++) {
    const mid = (ok + fail) / 2
    if (at(mid) >= target) ok = mid
    else fail = mid
  }
  return { l: ok, c: chroma, h: base.h }
}

/** Convenience for UI that needs legible text/iconography on an arbitrary swatch. */
export function readableTextOn(hex: string): string {
  const base = hexToOklch(hex)
  if (!base) return 'oklch(0 0 0)'
  return formatOklch(contrastingForeground(base, 4.5, 0.2))
}

/* -------------------------------------------------------------------------- */
/* derivation                                                                  */
/* -------------------------------------------------------------------------- */

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

interface Step {
  /** Lightness offset from the base background. */
  dl: number
  /** Chroma multiplier applied to the base background's chroma. */
  cx: number
}

/**
 * Surface ramp, expressed as offsets from the chosen background. The numbers are
 * lifted from the deltas between the hand-tuned tokens in index.css, so a custom
 * background reproduces the same visual rhythm at any lightness.
 */
const DARK_STEPS: Record<string, Step> = {
  '--card': { dl: 0.03, cx: 1.1 },
  '--popover': { dl: 0.05, cx: 1.25 },
  '--secondary': { dl: 0.075, cx: 1.25 },
  '--muted': { dl: 0.065, cx: 1.25 },
  '--accent': { dl: 0.1, cx: 1.45 },
  '--border': { dl: 0.11, cx: 1.4 },
  '--input': { dl: 0.14, cx: 1.5 }
}

const LIGHT_STEPS: Record<string, Step> = {
  '--card': { dl: 0.015, cx: 0.4 },
  '--popover': { dl: 0.015, cx: 0.55 },
  '--secondary': { dl: -0.03, cx: 1.6 },
  '--muted': { dl: -0.03, cx: 1.6 },
  '--accent': { dl: -0.045, cx: 2.2 },
  '--border': { dl: -0.08, cx: 2.2 },
  '--input': { dl: -0.1, cx: 2.6 }
}

function stepFrom(base: Oklch, step: Step): Oklch {
  return {
    l: clamp(base.l + step.dl, 0.02, 1),
    // Cap the increase in absolute terms: a vivid background must not spawn
    // borders three times more saturated than itself.
    c: Math.max(0, Math.min(base.c * step.cx, base.c + 0.02)),
    h: base.h
  }
}

/* -------------------------------------------------------------------------- */
/* application                                                                 */
/* -------------------------------------------------------------------------- */

function setVar(root: HTMLElement, name: string, value: string): void {
  root.style.setProperty(name, value)
}

function clearVars(root: HTMLElement, names: readonly string[]): void {
  for (const name of names) root.style.removeProperty(name)
}

/**
 * Writes (or clears) the theme override custom properties as inline styles on the
 * root element. Inline styles beat both `:root` and `.dark`, so an override is
 * mode-independent - re-apply the per-mode value yourself when the light/dark
 * toggle flips, or pass `{}` to fall back to the stylesheet.
 *
 * A field that is absent (or holds an unparseable colour) clears only that field's
 * properties, so the two overrides can be driven independently.
 */
export function applyThemeOverrides(
  overrides: ThemeOverrides,
  root: HTMLElement = document.documentElement
): void {
  const primary = overrides.primary ? hexToOklch(overrides.primary) : null
  if (primary) {
    setVar(root, '--primary', formatOklch(primary))
    setVar(
      root,
      '--primary-foreground',
      formatOklch(contrastingForeground(primary, TARGET.primaryForeground, 0.25))
    )
    // The focus ring is the accent in both stylesheet modes; keep that promise.
    setVar(root, '--ring', formatOklch(primary))
  } else {
    clearVars(root, PRIMARY_VARS)
  }

  const background = overrides.background ? hexToOklch(overrides.background) : null
  if (background) {
    // Anything below mid-lightness behaves like a dark theme: surfaces step up.
    const steps = background.l < 0.55 ? DARK_STEPS : LIGHT_STEPS

    setVar(root, '--background', formatOklch(background))
    setVar(
      root,
      '--foreground',
      formatOklch(contrastingForeground(background, TARGET.foreground, 0.7))
    )
    setVar(
      root,
      '--muted-foreground',
      formatOklch(contrastingForeground(background, TARGET.mutedForeground, 1.6))
    )

    for (const [name, step] of Object.entries(steps)) {
      const token = stepFrom(background, step)
      setVar(root, name, formatOklch(token))
      // Foregrounds are measured against the surface they actually sit on, not
      // against the background, so tinted surfaces stay readable.
      if (name === '--secondary') {
        setVar(
          root,
          '--secondary-foreground',
          formatOklch(contrastingForeground(token, TARGET.secondaryForeground, 0.7))
        )
      } else if (name === '--accent') {
        setVar(
          root,
          '--accent-foreground',
          formatOklch(contrastingForeground(token, TARGET.accentForeground, 0.55))
        )
      }
    }
  } else {
    clearVars(root, BACKGROUND_VARS)
  }
}

/** Drops every inline override so index.css's `:root` / `.dark` tokens apply again. */
export function resetThemeOverrides(root: HTMLElement = document.documentElement): void {
  clearVars(root, THEME_OVERRIDE_VARS)
}
