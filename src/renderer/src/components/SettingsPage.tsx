import type React from 'react'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  Download,
  FolderMinus,
  FolderPlus,
  Loader2,
  Package,
  Plus,
  RotateCcw,
  X
} from 'lucide-react'
import { DEFAULT_VISUALIZER_STOPS, type QuickMoveTarget, type Settings } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/tooltip'
import { Input } from '@/components/ui/input'
import { ColorPicker, ACCENT_PRESETS, SURFACE_PRESETS } from '@/components/ColorPicker'
import { Logo } from '@/components/Logo'
import { Clock } from 'lucide-react'
import { usePlayer } from '@/state/player'
import { useLibrary } from '@/state/library'
import {
  DEFAULT_DETAIL_FIELDS,
  DETAIL_FIELDS,
  formatDetails,
  normalizeDetailFields,
  type DetailField
} from '@/lib/player-details'
import type { Track } from '@shared/types'
import { useFolderTree } from '@/hooks/useLibraryView'
import { folderTags } from '@/lib/analysis-scope'
import { cancelReprocess, reprocessProgress, subscribeReprocess } from '@/lib/analysis'
import { checkForUpdates, useUpdateStatus } from '@/lib/updates'
import { baseName, isUnderAnyDir, relativePath, samePath } from '@/lib/paths'
import { cn } from '@/lib/utils'

/** Starting points for the pickers when nothing is overridden yet. */
const DEFAULTS = {
  accent: '#5ec9c9',
  surface: '#16181d',
  visualizerLow: '#3b82f6',
  visualizerHigh: '#ef4444'
}

/** Ready-made low → high pairs, since picking two that read well together is the hard bit. */
/**
 * Whole ramps rather than pairs.
 *
 * Picking colours that read well together is the hard part, and a gradient between two of
 * them spends most of its length in the muddy middle. These are the ones worth having.
 */
const GRADIENT_PRESETS: Array<{ name: string; stops: string[] }> = [
  { name: 'Heat', stops: [...DEFAULT_VISUALIZER_STOPS] },
  { name: 'Ice → Fire', stops: ['#3b82f6', '#22d3ee', '#facc15', '#f97316', '#ef4444'] },
  { name: 'Sunset', stops: ['#1e1b4b', '#7c3aed', '#f97316', '#fde68a'] },
  { name: 'Aurora', stops: ['#052e16', '#14b8a6', '#38bdf8', '#e0e7ff'] },
  { name: 'Ember', stops: ['#18181b', '#7f1d1d', '#f59e0b', '#fef3c7'] },
  { name: 'Teal → Magenta', stops: ['#14b8a6', '#a3e635', '#f472b6', '#ec4899'] },
  { name: 'Mono', stops: ['#334155', '#94a3b8', '#f8fafc'] }
]

/** More than this and each stop is too narrow a slice to tell from its neighbours. */
const MAX_STOPS = 8

/** The ramp as a CSS gradient, for the swatches and the preview. */
function gradientCss(stops: readonly string[]): string {
  return `linear-gradient(to right, ${stops.join(', ')})`
}

/** The sections down the left, in the order they appear. */
const SECTIONS = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'player', label: 'Player' },
  { id: 'library', label: 'Library' },
  { id: 'analysis', label: 'Analysis' },
  { id: 'stems', label: 'Stems' },
  { id: 'backup', label: 'Backup' },
  { id: 'window', label: 'Window' },
  { id: 'updates', label: 'Updates' }
] as const

/**
 * Settings as a page rather than a dialog.
 *
 * It outgrew a modal: a scrolling box with eight sections in it means hunting, and a
 * dialog can't be left open beside the thing it changes. As a page it gets a nav down the
 * side, and the live preview in Player can be watched while the switches move.
 */
export function SettingsPage(): React.JSX.Element {
  const settings = useLibrary((s) => s.settings)
  const patchSettings = useLibrary((s) => s.patchSettings)
  const exportBundle = useLibrary((s) => s.exportBundle)
  const bundleBusy = useLibrary((s) => s.bundleBusy)
  const beginImport = useLibrary((s) => s.beginImport)

  // Empty means the built-in ramp, which is what the visualizers draw, so the pickers
  // open on the colours actually on screen.
  const stops =
    settings.visualizerStops.length > 0
      ? settings.visualizerStops
      : [...DEFAULT_VISUALIZER_STOPS]

  const [active, setActive] = useState<string>('appearance')

  const show = (id: string): string => (active === id ? 'block' : 'hidden')

  // Back to whatever folder you were in, which is where the cog was pressed from.
  const setView = useLibrary((s) => s.setView)
  const lastFolderDir = useLibrary((s) => s.lastFolderDir)
  const closeSettings = useCallback(
    () => setView({ mode: 'folder', dir: lastFolderDir }),
    [setView, lastFolderDir]
  )

  // Escape is what everything else modal-shaped answers to, so it answers here too.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      const target = event.target as HTMLElement | null
      // Not while something is being typed into, or a popover is taking the key itself.
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return
      if (document.querySelector('[data-radix-popper-content-wrapper]')) return
      closeSettings()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeSettings])

  return (
    <div className="flex min-h-0 flex-1">
      {/* Section list. Narrow and quiet: it is a table of contents, not a second sidebar. */}
      <nav className="scroll-thin w-[168px] shrink-0 overflow-y-auto border-r bg-card/30 py-2">
        {/* The way out. Settings replaces the explorer rather than floating over it, so
            without this the only way back is to remember that "Files" in the sidebar is
            also the exit. */}
        <div className="flex items-center gap-1.5 px-3 pb-1">
          <Logo className="h-3 w-3 text-primary/80" />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            Settings
          </span>
          <Hint label="Close settings (Esc)" side="right">
            <button
              type="button"
              aria-label="Close settings"
              onClick={closeSettings}
              className="ml-auto flex h-4 w-4 items-center justify-center rounded-sm text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </Hint>
        </div>
        {SECTIONS.map((section) => (
          <button
            key={section.id}
            type="button"
            onClick={() => setActive(section.id)}
            className={cn(
              'flex w-full items-center px-3 py-1.5 text-left text-[12.5px] transition-colors',
              active === section.id
                ? 'bg-accent font-medium text-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
            )}
          >
            {section.label}
          </button>
        ))}
      </nav>

      <div className="scroll-thin min-w-0 flex-1 overflow-y-auto px-5 py-4">
        <div className={cn('mx-auto max-w-[560px] space-y-4', show('appearance'))}>
          <Section title="Theme">
            <Row label="Accent" hint="Buttons, selection, focus rings.">
              <div className="flex items-center gap-1.5">
                <ColorPicker
                  label="Accent colour"
                  value={settings.themePrimary ?? DEFAULTS.accent}
                  onChange={(colour) => patchSettings({ themePrimary: colour })}
                  onReset={() => patchSettings({ themePrimary: null })}
                />
                <ResetButton
                  shown={settings.themePrimary !== null}
                  onClick={() => patchSettings({ themePrimary: null })}
                />
              </div>
            </Row>

            <Row label="Background" hint="Surfaces derive from this.">
              <div className="flex items-center gap-1.5">
                <ColorPicker
                  label="Background colour"
                  presets={SURFACE_PRESETS}
                  value={settings.themeBackground ?? DEFAULTS.surface}
                  onChange={(colour) => patchSettings({ themeBackground: colour })}
                  onReset={() => patchSettings({ themeBackground: null })}
                />
                <ResetButton
                  shown={settings.themeBackground !== null}
                  onClick={() => patchSettings({ themeBackground: null })}
                />
              </div>
            </Row>
          </Section>

          <Section
            title="Visualizers"
            hint="The ramp everything is tinted with, quiet on the left, loud on the right."
          >
            <Row label="Gradient">
              <div className="flex flex-wrap items-center gap-1">
                {stops.map((colour, index) => (
                  <ColorPicker
                    key={index}
                    label={`Stop ${index + 1}`}
                    presets={ACCENT_PRESETS}
                    value={colour}
                    onChange={(next) =>
                      patchSettings({
                        visualizerStops: stops.map((stop, i) => (i === index ? next : stop))
                      })
                    }
                    // Two is the fewest a gradient can be made of.
                    onReset={
                      stops.length > 2
                        ? () =>
                            patchSettings({
                              visualizerStops: stops.filter((_, i) => i !== index)
                            })
                        : undefined
                    }
                  />
                ))}
                <Hint label="Add a colour" side="top">
                  <button
                    type="button"
                    aria-label="Add a gradient colour"
                    disabled={stops.length >= MAX_STOPS}
                    onClick={() =>
                      patchSettings({
                        // New stops land at the end, taking the colour that was already
                        // there, so adding one never changes what is on screen until it
                        // is actually given a colour.
                        visualizerStops: [...stops, stops[stops.length - 1]]
                      })
                    }
                    className="flex h-[22px] w-[22px] items-center justify-center rounded border border-border/80 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30"
                  >
                    <Plus className="h-3 w-3" />
                  </button>
                </Hint>
                <div
                  className="h-[14px] w-16 rounded-[3px] border border-border/80"
                  style={{ background: gradientCss(stops) }}
                />
                <ResetButton
                  shown={settings.visualizerStops.length > 0}
                  onClick={() => patchSettings({ visualizerStops: [] })}
                />
              </div>
            </Row>

            <p className="mt-1 text-[11px] text-muted-foreground/70">
              Right-click a colour to remove it.
            </p>

            <Row
              label="Waveform colour"
              hint="Spectrum tints each column by where its energy sits - bass low on the ramp, cymbals high."
            >
              <div className="flex items-center gap-1">
                {(['spectrum', 'accent'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => patchSettings({ waveformTint: mode })}
                    className={cn(
                      'rounded border px-2 py-0.5 text-[11.5px] capitalize transition-colors',
                      settings.waveformTint === mode
                        ? 'border-primary bg-primary/15 text-foreground'
                        : 'border-border/70 text-muted-foreground hover:bg-accent hover:text-foreground'
                    )}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </Row>

            <div className="mt-1.5 flex flex-wrap gap-1">
              {GRADIENT_PRESETS.map((preset) => (
                <button
                  key={preset.name}
                  type="button"
                  title={preset.name}
                  onClick={() => patchSettings({ visualizerStops: [...preset.stops] })}
                  className={cn(
                    'h-5 w-12 rounded border transition-transform hover:scale-105',
                    stops.join().toLowerCase() === preset.stops.join().toLowerCase()
                      ? 'border-primary'
                      : 'border-border/70'
                  )}
                  style={{ background: gradientCss(preset.stops) }}
                />
              ))}
            </div>
          </Section>

        </div>

        <div className={cn('mx-auto max-w-[560px] space-y-4', show('player'))}>
          <PlayerDetailSection />

          <Section title="Playback">
            <Row label="Auto-advance" hint="Continue to the next track when one ends.">
              <Switch
                checked={settings.autoAdvance}
                onChange={(autoAdvance) => patchSettings({ autoAdvance })}
              />
            </Row>
            <Row label="Play on select" hint="Clicking an audio file starts it playing.">
              <Switch
                checked={settings.playOnSelect}
                onChange={(playOnSelect) => patchSettings({ playOnSelect })}
              />
            </Row>
            <Row
              label="Play while arrowing"
              hint="Up and down play each file as you reach it."
            >
              <Switch
                checked={settings.auditionOnArrow}
                onChange={(auditionOnArrow) => patchSettings({ auditionOnArrow })}
              />
            </Row>
            <Row label="Queue from">
              <SegmentedControl
                value={settings.queueSource}
                options={[
                  { value: 'folder', label: 'Folder' },
                  { value: 'view', label: 'Current list' }
                ]}
                onChange={(queueSource) =>
                  patchSettings({ queueSource: queueSource as Settings['queueSource'] })
                }
              />
            </Row>
          </Section>

        </div>

        <div className={cn('mx-auto max-w-[560px] space-y-4', show('analysis'))}>
          <AnalysisSection
            tag={settings.analysisTag}
            onChange={(analysisTag) => patchSettings({ analysisTag })}
          />

        </div>

        <div className={cn('mx-auto max-w-[560px] space-y-4', show('library'))}>
          <RandomExcludeSection
            dirs={settings.randomExcludeDirs}
            onChange={(randomExcludeDirs) => patchSettings({ randomExcludeDirs })}
          />

          <QuickMoveSection
            targets={settings.quickMove}
            onChange={(quickMove) => patchSettings({ quickMove })}
          />

        </div>

        <div className={cn('mx-auto max-w-[560px] space-y-4', show('stems'))}>
          <StemSection />
        </div>

        <div className={cn('mx-auto max-w-[560px] space-y-4', show('backup'))}>
          <Section
            title="Backup"
            hint="Everything umakbang remembers, in one .umak file: preferences, tags, ratings and detected tempo, plus the file index, probe results and cached waveforms."
          >
            <div className="flex items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                disabled={bundleBusy}
                onClick={() => void exportBundle()}
                className="gap-1.5"
              >
                {bundleBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Package className="h-3.5 w-3.5" />
                )}
                Export…
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={bundleBusy}
                onClick={() => void beginImport()}
                className="gap-1.5"
              >
                <Download className="h-3.5 w-3.5" />
                Import…
              </Button>
            </div>
            <p className="text-[11px] leading-snug text-muted-foreground/60">
              A bundle opens indexed rather than spending a minute rebuilding what it already
              knows, so it is what a restore or a stick wants. Writing one takes a few
              seconds and leaves a <code className="rounded bg-secondary px-1 py-px">.part</code>{' '}
              file beside it until it is finished. Where the window sits stays with the
              machine. Importing asks where each folder lives here, opens the ones that were
              libraries, and brings the rest across; the index comes back only for folders
              still at the same path, and anything that moved is rebuilt by a scan. Older
              <code className="rounded bg-secondary px-1 py-px">.json</code> settings files
              still import.
            </p>
          </Section>
        </div>

        <div className={cn('mx-auto max-w-[560px] space-y-4', show('window'))}>
          <Section title="Window">
            <Row label="Pin on top" hint="Keep umakbang above other applications.">
              <Switch
                checked={settings.alwaysOnTop}
                onChange={(alwaysOnTop) => {
                  patchSettings({ alwaysOnTop })
                  void window.umakbang.setAlwaysOnTop(alwaysOnTop)
                }}
              />
            </Row>
            <Row label="Visualizers only" hint="Hide the library and fill the window.">
              <Switch
                checked={settings.visualizerOnly}
                onChange={(visualizerOnly) => patchSettings({ visualizerOnly })}
              />
            </Row>
          </Section>
        </div>

        <div className={cn('mx-auto max-w-[560px] space-y-4', show('updates'))}>
          <UpdateSection />
        </div>
      </div>
    </div>
  )
}

/**
 * Which version is running, and whether a newer one is waiting.
 *
 * The updater needs no settings: it checks on its own, downloads on its own, and installs
 * when you quit. What it does need is somewhere to be visible, because an update that
 * happens entirely silently leaves you unable to tell a working updater from a broken one
 * - which is also why `disabled` and `error` say why rather than showing nothing.
 *
 * The status comes from `lib/updates.ts` rather than the store, so a download reporting
 * progress several times a second repaints this row and nothing else.
 */
function UpdateSection(): React.JSX.Element {
  const status = useUpdateStatus()
  const [checking, setChecking] = useState(false)

  const detail = ((): string => {
    switch (status.state) {
      case 'checking':
        return 'Looking for a newer version…'
      case 'current':
        return 'This is the newest version.'
      case 'downloading':
        return status.percent === undefined
          ? `Downloading ${status.available ?? 'an update'}…`
          : `Downloading ${status.available ?? 'an update'} - ${status.percent}%`
      case 'ready':
        return `${status.available} is ready. It installs when you quit.`
      case 'error':
        return `Could not check: ${status.reason ?? 'unknown error'}`
      case 'disabled':
        return `Updates are off - ${status.reason ?? 'not available in this build'}.`
      default:
        return 'Checked automatically, twelve hours apart.'
    }
  })()

  return (
    <Section title="Updates" hint="Downloaded in the background and installed when you quit.">
      <Row label="Version" hint={detail}>
        <div className="flex items-center gap-1.5">
          <span className="tnum text-[12.5px] text-muted-foreground">
            {status.version || '—'}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={status.state === 'disabled' || checking || status.state === 'downloading'}
            onClick={() => {
              setChecking(true)
              void checkForUpdates().finally(() => setChecking(false))
            }}
            className="gap-1.5"
          >
            <RotateCcw className={cn('h-3.5 w-3.5', checking && 'animate-spin')} />
            Check now
          </Button>
        </div>
      </Row>
    </Section>
  )
}

/**
 * Which metadata the transport strip lists under the track name, with the real thing shown
 * above the switches.
 *
 * The preview is the same component the bar builds, fed either the playing track or a
 * stand-in, so what you see is what you will get rather than an approximation that drifts
 * the next time a field is added.
 */
function PlayerDetailSection(): React.JSX.Element {
  const saved = useLibrary((s) => s.settings.playerDetails)
  const patchSettings = useLibrary((s) => s.patchSettings)
  const current = usePlayer((s) => s.current)

  const chosen = useMemo(
    () => (saved.length > 0 ? normalizeDetailFields(saved) : [...DEFAULT_DETAIL_FIELDS]),
    [saved]
  )

  // A stand-in when nothing is playing, so the preview is never an empty box. Values are
  // deliberately ordinary - the point is the shape of the line, not the numbers.
  const sample: Track = current ?? {
    path: 'C:/Beats/2024/midnight drive.wav',
    rel: 'Beats/2024/midnight drive.wav',
    dir: 'C:/Beats/2024',
    relDir: 'Beats/2024',
    name: 'midnight drive.wav',
    ext: 'wav',
    size: 42_400_000,
    mtimeMs: Date.parse('2024-02-07T12:00:00Z'),
    kind: 'audio',
    playable: true,
    probed: true,
    duration: 204,
    sampleRate: 44100,
    bitDepth: 24,
    channels: 2,
    bpm: 128,
    musicalKey: 'F#m'
  }

  const toggle = (field: DetailField): void => {
    const next = chosen.includes(field)
      ? chosen.filter((entry) => entry !== field)
      : [...chosen, field]
    patchSettings({ playerDetails: next })
  }

  return (
    <Section
      title="Track details"
      hint="What the player lists under the name. Order follows the order you switch them on."
    >
      {/* The preview: the same markup the transport strip uses for its identity block. */}
      <div className="rounded-md border bg-card/50 p-2.5">
        <div className="truncate text-[12px] font-medium leading-tight">{sample.name}</div>
        <div className="mt-0.5 flex items-center gap-1.5">
          <span className="tnum truncate text-[10.5px] text-muted-foreground">
            {formatDetails(sample, chosen) || (chosen.includes('projectTime') ? '' : 'nothing selected')}
          </span>
          {chosen.includes('projectTime') && (
            <span className="tnum flex shrink-0 items-center gap-0.5 text-[10.5px] text-muted-foreground">
              <Clock className="h-2.5 w-2.5" />
              4.2 h
            </span>
          )}
        </div>
        <div className="mt-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/50">
          {current ? 'Preview - the track playing now' : 'Preview'}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        {DETAIL_FIELDS.map((field) => (
          <label
            key={field.id}
            className="flex cursor-pointer items-center justify-between gap-2 rounded px-1 py-0.5 hover:bg-accent/40"
          >
            <span className="min-w-0">
              <span className="block truncate text-[12px]">{field.label}</span>
              <span className="block truncate text-[10.5px] text-muted-foreground/60">
                {field.hint}
              </span>
            </span>
            <Switch checked={chosen.includes(field.id)} onChange={() => toggle(field.id)} />
          </label>
        ))}
      </div>

      <ResetButton shown={saved.length > 0} onClick={() => patchSettings({ playerDetails: [] })} />
    </Section>
  )
}

/**
 * Folders the dice never lands in.
 *
 * A library is mostly not beats: sample packs, one-shots and stem folders hold hundreds of
 * files for every finished thing, so unfiltered randomness lands on a kick sample almost
 * every time. Excluding a folder covers everything beneath it, which is what makes one
 * entry for the sample pack folder enough.
 */
/**
 * Which parts of the library get their tempo and key worked out from the audio.
 *
 * Analysis is a full decode per file. On a library that is mostly sample packs nearly all
 * of it is spent on one-shots, which have no tempo and no key worth the name - so the work
 * is pointed at the folders holding finished music by tagging them.
 */
function AnalysisSection({
  tag,
  onChange
}: {
  tag: string | null
  onChange: (tag: string | null) => void
}): React.JSX.Element {
  const tags = useLibrary((s) => s.tags)
  const roots = useLibrary((s) => s.roots)
  const detectKey = useLibrary((s) => s.settings.detectKeyFromAudio)
  const keyEngine = useLibrary((s) => s.settings.keyEngine)
  const keyProfile = useLibrary((s) => s.settings.keyProfile)
  const concurrency = useLibrary((s) => s.settings.analysisConcurrency)
  const patchSettings = useLibrary((s) => s.patchSettings)
  const { index } = useFolderTree()

  // Only tags that sit on a folder can gate anything; one only ever used on files would
  // select nothing at all, and offering it would just be a way to switch analysis off.
  const options = useMemo(
    () => folderTags(tags, (path) => {
      const rel = relativePath(roots, path)
      return rel !== null && index.has(rel)
    }),
    [tags, roots, index]
  )

  return (
    <Section
      title="Tempo and key analysis"
      hint="Tag a folder, then pick that tag here. Subfolders without tags of their own are included."
    >
      <Row
        label="Analyse"
        hint={
          tag
            ? `Only files under folders tagged “${tag}”.`
            : 'Everything - every file you browse gets decoded once.'
        }
      >
        <select
          value={tag ?? ''}
          onChange={(event) => onChange(event.target.value || null)}
          className="h-7 rounded-md border bg-background px-2 text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <option value="">Everything</option>
          {options.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </select>
      </Row>
      <Row
        label="Estimate key from audio"
        hint="Tempo is accurate; key is a guess and often wrong. Keys from tags and file names are unaffected."
      >
        <Switch
          checked={detectKey}
          onChange={(detectKeyFromAudio) => patchSettings({ detectKeyFromAudio })}
        />
      </Row>

      {detectKey && (
        <Row
          label="Key detector"
          hint="Essentia is the engine behind the web tools that do this well. Measured on this library it is not reliably better, but it is right on cases the built-in one splits. Switching re-analyses everything."
        >
          <SegmentedControl
            value={keyEngine}
            options={[
              { value: 'builtin', label: 'Built-in' },
              { value: 'essentia', label: 'Essentia' }
            ]}
            onChange={(value) => patchSettings({ keyEngine: value as 'builtin' | 'essentia' })}
          />
        </Row>
      )}

      {detectKey && keyEngine === 'essentia' && (
        <Row
          label="Key profile"
          hint="What the chroma is scored against. bgate and edma were derived from electronic music; the other two from classical listening tests."
        >
          <SegmentedControl
            value={keyProfile}
            options={[
              { value: 'edma', label: 'edma' },
              { value: 'bgate', label: 'bgate' },
              { value: 'temperley', label: 'temperley' },
              { value: 'krumhansl', label: 'krumhansl' }
            ]}
            onChange={(value) => patchSettings({ keyProfile: value as Settings['keyProfile'] })}
          />
        </Row>
      )}

      <ReprocessRow />

      <Row
        label="Files at once"
        hint="How many are analysed in parallel. More is faster; each one in flight holds a decoded file."
      >
        <SegmentedControl
          value={String(concurrency)}
          options={[
            { value: '1', label: '1' },
            { value: '2', label: '2' },
            { value: '4', label: '4' },
            { value: '6', label: '6' },
            { value: '10', label: '10' }
          ]}
          onChange={(value) => patchSettings({ analysisConcurrency: Number(value) })}
        />
      </Row>

      <KeyCommandRow />

      {options.length === 0 && (
        <p className="text-[11px] text-muted-foreground/60">
          No folder carries a tag yet. Right-click a folder and choose “Edit tags…” to give it
          one.
        </p>
      )}
    </Section>
  )
}

/**
 * Points umakbang at a better key detector than its own.
 *
 * The built-in one is a chroma correlation and it is right about a third of the time, so
 * anyone with something better should be able to use it. A command rather than support for
 * one particular product: the plugin that prompted this, Antares Auto-Key, publishes
 * nothing a host can read - it talks to Auto-Tune over its own private channel and draws
 * the answer in its own window. Anything with a command line works here instead.
 */
function KeyCommandRow(): React.JSX.Element {
  const saved = useLibrary((s) => s.settings.keyCommand)
  const patchSettings = useLibrary((s) => s.patchSettings)
  const current = usePlayer((s) => s.current)
  const [draft, setDraft] = useState(saved)
  const [result, setResult] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)

  const test = async (): Promise<void> => {
    if (!current) {
      setResult('Play something first - the test runs against the current track.')
      return
    }
    setTesting(true)
    setResult(null)
    const answer = await window.umakbang.externalKey(draft, current.path)
    setTesting(false)
    setResult(
      answer
        ? `${current.name} → ${answer.slice(0, 60)}`
        : 'No output - the command failed or printed nothing.'
    )
  }

  return (
    <div className="space-y-1.5">
      <div className="text-[12.5px]">External key detector</div>
      <p className="text-[11px] leading-snug text-muted-foreground/60">
        A command run once per file, with <code>{'{file}'}</code> replaced by its path. What
        it prints is read as the key. Leave empty to use the built-in detector.
      </p>
      <div className="flex items-center gap-1.5">
        <Input
          value={draft}
          spellCheck={false}
          placeholder={'mytool --key "{file}"'}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => draft !== saved && patchSettings({ keyCommand: draft })}
          className="h-7 flex-1 text-[12px]"
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={testing || !draft.trim()}
          onClick={() => void test()}
        >
          {testing ? 'Testing…' : 'Test'}
        </Button>
      </div>
      {result && <p className="truncate text-[11px] text-muted-foreground">{result}</p>}
    </div>
  )
}

/**
 * Stem separation through LALAL.AI.
 *
 * The only feature that sends audio off the machine and the only one that costs money, so
 * the settings say so plainly rather than presenting it as one more toggle.
 */
function StemSection(): React.JSX.Element {
  const settings = useLibrary((s) => s.settings)
  const patchSettings = useLibrary((s) => s.patchSettings)
  const [keyDraft, setKeyDraft] = useState(settings.lalalKey)
  const [minutes, setMinutes] = useState<number | null | undefined>(undefined)
  const [checking, setChecking] = useState(false)

  const check = async (): Promise<void> => {
    setChecking(true)
    setMinutes(await window.umakbang.stemMinutesLeft(keyDraft))
    setChecking(false)
  }

  return (
    <Section
      title="Stems"
      hint="Splits vocals from the instrumental using LALAL.AI. Files are uploaded to their service, and it bills by the audio minute."
    >
      <div className="space-y-1.5">
        <div className="text-[12.5px]">Licence key</div>
        <div className="flex items-center gap-1.5">
          <Input
            type="password"
            value={keyDraft}
            spellCheck={false}
            placeholder="from lalal.ai account settings"
            onChange={(event) => setKeyDraft(event.target.value)}
            onBlur={() => keyDraft !== settings.lalalKey && patchSettings({ lalalKey: keyDraft })}
            className="h-7 flex-1 text-[12px]"
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={checking || !keyDraft.trim()}
            onClick={() => void check()}
          >
            {checking ? 'Checking…' : 'Check'}
          </Button>
        </div>
        {minutes !== undefined && (
          <p className="text-[11px] text-muted-foreground">
            {minutes === null
              ? 'The service would not answer - check the key.'
              : `${minutes.toFixed(1)} minutes left on the account.`}
          </p>
        )}
        <p className="text-[11px] leading-snug text-muted-foreground/60">
          Kept out of settings exports, since an export is something people pass around.
        </p>
      </div>

      <Row label="Write stems to" hint={settings.stemOutputDir || 'Not set yet.'}>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void window.umakbang
              .pickDirectory('Where stems are written', settings.stemOutputDir || undefined)
              .then((dir) => dir && patchSettings({ stemOutputDir: dir }))
          }}
        >
          Choose…
        </Button>
      </Row>

      <Row label="Format" hint="What the stems come back as.">
        <SegmentedControl
          value={settings.stemFormat}
          options={[
            { value: 'wav', label: 'WAV' },
            { value: 'flac', label: 'FLAC' },
            { value: 'mp3', label: 'MP3' }
          ]}
          onChange={(stemFormat) => patchSettings({ stemFormat })}
        />
      </Row>

      <Row
        label="Model"
        hint="LALAL.AI retires these as it adds new ones; change it if a split is refused."
      >
        <select
          value={settings.stemSplitter}
          onChange={(event) => patchSettings({ stemSplitter: event.target.value })}
          className="h-7 rounded-md border bg-background px-2 text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {/* Newest first - LALAL.AI keeps adding models and the latest is normally the
              one worth using. The older ones stay listed because a model that suits a
              particular voice better is a real thing. */}
          {['lynx', 'lyra', 'phoenix', 'orion', 'perseus', 'andromeda'].map((name) => (
            <option key={name} value={name}>
              {name === 'lynx' ? 'lynx (latest)' : name}
            </option>
          ))}
        </select>
      </Row>
    </Section>
  )
}

function RandomExcludeSection({
  dirs,
  onChange
}: {
  dirs: string[]
  onChange: (dirs: string[]) => void
}): React.JSX.Element {
  const roots = useLibrary((s) => s.roots)
  const notify = useLibrary((s) => s.notify)

  const add = async (): Promise<void> => {
    if (roots.length === 0) {
      notify('Add a library folder first.', 'error')
      return
    }
    const picked = await window.umakbang.pickDirectory(
      'Exclude a folder from random beats',
      roots[0].path
    )
    if (!picked) return

    // Only folders inside the library mean anything here. Everywhere else is already
    // excluded by not being in the index at all.
    const rel = relativePath(roots, picked)
    if (rel === null) {
      notify('That folder is outside the library.', 'error')
      return
    }
    if (rel === '') {
      notify('That is a whole library folder, so excluding it would leave nothing to pick.', 'error')
      return
    }
    // Already covered, either exactly or by a parent that's on the list.
    if (isUnderAnyDir(rel, dirs)) return
    // Adding a parent makes the children it now covers redundant.
    onChange([...dirs.filter((dir) => !isUnderAnyDir(dir, [rel])), rel])
  }

  return (
    <Section
      title="Random beat"
      hint="Folders the random beat button skips, subfolders included."
    >
      {dirs.length === 0 && (
        <p className="text-[11.5px] text-muted-foreground/70">
          Nothing excluded, so every playable file in the library can come up. Add your
          sample packs to keep the dice on your own work.
        </p>
      )}

      {dirs.map((dir) => (
        <div key={dir} className="flex items-center gap-1.5">
          <span title={dir} className="min-w-0 flex-1 truncate text-[12px]">
            {dir}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            title="Stop excluding"
            aria-label={`Stop excluding ${dir}`}
            onClick={() => onChange(dirs.filter((entry) => entry !== dir))}
            className="shrink-0 text-muted-foreground hover:text-destructive"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}

      <div>
        <Button variant="outline" size="sm" onClick={() => void add()} className="gap-1.5">
          <FolderMinus className="h-3.5 w-3.5" />
          Exclude folder…
        </Button>
      </div>
    </Section>
  )
}

/**
 * The folders you keep coming back to: Quick access in the sidebar, and the "Move to"
 * destinations in the explorer's right-click menu. One list, because a folder you file
 * into is nearly always one you also want to open - see `lib/quick-access.ts`.
 *
 * Filing is the one thing you do over and over with a browser like this, and the
 * destinations are few and stable - a stems folder, a demos folder, somewhere for the
 * rejects. Naming them is worth it because their folder names rarely say enough on
 * their own, and two of them are often called the same thing.
 */
function QuickMoveSection({
  targets,
  onChange
}: {
  targets: QuickMoveTarget[]
  onChange: (targets: QuickMoveTarget[]) => void
}): React.JSX.Element {
  const add = async (): Promise<void> => {
    const path = await window.umakbang.pickDirectory('Add a quick access folder')
    if (!path) return
    // Adding the same folder twice would just make the menu longer.
    if (targets.some((target) => samePath(target.path, path))) return
    onChange([...targets, { label: baseName(path) || path, path }])
  }

  return (
    <Section
      title="Quick access"
      hint="Drawn in the sidebar, and listed under “Move to” in the right-click menu."
    >
      {targets.length === 0 && (
        <p className="text-[11.5px] text-muted-foreground/70">
          Nothing yet. Add the folders you file into most.
        </p>
      )}

      {targets.map((target, index) => (
        <div key={target.path} className="flex items-center gap-1.5">
          <input
            type="text"
            spellCheck={false}
            value={target.label}
            aria-label={`Name for ${target.path}`}
            onChange={(event) =>
              onChange(
                targets.map((entry, at) =>
                  at === index ? { ...entry, label: event.target.value } : entry
                )
              )
            }
            className="h-7 w-32 shrink-0 rounded-md border border-input bg-background px-2 text-[12px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <span
            title={target.path}
            className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground"
          >
            {target.path}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            title="Remove"
            aria-label={`Remove ${target.label}`}
            onClick={() => onChange(targets.filter((_, at) => at !== index))}
            className="shrink-0 text-muted-foreground hover:text-destructive"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}

      <div>
        <Button variant="outline" size="sm" onClick={() => void add()} className="gap-1.5">
          <FolderPlus className="h-3.5 w-3.5" />
          Add folder…
        </Button>
      </div>
    </Section>
  )
}

/* ------------------------------------------------------------------ pieces */

function Section({
  title,
  hint,
  children
}: {
  title: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="mb-4 last:mb-1">
      <h3 className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      {hint && <p className="mb-1 text-[11px] text-muted-foreground/60">{hint}</p>}
      <div className="mt-1.5 flex flex-col gap-2">{children}</div>
    </section>
  )
}

/**
 * Redoing every analysed file, for when the detector itself has changed.
 *
 * The run is the ordinary analysis queue in a lower-priority lane, so it costs nothing but
 * time and browsing stays responsive while it grinds. Progress comes straight from the
 * module rather than the store: nothing else needs to know, and routing thousands of
 * per-file updates through zustand would repaint the library for each one.
 */
function ReprocessRow(): React.JSX.Element {
  const reprocessCached = useLibrary((s) => s.reprocessCached)
  // A primitive snapshot: `reprocessProgress()` builds a fresh object each call, which
  // useSyncExternalStore would treat as a change every render.
  const snapshot = useSyncExternalStore(subscribeReprocess, () => {
    const progress = reprocessProgress()
    return `${progress.total}:${progress.finished}`
  })
  const [total, finished] = snapshot.split(':').map(Number)
  const running = total > 0

  return (
    <Row
      label="Reprocess analysed files"
      hint="Re-runs tempo and key for every file that has an analysed value, using the current detector. Tempos and keys read from tags or file names are left alone. Runs in the background."
    >
      {running ? (
        <div className="flex items-center gap-2">
          <div className="h-1 w-24 overflow-hidden rounded bg-secondary">
            <div
              className="h-full bg-primary transition-[width] duration-300"
              style={{ width: `${Math.round((finished / Math.max(1, total)) * 100)}%` }}
            />
          </div>
          <span className="tabular-nums text-[11px] text-muted-foreground">
            {finished.toLocaleString()} / {total.toLocaleString()}
          </span>
          <Button variant="ghost" size="sm" onClick={() => cancelReprocess()}>
            Stop
          </Button>
        </div>
      ) : (
        <Button variant="secondary" size="sm" onClick={() => reprocessCached()}>
          <RotateCcw className="h-3.5 w-3.5" />
          Reprocess all
        </Button>
      )}
    </Row>
  )
}

function Row({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[12.5px]">{label}</div>
        {hint && <div className="text-[11px] text-muted-foreground/60">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function ResetButton({
  shown,
  onClick
}: {
  shown: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={onClick}
      title="Reset to theme default"
      className={cn('text-muted-foreground', !shown && 'invisible')}
    >
      <RotateCcw className="h-3 w-3" />
    </Button>
  )
}

function SegmentedControl({
  value,
  options,
  onChange
}: {
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-px rounded-md border bg-muted/40 p-px">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded px-2 py-0.5 text-[11.5px] transition-colors',
            value === option.value
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function Switch({
  checked,
  onChange
}: {
  checked: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-[18px] w-[32px] shrink-0 rounded-full transition-colors',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        checked ? 'bg-primary' : 'bg-input'
      )}
    >
      {/* `left-0` is load-bearing: a button centres its content, so without it the knob's
          static position is the middle of the track and the translate carries it out past
          the right edge. */}
      <span
        className={cn(
          'absolute left-0 top-[2px] h-[14px] w-[14px] rounded-full bg-background transition-transform',
          checked ? 'translate-x-[16px]' : 'translate-x-[2px]'
        )}
      />
    </button>
  )
}
