import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  ChevronRight,
  Download,
  FolderMinus,
  FolderOutput,
  FolderPlus,
  Loader2,
  Package,
  Plus,
  RefreshCw,
  Star,
  RotateCcw,
  X
} from 'lucide-react'
import {
  DEFAULT_VISUALIZER_STOPS,
  STEM_SPLITTERS,
  type QuickMoveTarget,
  type Settings,
  type YoutubeToolStatus
} from '@shared/types'
import { CHANGELOG } from '@shared/changelog'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/tooltip'
import { Input } from '@/components/ui/input'
import { ColorPicker, ACCENT_PRESETS, SURFACE_PRESETS } from '@/components/ColorPicker'
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
import type {
  RemoteDevice,
  RemoteServerState,
  RemoteStats,
  TailnetStatus,
  Track
} from '@shared/types'
import { useFolderTree } from '@/hooks/useLibraryView'
import { folderTags } from '@/lib/analysis-scope'
import { cancelReprocess, reprocessProgress, subscribeReprocess } from '@/lib/analysis'
import { useAudioOutput } from '@/lib/audio-output'
import {
  SHORTCUT_ACTIONS,
  normaliseKeyName,
  shortcutConflict,
  shortcutKey,
  shortcutLabel,
  type ShortcutId
} from '@shared/shortcuts'
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
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'library', label: 'Library' },
  { id: 'analysis', label: 'Analysis' },
  { id: 'stems', label: 'Stems' },
  // Named for the feature as the sidebar names it, not "Downloads": that row is the OS folder
  // of that name, a place you file things out of rather than a thing you do.
  { id: 'downloads', label: 'YT2MP3' },
  { id: 'remote', label: 'Remote' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'backup', label: 'Backup' },
  { id: 'window', label: 'Window' },
  { id: 'updates', label: 'Updates' },
  { id: 'developer', label: 'Developer' }
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

  const noLibrary = useLibrary((s) => s.roots.length === 0)

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
                    // The count is in the key because removing a middle stop re-numbers
                    // everything to its right: keyed by index alone, React reused the
                    // picker instances - open popover, draft hex and all - for what are
                    // now different colours. The colour itself stays out of the key so a
                    // live edit doesn't remount the picker under the pointer.
                    key={`${stops.length}-${index}`}
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
              label="Headroom"
              hint="Space above the normal 0dB point in both the level and spectrum visualizers."
            >
              <div className="flex w-full items-center gap-2">
                <input
                  type="range"
                  min={0}
                  max={18}
                  step={1}
                  value={settings.visualizerHeadroomDb}
                  onChange={(event) =>
                    patchSettings({ visualizerHeadroomDb: Number(event.target.value) })
                  }
                  className="h-1 min-w-0 flex-1 accent-primary"
                />
                <span className="w-10 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                  {settings.visualizerHeadroomDb} dB
                </span>
                <ResetButton
                  shown={settings.visualizerHeadroomDb !== 6}
                  onClick={() => patchSettings({ visualizerHeadroomDb: 6 })}
                />
              </div>
            </Row>

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

          <OutputSection />

        </div>

        <div className={cn('mx-auto max-w-[560px] space-y-4', show('analysis'))}>
          <AnalysisSection
            tag={settings.analysisTag}
            onChange={(analysisTag) => patchSettings({ analysisTag })}
          />

        </div>

        <div className={cn('mx-auto max-w-[560px] space-y-4', show('shortcuts'))}>
          <ShortcutsSection />
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

          <UndoSection />

        </div>

        <div className={cn('mx-auto max-w-[560px] space-y-4', show('stems'))}>
          <StemSection />
        </div>

        <div className={cn('mx-auto max-w-[560px] space-y-4', show('downloads'))}>
          <DownloadSection />
        </div>

        <div className={cn('mx-auto max-w-[560px] space-y-4', show('backup'))}>
          <Section
            title="Backup"
            hint="Everything umakbang remembers, in one .umak file: preferences, tags, ratings and detected tempo, plus the file index, probe results and cached waveforms."
          >
            <Row label="Write bundles to" hint={settings.bundleExportDir || 'Not set yet.'}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  void window.umakbang
                    .pickDirectory('Where bundles are written', settings.bundleExportDir || undefined)
                    .then((dir) => dir && patchSettings({ bundleExportDir: dir }))
                }}
              >
                Choose…
              </Button>
            </Row>

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
                Export
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={bundleBusy}
                onClick={() => void exportBundle(true)}
                className="gap-1.5"
              >
                <FolderOutput className="h-3.5 w-3.5" />
                Export to…
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
              machine. <strong className="font-medium text-muted-foreground/80">
                One is written on its own once a day
              </strong>{' '}
              into the same folder, as{' '}
              <code className="rounded bg-secondary px-1 py-px">umakbang-auto.umak</code>,
              replacing the day before's. Importing asks where each folder lives here, opens
              the ones that were libraries, and brings the rest across; the index comes back
              only for folders still at the same path, and anything that moved is rebuilt by a
              scan. Older <code className="rounded bg-secondary px-1 py-px">.json</code>{' '}
              settings files still import.
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
            {/* Off the table until there is a library, like the title bar's own toggle. The
                cog is reachable from the welcome screen, so without this the mode was still
                one click away on the one screen that cannot draw it or get back out of it. */}
            <Row
              label="Visualizers only"
              hint={
                noLibrary
                  ? 'Open a folder first - there is nothing to visualize yet.'
                  : 'Hide the library and fill the window.'
              }
            >
              <Switch
                checked={settings.visualizerOnly}
                disabled={noLibrary}
                onChange={(visualizerOnly) => patchSettings({ visualizerOnly })}
              />
            </Row>
          </Section>
        </div>

        <div className={cn('mx-auto max-w-[560px] space-y-4', show('remote'))}>
          <RemoteSection />
        </div>

        <div className={cn('mx-auto max-w-[560px] space-y-4', show('plugins'))}>
          <PluginsSection />
        </div>

        <div className={cn('mx-auto max-w-[560px] space-y-4', show('updates'))}>
          <UpdateSection />
        </div>

        <div className={cn('mx-auto max-w-[560px] space-y-4', show('developer'))}>
          <DeveloperSection />
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

      <ChangelogList running={status.version} />
    </Section>
  )
}

/**
 * The switches that are for working on umakbang rather than for using it.
 *
 * The section is always in the nav and its contents are not: what sits behind the gate
 * throws this machine's settings, tags and ratings away on the next launch, and an option
 * that destructive should be one somebody deliberately turned on and can see is on. A hidden
 * key sequence would hide it from the person who set it as well.
 *
 * The tour replay is outside the gate, since wanting the introduction again is an ordinary
 * thing to want and nothing about it is dangerous.
 */
/**
 * The other machines, and what this one gives them.
 *
 * Separate from Library because it is not about this library at all: it is about which
 * machines can see it and where things land when they come back the other way. The tailnet
 * diagnostics stay under Developer for now - this is the part somebody actually sets.
 */
function RemoteSection(): React.JSX.Element {
  const settings = useLibrary((s) => s.settings)
  const patchSettings = useLibrary((s) => s.patchSettings)
  const roots = useLibrary((s) => s.roots)
  const [server, setServer] = useState<RemoteServerState | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncNote, setSyncNote] = useState<string | null>(null)

  useEffect(() => {
    void window.umakbang.remoteServerState().then(setServer)
  }, [settings.shareLibrary])

  const mounted = roots.filter((root) => root.remote)

  return (
    <>
      <Section
        title="Sharing"
        hint="Other machines on your tailnet, and nothing else, can read this library."
      >
        <Row
          label="Share this library"
          hint={
            !settings.shareLibrary
              ? 'Off. No other machine can reach this one.'
              : server?.listening
                ? `Answering on ${server.address}. Read-only: nothing reachable this way can change a file.`
                : (server?.reason ?? 'Starting…')
          }
        >
          <Switch
            checked={settings.shareLibrary}
            onChange={(shareLibrary) => {
              patchSettings({ shareLibrary })
              // The server is started and stopped by the main process, which reads this
              // setting - so it has to be told, rather than finding out on the next launch.
              void window.umakbang.remoteRestartServer().then(setServer)
            }}
          />
        </Row>
      </Section>

      <Section
        title="Copying here"
        hint="A library on another machine is read-only, so bringing a file over is always a copy - nothing leaves the machine that owns it."
      >
        <Row label="Copy files to" hint={settings.remoteDownloadDir || 'Not set yet.'}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void window.umakbang
                .pickDirectory(
                  'Where files copied from other machines land',
                  settings.remoteDownloadDir || undefined
                )
                .then((dir) => dir && patchSettings({ remoteDownloadDir: dir }))
            }}
          >
            Choose…
          </Button>
        </Row>
      </Section>

      <Section
        title="Settings"
        hint="Whichever machine's settings were changed most recently win, and this happens on every launch as well."
      >
        <Row
          label="Take the newest settings"
          hint={
            syncNote ??
            'Asks every machine that is serving, and adopts the one changed most recently. Nothing is sent: a machine that is behind catches up on its own next launch.'
          }
        >
          <Button
            variant="secondary"
            size="sm"
            disabled={syncing}
            onClick={() => {
              setSyncing(true)
              void window.umakbang
                .syncSettings()
                .then((result) =>
                  setSyncNote(
                    result.adopted ? `Took settings from ${result.adopted}.` : (result.reason ?? '')
                  )
                )
                .finally(() => setSyncing(false))
            }}
          >
            {syncing ? 'Checking…' : 'Sync now'}
          </Button>
        </Row>
      </Section>

      <Section title="Libraries from other machines">
        {mounted.length === 0 ? (
          <p className="text-[11px] text-muted-foreground/60">
            None yet. Settings → Developer → Tailnet lists the machines that are serving one.
          </p>
        ) : (
          mounted.map((root) => (
            <Row
              key={root.path}
              label={root.label}
              hint={`${root.remote?.deviceName} · ${root.path}`}
            >
              <span className="text-[11px] text-muted-foreground/60">Read-only</span>
            </Row>
          ))
        )}
      </Section>
    </>
  )
}

type Inventory = { names: string[]; from: string; missing?: boolean }

/** What one machine has that the other does not, both ways. */
function diff(mine: string[], theirs: string[]): { missingHere: string[]; missingThere: string[] } {
  // Punctuation and case taken out: FL writes a plugin's name as its installer spelled it,
  // and two machines can disagree about a space without disagreeing about the plugin.
  const flatten = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '')
  const here = new Set(mine.map(flatten))
  const there = new Set(theirs.map(flatten))
  return {
    missingHere: theirs.filter((name) => !here.has(flatten(name))),
    missingThere: mine.filter((name) => !there.has(flatten(name)))
  }
}

function PluginList({ title, names }: { title: string; names: string[] }): React.JSX.Element {
  return (
    <div className="mt-1.5">
      <p className="text-[11px] font-medium text-foreground/80">
        {title} <span className="text-muted-foreground/60">({names.length})</span>
      </p>
      <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
        {names.join(', ')}
      </p>
    </div>
  )
}

/**
 * Which plugins each machine has, and what that costs.
 *
 * Read from FL's own `Plugin database` rather than from what is installed on disk: what
 * decides whether a project opens is what *FL* has found, which is the stricter question and
 * the one a scan answers. Each machine reports its own - a plugin list is a fact about an
 * install, and nothing here could infer one across a socket.
 *
 * Both directions are shown. "Missing here" is what stops a project of theirs opening on
 * this machine, which is the question that gets asked; "missing there" is the same sentence
 * the other way round, and is what stops something made here going back.
 */
type FlPlugin = Awaited<ReturnType<typeof window.umakbang.flCatalog>>['plugins'][number]

/**
 * FL's plugin database, as a list you can act on rather than a menu you walk through.
 *
 * Favouriting is what puts a plugin in the picker you get from a channel, and FL offers it
 * one plugin at a time - fine for the one you just installed, miserable for the forty you
 * have had for a year. Everything here is a checkbox and a button, because underneath it is
 * a file being copied.
 *
 * Nothing is destroyed. A favourite removed can be added again from the scan, and a plugin
 * taken out of the scan is moved aside rather than deleted - see `fl-plugins.ts`.
 */
function FlPluginManager(): React.JSX.Element {
  const [catalog, setCatalog] = useState<FlPlugin[] | null>(null)
  const [from, setFrom] = useState<string>('')
  const [missing, setMissing] = useState(false)
  const [query, setQuery] = useState('')
  const [only, setOnly] = useState<'all' | 'favourites' | 'others'>('all')
  /** Formats to keep. Empty means all of them, which is what opening the page should show. */
  const [formats, setFormats] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  /** Where the last click landed, so shift can mean "everything between". */
  const anchor = useRef<number | null>(null)

  const load = useCallback(async () => {
    const result = await window.umakbang.flCatalog()
    setCatalog(result.plugins)
    setFrom(result.from)
    setMissing(Boolean(result.missing))
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (catalog ?? []).filter((plugin) => {
      if (only === 'favourites' && !plugin.favourite) return false
      if (only === 'others' && plugin.favourite) return false
      if (formats.size > 0 && !formats.has(plugin.format)) return false
      return !needle || plugin.name.toLowerCase().includes(needle)
    })
  }, [catalog, query, only, formats])

  /**
   * The formats actually present, with counts, commonest first.
   *
   * Read off the catalogue rather than listed here: FL files a plugin under the folder it
   * found it in, and which of those exist depends on the machine - there is no AudioUnit on
   * Windows, and `New` only appears once FL has scanned something it had not seen before.
   */
  const formatCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const plugin of catalog ?? []) {
      counts.set(plugin.format, (counts.get(plugin.format) ?? 0) + 1)
    }
    return [...counts].sort((a, b) => b[1] - a[1])
  }, [catalog])

  const favourites = (catalog ?? []).filter((plugin) => plugin.favourite).length
  /** What the buttons act on: the selection, or everything the search left if there is none. */
  const acting = useMemo(
    () => (selected.size > 0 ? shown.filter((plugin) => selected.has(plugin.name)) : shown),
    [shown, selected]
  )

  /**
   * Picks a row, or a run of them.
   *
   * Shift takes everything between this row and the last one touched, against the list as
   * it is filtered rather than the catalogue - a range somebody drew on screen should mean
   * what it looked like, not what it would have meant unfiltered.
   */
  const pick = useCallback(
    (index: number, extend: boolean) => {
      setSelected((current) => {
        const next = new Set(current)
        const from = extend && anchor.current !== null ? anchor.current : index
        const [lo, hi] = from <= index ? [from, index] : [index, from]
        const run = shown.slice(lo, hi + 1).map((plugin) => plugin.name)
        // A range takes its lead from the row that started it: if that row was being turned
        // on, the whole run goes on.
        const turningOn = !current.has(shown[from]?.name ?? '')
        for (const name of run) {
          if (turningOn) next.add(name)
          else next.delete(name)
        }
        return next
      })
      anchor.current = index
    },
    [shown]
  )

  const apply = useCallback(
    async (names: string[], wanted: boolean) => {
      if (names.length === 0) return
      setBusy(true)
      try {
        const result = await window.umakbang.flSetFavourites(names, wanted)
        setNote(
          result.failures.length > 0
            ? result.failures[0]
            : `${wanted ? 'Added' : 'Removed'} ${result.changed}.`
        )
        await load()
        // The rows it named have changed side, and a selection that survives that is a
        // selection about a list that no longer exists.
        setSelected(new Set())
      } finally {
        setBusy(false)
      }
    },
    [load]
  )

  if (missing) {
    return (
      <Section title="FL plugins">
        <p className="text-[11px] text-muted-foreground/70">
          Nothing at {from}. Point the folder above at FL&apos;s plugin database first.
        </p>
      </Section>
    )
  }

  return (
    <Section
      title="FL plugins"
      hint="A favourite is what appears when you add a plugin to a channel. FL adds them one at a time; this does not."
    >
      <div className="flex items-center gap-1.5">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`Search ${catalog?.length ?? 0} plugins`}
          className="h-7 text-[12px]"
        />
        {/* Narrowing to what is *not* yet a favourite is the common case - it is the list
            somebody is actually working through. */}
        {(['all', 'others', 'favourites'] as const).map((value) => (
          <Button
            key={value}
            variant={only === value ? 'default' : 'secondary'}
            size="sm"
            onClick={() => setOnly(value)}
          >
            {value === 'all' ? 'All' : value === 'others' ? 'Not yet' : 'Favourites'}
          </Button>
        ))}
      </div>

      {formatCounts.length > 1 && (
        <div className="flex flex-wrap items-center gap-1">
          {formatCounts.map(([format, count]) => {
            const on = formats.has(format)
            return (
              <button
                key={format}
                type="button"
                onClick={() =>
                  setFormats((current) => {
                    const next = new Set(current)
                    // Off again when it was the only one on, rather than leaving a filter
                    // nobody can clear without knowing which chip to press.
                    if (next.has(format)) next.delete(format)
                    else next.add(format)
                    return next
                  })
                }
                className={cn(
                  'rounded border px-1.5 py-px text-[10.5px]',
                  on
                    ? 'border-primary/30 bg-primary/15 text-primary'
                    : 'border-border/60 text-muted-foreground hover:bg-secondary/60'
                )}
              >
                {format}
                <span className="tnum pl-1 text-muted-foreground/50">{count}</span>
              </button>
            )
          })}
          {formats.size > 0 && (
            <button
              type="button"
              onClick={() => setFormats(new Set())}
              className="px-1 text-[10.5px] text-muted-foreground/60 hover:text-foreground"
            >
              clear
            </button>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>
          {selected.size > 0
            ? `${selected.size.toLocaleString()} selected`
            : `${shown.length.toLocaleString()} shown · ${favourites.toLocaleString()} favourites`}
        </span>
        {/* Selecting nothing means "everything I can see", which is what the search was
            for. Selecting something means that, and the buttons say which. */}
        <Button
          variant="ghost"
          size="sm"
          disabled={shown.length === 0}
          onClick={() =>
            setSelected((current) =>
              current.size > 0 ? new Set() : new Set(shown.map((plugin) => plugin.name))
            )
          }
        >
          {selected.size > 0 ? 'Clear' : 'Select all'}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="ml-auto"
          disabled={busy || acting.every((plugin) => plugin.favourite)}
          onClick={() => void apply(acting.filter((p) => !p.favourite).map((p) => p.name), true)}
        >
          Favourite{selected.size > 0 ? ` ${selected.size}` : ' these'}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy || acting.every((plugin) => !plugin.favourite)}
          onClick={() => void apply(acting.filter((p) => p.favourite).map((p) => p.name), false)}
        >
          Unfavourite{selected.size > 0 ? ` ${selected.size}` : ' these'}
        </Button>
      </div>

      {note && <p className="text-[11px] text-muted-foreground/70">{note}</p>}

      {/* Every match, drawn. Not virtualised like the file list is: that one draws three
          hundred thousand rows and this draws a thousand at the very most. Capping it was
          worse than useless - "select all" and a shift-range both read the filtered list,
          so they acted on rows nobody could see. */}
      <div className="scroll-thin max-h-[320px] overflow-y-auto rounded-md border bg-card/40">
        {shown.length === 0 ? (
          <p className="px-2.5 py-2 text-[11px] text-muted-foreground/60">Nothing matches.</p>
        ) : (
          shown.map((plugin, index) => {
            const picked = selected.has(plugin.name)
            return (
              <div
                key={`${plugin.kind}-${plugin.name}`}
                // The row selects. Shift extends from the last one touched.
                onClick={(event) => pick(index, event.shiftKey)}
                className={cn(
                  'flex w-full cursor-default items-center gap-2 px-2.5 py-1 text-[11.5px] select-none',
                  picked ? 'bg-primary/15' : 'hover:bg-secondary/60'
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'h-3 w-3 shrink-0 rounded-[3px] border',
                    picked ? 'border-primary bg-primary' : 'border-muted-foreground/40'
                  )}
                />
                {/* The star acts on that one plugin there and then, which is what a star
                    looks like it does - so it must not also be selecting. */}
                <button
                  type="button"
                  disabled={busy}
                  aria-label={plugin.favourite ? `Unfavourite ${plugin.name}` : `Favourite ${plugin.name}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    void apply([plugin.name], !plugin.favourite)
                  }}
                  className="shrink-0"
                >
                  <Star
                    className={cn(
                      'h-3.5 w-3.5',
                      plugin.favourite ? 'fill-primary text-primary' : 'text-muted-foreground/40'
                    )}
                  />
                </button>
                <span className="truncate">{plugin.name}</span>
                <span className="ml-auto shrink-0 text-[10.5px] text-muted-foreground/50">
                  {plugin.format}
                </span>
              </div>
            )
          })
        )}
      </div>

    </Section>
  )
}

function PluginsSection(): React.JSX.Element {
  const settings = useLibrary((s) => s.settings)
  const patchSettings = useLibrary((s) => s.patchSettings)
  const [mine, setMine] = useState<Inventory | null>(null)
  const [devices, setDevices] = useState<RemoteDevice[]>([])
  const [compared, setCompared] = useState<Record<string, Inventory | 'loading' | 'failed'>>({})

  const load = useCallback(async () => {
    const [local, listed] = await Promise.all([
      window.umakbang.localPlugins(),
      window.umakbang.remoteDevices()
    ])
    setMine(local)
    setDevices(listed.devices.filter((device) => device.serving))
  }, [])

  useEffect(() => {
    void load()
  }, [load, settings.flUserData])

  const compare = useCallback(async (device: RemoteDevice) => {
    const host = device.node.ipv4 ?? device.node.name
    if (!host) return
    setCompared((prev) => ({ ...prev, [device.node.id]: 'loading' }))
    const theirs = await window.umakbang.remotePluginList(host)
    setCompared((prev) => ({ ...prev, [device.node.id]: theirs ?? 'failed' }))
  }, [])

  return (
    <>
      <Section
        title="This machine"
        hint="Read from FL Studio's own plugin database - what FL has found, which is what decides whether a project opens."
      >
        <Row
          label="Plugin database folder"
          hint={
            mine === null
              ? 'Looking…'
              : mine.missing
                ? `Nothing at ${mine.from}. FL writes that folder when it scans for plugins - so either it has not, or this is pointing somewhere else. The FL Studio user data folder works too; it is found inside.`
                : `${mine.names.length} plugins, read from ${mine.from}`
          }
        >
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void window.umakbang
                .pickDirectory(
                  "FL Studio's plugin database, or the user data folder holding it",
                  settings.flUserData || undefined
                )
                .then((dir) => dir && patchSettings({ flUserData: dir }))
            }}
          >
            Choose…
          </Button>
        </Row>
      </Section>

      <FlPluginManager />

      <Section
        title="Other machines"
        hint="Each reports its own. A machine has to be running umakbang and sharing for it to answer."
      >
        {devices.length === 0 ? (
          <p className="text-[11px] text-muted-foreground/60">
            Nothing is serving right now. Settings → Developer → Tailnet lists what it can see.
          </p>
        ) : (
          devices.map((device) => {
            const state = compared[device.node.id]
            const theirs = state && state !== 'loading' && state !== 'failed' ? state : null
            const both = theirs && mine ? diff(mine.names, theirs.names) : null
            return (
              <div
                key={device.node.id}
                className="rounded-md border bg-card/40 px-2.5 py-2 text-[11.5px]"
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium">
                    {device.node.hostName || device.node.name}
                  </span>
                  <span className="text-[10.5px] text-muted-foreground/60">{device.node.os}</span>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="ml-auto"
                    disabled={state === 'loading' || mine === null}
                    onClick={() => void compare(device)}
                  >
                    {state === 'loading' ? 'Comparing…' : 'Compare'}
                  </Button>
                </div>

                {state === 'failed' && (
                  <p className="mt-1 text-[11px] text-muted-foreground/70">
                    It would not answer. That machine is probably on an older umakbang.
                  </p>
                )}

                {theirs?.missing && (
                  <p className="mt-1 text-[11px] text-muted-foreground/70">
                    No plugin database there either - FL has not scanned on that machine, or its
                    user data folder is set wrong in its own settings.
                  </p>
                )}

                {theirs && !theirs.missing && both && (
                  <>
                    <p className="mt-1 text-[11px] text-muted-foreground/60">
                      {theirs.names.length} plugins there · {mine?.names.length ?? 0} here
                    </p>
                    {both.missingHere.length === 0 && both.missingThere.length === 0 ? (
                      <p className="mt-1.5 text-[11px] text-primary">
                        The same on both. Anything made on either machine opens on the other.
                      </p>
                    ) : (
                      <>
                        {both.missingHere.length > 0 && (
                          <PluginList
                            title="Not here - their projects will open stubbed"
                            names={both.missingHere}
                          />
                        )}
                        {both.missingThere.length > 0 && (
                          <PluginList
                            title="Not there - projects made here will open stubbed"
                            names={both.missingThere}
                          />
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
            )
          })
        )}
      </Section>
    </>
  )
}

/** Bytes, at the precision a monitor wants: enough to see a transfer, never a long number. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatUptime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

/**
 * What the server has been asked for, as it is asked.
 *
 * Polled rather than pushed all the way to the renderer: the counters are already cached in
 * the browser process, so a read is a property access, and a panel nobody has open should
 * not be costing anything at all - which is why the interval only runs while this is
 * mounted.
 *
 * Refusals are given their own count and drawn in place. They are almost all the containment
 * check doing its job, and a number that quietly climbs while nothing is being transferred
 * is the one thing here worth noticing.
 */
function ServerMonitor({ peers }: { peers: RemoteDevice[] }): React.JSX.Element | null {
  const [stats, setStats] = useState<RemoteStats | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let cancelled = false
    const tick = async (): Promise<void> => {
      const next = await window.umakbang.remoteStats()
      if (!cancelled) {
        setStats(next)
        setNow(Date.now())
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), 2000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  /** Tailnet addresses back to machine names, so a log line says who rather than which IP. */
  const names = useMemo(() => {
    const map = new Map<string, string>()
    for (const peer of peers) {
      if (peer.node.ipv4) map.set(peer.node.ipv4, peer.node.hostName || peer.node.name)
    }
    return map
  }, [peers])

  if (!stats) return null

  return (
    <div className="rounded-md border bg-card/40 px-2.5 py-2">
      <div className="tnum flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span>up {formatUptime(now - stats.startedAt)}</span>
        <span>{stats.requests.toLocaleString()} requests</span>
        <span>{formatBytes(stats.bytesOut)} out</span>
        {stats.refused > 0 && (
          <span className="text-kind-project">{stats.refused} refused</span>
        )}
        {stats.inFlight > 0 && <span className="text-primary">{stats.inFlight} in flight</span>}
      </div>

      {stats.recent.length === 0 ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground/50">
          Nothing has asked for anything yet.
        </p>
      ) : (
        <div className="mt-1.5 flex flex-col gap-px">
          {stats.recent.slice(0, 12).map((entry) => (
            <div
              key={`${entry.at}-${entry.path}-${entry.ms}-${entry.bytes}`}
              className="tnum flex items-baseline gap-2 text-[10.5px]"
            >
              <span
                className={cn(
                  'w-7 shrink-0',
                  entry.status >= 400 ? 'text-kind-project' : 'text-muted-foreground/60'
                )}
              >
                {entry.status}
              </span>
              <span className="shrink-0 text-muted-foreground/80">{entry.path}</span>
              <span className="truncate text-foreground/70">{entry.detail}</span>
              <span className="ml-auto shrink-0 text-muted-foreground/45">
                {names.get(entry.peer) ?? entry.peer}
              </span>
              <span className="w-14 shrink-0 text-right text-muted-foreground/45">
                {formatBytes(entry.bytes)}
              </span>
              <span className="w-12 shrink-0 text-right text-muted-foreground/45">
                {entry.ms}ms
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * What the tailnet looks like from here, while it is being built.
 *
 * A diagnostic rather than the Devices list that will live in the sidebar: it shows the
 * facts the sidebar will later draw as rows - who is reachable, who is serving, what they
 * are serving - so the networking can be tested against a real second machine before there
 * is any UI depending on it.
 *
 * Every peer is listed, including the ones that are asleep or not running umakbang, because
 * "why is my other machine not here" is the question this whole feature will generate most,
 * and a line saying *umakbang is not running there* answers it where an empty list does not.
 */
function TailnetSection(): React.JSX.Element {
  const roots = useLibrary((s) => s.roots)
  const [state, setState] = useState<{
    tailnet: TailnetStatus
    devices: RemoteDevice[]
    server: RemoteServerState
  } | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      // Together, because a device list that disagrees with this machine's own state is
      // the confusing case - "nobody can see me" reads very differently when the answer is
      // that this end is not listening.
      const [listed, server] = await Promise.all([
        window.umakbang.remoteDevices(),
        window.umakbang.remoteServerState()
      ])
      setState({ ...listed, server })
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const server = state?.server
  const tailnet = state?.tailnet

  return (
    <Section
      title="Tailnet"
      hint="Serving is read-only and reaches no further than the tailnet."
    >
      <Row
        label="This machine"
        hint={
          server === undefined
            ? 'Checking.'
            : server.listening
              ? `Serving on ${server.address}:${server.port}. Bound to the tailnet address only - not the LAN, and not localhost.`
              : (server.reason ?? 'Not serving.')
        }
      >
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void refresh()}>
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          Refresh
        </Button>
      </Row>

      {server?.listening && <ServerMonitor peers={state?.devices ?? []} />}

      {tailnet && tailnet.state !== 'running' && (
        <p className="text-[11px] text-muted-foreground/70">
          {tailnet.reason ?? 'Tailscale is not running.'}
        </p>
      )}

      {state && state.devices.length === 0 && tailnet?.state === 'running' && (
        <p className="text-[11px] text-muted-foreground/70">
          No other machines in this tailnet.
        </p>
      )}

      {state?.devices.map((device) => (
        <div
          key={device.node.id}
          className="rounded-md border bg-card/40 px-2.5 py-1.5 text-[11.5px]"
        >
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className={cn(
                'h-1.5 w-1.5 shrink-0 rounded-full',
                device.serving
                  ? 'bg-primary'
                  : device.node.online
                    ? 'bg-muted-foreground/50'
                    : 'bg-muted-foreground/25'
              )}
            />
            <span className="font-medium">{device.node.hostName || device.node.name}</span>
            <span className="text-[10.5px] text-muted-foreground/60">{device.node.os}</span>
            <span className="ml-auto text-[10.5px] text-muted-foreground/60">
              {device.serving
                ? `umakbang ${device.hello?.device.version ?? ''}`
                : device.node.online
                  ? (device.reason ?? 'Not serving.')
                  : 'Offline'}
            </span>
          </div>

          <div className="tnum mt-0.5 pl-3.5 text-[10.5px] text-muted-foreground/50">
            {device.node.ipv4 ?? 'no address'} · {device.node.name}
          </div>

          {device.hello?.libraries.map((library) => {
            const mounted = roots.some(
              (root) =>
                root.remote?.deviceId === device.hello?.device.id && root.path === library.path
            )
            return (
              <div key={library.id} className="mt-1 flex items-center gap-2 pl-3.5 text-[11px]">
                <span className="text-foreground/80">{library.label}</span>
                <span className="tnum text-[10.5px] text-muted-foreground/50">
                  {library.generation === undefined ? 'never scanned' : library.id}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  className="ml-auto"
                  disabled={mounted || !device.node.ipv4 || library.generation === undefined}
                  onClick={() => {
                    const hello = device.hello
                    if (!hello || !device.node.ipv4) return
                    void window.umakbang.remoteMountLibrary(
                      {
                        deviceId: hello.device.id,
                        deviceName: device.node.hostName || device.node.name,
                        host: device.node.ipv4,
                        libraryId: library.id
                      },
                      library.path,
                      library.label
                    )
                  }}
                >
                  {mounted ? 'Added' : 'Add as root'}
                </Button>
              </div>
            )
          })}

          {device.serving && device.hello?.libraries.length === 0 && (
            <div className="mt-1 pl-3.5 text-[11px] text-muted-foreground/60">
              Serving, but no library is open there.
            </div>
          )}
        </div>
      ))}
    </Section>
  )
}

function DeveloperSection(): React.JSX.Element {
  const settings = useLibrary((s) => s.settings)
  const patchSettings = useLibrary((s) => s.patchSettings)
  const setView = useLibrary((s) => s.setView)
  const lastFolderDir = useLibrary((s) => s.lastFolderDir)
  const noLibrary = useLibrary((s) => s.roots.length === 0)

  return (
    <>
      <Section title="Developer" hint="For testing umakbang, not for using it.">
        <Row
          label="Developer mode"
          hint="Shows the switches below. Never travels in a backup."
        >
          <Switch
            checked={settings.developerMode}
            onChange={(developerMode) =>
              // The reset goes off with it. Leaving it armed behind a gate that is now shut
              // is a wipe on the next launch with nothing on screen saying so.
              patchSettings(
                developerMode ? { developerMode } : { developerMode, resetOnLaunch: false }
              )
            }
          />
        </Row>

        {settings.developerMode && (
          <Row
            label="Start fresh on next launch"
            hint={
              settings.resetOnLaunch
                ? 'On. Every launch opens on the welcome screen with no library, no tags and default settings. Turn this off and the next launch puts your real library, tags and ratings back exactly as they were - nothing has been deleted, only moved aside.'
                : 'Next launch comes up as a brand-new install: welcome screen, no library, default settings. Reversible - your real profile is moved aside, and switching this back off restores it on the following launch.'
            }
          >
            <Switch
              checked={settings.resetOnLaunch}
              onChange={(resetOnLaunch) => patchSettings({ resetOnLaunch })}
            />
          </Row>
        )}
      </Section>

      <TailnetSection />

      <Section title="Pages">
        <Row
          label="Stats"
          hint="Off takes it out of the sidebar. Nothing is worked out for it either - every figure on that page is derived on the page and nowhere else."
        >
          <Switch
            checked={settings.showStats}
            onChange={(showStats) => patchSettings({ showStats })}
          />
        </Row>
      </Section>

      <Section title="Tour">
        <Row
          label="Show the tutorial again"
          hint={
            noLibrary
              ? 'Open a folder first - the tour points at things in the library.'
              : 'Twenty seconds, seven steps, stoppable at any point.'
          }
        >
          <Button
            variant="secondary"
            size="sm"
            disabled={noLibrary}
            onClick={() => {
              patchSettings({ tutorialSeen: false })
              // Back to the explorer, because every step points at something that is only on
              // screen there. The tour starts itself once this page is gone.
              setView({ mode: 'folder', dir: lastFolderDir })
            }}
            className="gap-1.5"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Replay
          </Button>
        </Row>
      </Section>
    </>
  )
}

/**
 * What changed, under the version that changed it.
 *
 * In the Updates section rather than a page of its own, because "what version am I on" and
 * "what did that get me" are one question asked twice. The entry matching the running build
 * is open; older ones are a line each until asked for, so the section stays a section.
 */
function ChangelogList({ running }: { running: string }): React.JSX.Element | null {
  const [open, setOpen] = useState<string | null>(CHANGELOG[0]?.version ?? null)
  if (CHANGELOG.length === 0) return null

  return (
    <div className="mt-1 space-y-1">
      {CHANGELOG.map((entry) => {
        const expanded = open === entry.version
        return (
          <div key={entry.version} className="rounded-md border bg-card/40">
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setOpen(expanded ? null : entry.version)}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
            >
              <ChevronRight
                className={cn(
                  'h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform',
                  expanded && 'rotate-90'
                )}
              />
              <span className="tnum text-[12.5px] font-medium">{entry.version}</span>
              {/* Says which one you are actually running, since the list outlives any build. */}
              {entry.version === running && (
                <span className="rounded bg-primary/15 px-1 py-px text-[10px] text-primary">
                  installed
                </span>
              )}
              <span className="ml-auto shrink-0 text-[11px] text-muted-foreground/60">
                {new Date(entry.date).toLocaleDateString(undefined, {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric'
                })}
              </span>
            </button>
            {expanded && (
              <ul className="space-y-1 px-2.5 pb-2 pl-7">
                {entry.changes.map((change) => (
                  /*
                   * The bullet is the character itself, not `\2022`. This is a JSX attribute
                   * rather than a JS string, so nothing unescapes it on the way through:
                   * a doubled backslash reached the stylesheet as an escaped backslash and
                   * drew a literal "\2022" over the start of every line.
                   */
                  <li
                    key={change}
                    className="relative text-[11.5px] leading-relaxed text-muted-foreground before:absolute before:-left-2.5 before:text-muted-foreground/40 before:content-['•']"
                  >
                    {change}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Where the sound comes out.
 *
 * A device that has gone away keeps its place in the menu, marked as missing, rather than
 * disappearing from it: the setting still names the interface, so the menu has to as well.
 * Dropping it would leave "System default" selected and reading as a choice somebody made,
 * which is the silent fallback this whole section exists to replace with a sentence.
 */
function OutputSection(): React.JSX.Element {
  const chosen = useLibrary((s) => s.settings.outputDevice)
  const setOutputDevice = usePlayer((s) => s.setOutputDevice)
  const { devices, loaded, unlabelled, failure } = useAudioOutput()

  const missing = chosen !== null && loaded && !devices.some((device) => device.id === chosen.id)

  return (
    <Section title="Output">
      <Row
        label="Play through"
        hint={
          chosen
            ? 'Only umakbang moves - your DAW and everything else keep their own output.'
            : 'Follows whatever the system is set to.'
        }
      >
        <select
          value={chosen?.id ?? ''}
          onChange={(event) => {
            const id = event.target.value
            // The missing device is in the list too, and it is not in `devices` - falling
            // through to null there would turn re-picking your own interface into a reset.
            const device =
              devices.find((entry) => entry.id === id) ?? (chosen?.id === id ? chosen : null)
            setOutputDevice(device)
          }}
          className="h-7 max-w-[280px] rounded-md border bg-background px-2 text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <option value="">System default</option>
          {devices.map((device) => (
            <option key={device.id} value={device.id}>
              {device.label}
            </option>
          ))}
          {chosen && missing && (
            <option value={chosen.id}>{chosen.label} (not connected)</option>
          )}
        </select>
      </Row>

      {failure && <p className="text-[11px] text-destructive">{failure}</p>}

      {unlabelled && (
        <p className="text-[11px] text-muted-foreground/60">
          The system didn&rsquo;t hand over the device names, so they are numbered here.
          Pick one and press play to find out which it is.
        </p>
      )}
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
        hint="Perseus unless a particular voice comes out better on an older one."
      >
        <select
          value={settings.stemSplitter}
          onChange={(event) => patchSettings({ stemSplitter: event.target.value })}
          className="h-7 rounded-md border bg-background px-2 text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {/* Only the models the split endpoint accepts - see `STEM_SPLITTERS`. This used to
              list LALAL.AI's newest two as well, on the reasonable-sounding grounds that the
              latest model is normally the one worth using; they belong to endpoints umakbang
              does not call and refuse every stem it asks for, so offering them was offering a
              choice that could only fail. The older ones stay because a model that suits a
              particular voice better is a real thing. */}
          {STEM_SPLITTERS.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </Row>
    </Section>
  )
}

/**
 * Downloading audio from a link.
 *
 * The extractor is the only external program umakbang runs, so this is the one page that has
 * something to say about a binary: whether it is here, which build, and a way to force an
 * update rather than waiting for the weekly one to come round.
 */
function DownloadSection(): React.JSX.Element {
  const settings = useLibrary((s) => s.settings)
  const patchSettings = useLibrary((s) => s.patchSettings)
  const [tool, setTool] = useState<YoutubeToolStatus | null>(null)
  const [working, setWorking] = useState(false)

  useEffect(() => {
    void window.umakbang.youtubeToolStatus().then(setTool)
  }, [])

  const install = async (): Promise<void> => {
    setWorking(true)
    setTool(await window.umakbang.installYoutubeTool())
    setWorking(false)
  }

  return (
    <Section
      title="YT2MP3"
      hint="Pulls the audio off a link and writes it into the folder you are browsing. Whether a given link is yours to take is between you and whoever published it."
    >
      <div className="space-y-1.5">
        <div className="text-[12.5px]">Downloader</div>
        <div className="flex items-center gap-1.5">
          <span className="flex-1 truncate text-[11.5px] text-muted-foreground">
            {tool === null
              ? 'Checking…'
              : tool.ready
                ? `yt-dlp ${tool.version ?? ''}`.trim()
                : 'Not installed yet.'}
          </span>
          <Button variant="secondary" size="sm" disabled={working} onClick={() => void install()}>
            {working ? 'Working…' : tool?.ready ? 'Update now' : 'Install'}
          </Button>
        </div>
        {tool?.error && <p className="text-[11px] text-destructive">{tool.error}</p>}
        <p className="text-[11px] leading-snug text-muted-foreground/60">
          Fetched rather than bundled, and replaced by itself once a week: sites change how
          they serve audio often enough that a build frozen on release day stops working
          within a month. It lives beside umakbang&rsquo;s own data, not in your library.
        </p>
      </div>

      <Row
        label="Save as"
        hint="MP3 re-encodes what came down, which costs a second lossy generation. The original stream is the better audio and is usually .m4a."
      >
        <SegmentedControl
          value={settings.youtubeFormat}
          options={[
            { value: 'mp3', label: 'MP3' },
            { value: 'source', label: 'Original' }
          ]}
          onChange={(youtubeFormat) =>
            patchSettings({ youtubeFormat: youtubeFormat as 'mp3' | 'source' })
          }
        />
      </Row>

      {settings.youtubeFormat === 'mp3' && (
        <Row
          label="Bitrate"
          hint="What comes down is already lossy, so a higher rate here mostly buys file size."
        >
          <SegmentedControl
            value={String(settings.youtubeBitrate)}
            options={[
              { value: '128', label: '128k' },
              { value: '192', label: '192k' },
              { value: '256', label: '256k' },
              { value: '320', label: '320k' }
            ]}
            onChange={(rate) => patchSettings({ youtubeBitrate: Number(rate) })}
          />
        </Row>
      )}

      <Row
        label="Fallback folder"
        hint={
          settings.youtubeDir ||
          'Where a download goes when you are not standing in a folder - the saved views have nowhere of their own.'
        }
      >
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void window.umakbang
              .pickDirectory('Where downloads are written', settings.youtubeDir || undefined)
              .then((dir) => dir && patchSettings({ youtubeDir: dir }))
          }}
        >
          Choose…
        </Button>
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
      title="Not your own work"
      hint="Folders the random beat button skips and the stats page leaves out, subfolders included."
    >
      {dirs.length === 0 && (
        <p className="text-[11.5px] text-muted-foreground/70">
          Nothing excluded, so every playable file in the library can come up, and every one
          of them counts towards the keys and tempos on the stats page. Add your sample packs
          to keep both about your own music.
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

      {/* Not a folder, but the same question: what the dice should lean away from. */}
      <FavourUnratedToggle />
    </Section>
  )
}

/** Leans the random button towards the beats you have not judged yet. */
function FavourUnratedToggle(): React.JSX.Element {
  const favour = useLibrary((s) => s.settings.randomFavourUnrated)
  const patchSettings = useLibrary((s) => s.patchSettings)

  return (
    <Row
      label="Lean towards unrated"
      hint="Unrated beats come up four times as often. Rated ones still come up, so the dice never run dry once most of the library has stars on it."
    >
      <Switch
        checked={favour}
        onChange={(randomFavourUnrated) => patchSettings({ randomFavourUnrated })}
      />
    </Row>
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

/**
 * The keys umakbang made up, and where the user wants them.
 *
 * Only these - `shared/shortcuts.ts` has the argument for why the traditional chords are not
 * offered. A row captures the next key you press rather than asking you to type a name for
 * it, because the thing being chosen *is* a keypress and every other spelling of it is a
 * translation somebody has to get right.
 */
function ShortcutsSection(): React.JSX.Element {
  const shortcuts = useLibrary((s) => s.settings.shortcuts)
  const patchSettings = useLibrary((s) => s.patchSettings)
  const [capturing, setCapturing] = useState<ShortcutId | null>(null)
  const [refused, setRefused] = useState<string | null>(null)

  // Captured on the window during capture, and in the capture phase: the table and the app
  // both listen for these keys themselves, and without this a press meant for the picker
  // would also delete the selection on its way past.
  useEffect(() => {
    if (!capturing) return
    const onKey = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setCapturing(null)
        setRefused(null)
        return
      }
      // A modifier on its own is somebody still reaching for the key, not the answer.
      if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return
      if (event.ctrlKey || event.metaKey || event.altKey) {
        setRefused('Only keys without Ctrl, ⌘ or Alt can be changed here.')
        return
      }
      const clash = shortcutConflict(shortcuts, capturing, event.key)
      if (clash) {
        setRefused(clash)
        return
      }
      patchSettings({ shortcuts: { ...shortcuts, [capturing]: normaliseKeyName(event.key) } })
      setCapturing(null)
      setRefused(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capturing, shortcuts, patchSettings])

  const changed = SHORTCUT_ACTIONS.some(
    (action) => shortcuts[action.id] && shortcuts[action.id] !== action.defaultKey
  )

  return (
    <Section
      title="Shortcuts"
      hint="The keys umakbang invented. Ctrl/⌘ combinations - copy, paste, undo, select all - are left alone deliberately: they come from the system and every other app agrees about them."
    >
      {SHORTCUT_ACTIONS.map((action) => {
        const key = shortcutKey(shortcuts, action.id)
        const listening = capturing === action.id
        return (
          <Row key={action.id} label={action.label} hint={listening ? 'Press a key, Esc to cancel.' : action.hint}>
            <div className="flex items-center gap-1.5">
              {shortcuts[action.id] && shortcuts[action.id] !== action.defaultKey && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  title={`Back to ${shortcutLabel(action.defaultKey)}`}
                  aria-label={`Reset ${action.label}`}
                  onClick={() => {
                    const next = { ...shortcuts }
                    delete next[action.id]
                    patchSettings({ shortcuts: next })
                  }}
                  className="text-muted-foreground"
                >
                  <RotateCcw className="h-3 w-3" />
                </Button>
              )}
              <Button
                variant={listening ? 'default' : 'secondary'}
                size="sm"
                onClick={() => {
                  setRefused(null)
                  setCapturing(listening ? null : action.id)
                }}
                className="tnum min-w-[68px]"
              >
                {listening ? 'Press a key' : shortcutLabel(key)}
              </Button>
            </div>
          </Row>
        )
      })}

      {refused && <p className="text-[11px] text-destructive">{refused}</p>}

      {changed && (
        <div>
          <Button variant="outline" size="sm" onClick={() => patchSettings({ shortcuts: {} })}>
            Reset all to defaults
          </Button>
        </div>
      )}
    </Section>
  )
}

/**
 * How far back Ctrl+Z reaches.
 *
 * A ceiling has to exist - see `Settings.undoDepth` for why - but where it sits is a
 * judgement about how somebody works rather than anything the app can know, and 25 is only a
 * guess at the middle of it. Tidying a folder never reaches the end of it; moving a library
 * about in long batches does so in an afternoon.
 *
 * The hint counts what is actually on the stack rather than describing the setting twice,
 * because turning the number down drops the oldest records immediately - so the count is the
 * answer to this control, visible in the same breath as the change.
 */
function UndoSection(): React.JSX.Element {
  const depth = useLibrary((s) => s.settings.undoDepth)
  const patchSettings = useLibrary((s) => s.patchSettings)
  const held = useLibrary((s) => s.undo?.depth ?? 0)

  return (
    <Section
      title="Undo"
      hint="Ctrl+Z steps back through file operations - moves, copies, renames and new folders. A delete goes to the Recycle Bin rather than onto this list, since there is no reliable way to bring one back."
    >
      <Row
        label="Operations to remember"
        hint={
          held > 0
            ? `${held.toLocaleString()} ${held === 1 ? 'operation' : 'operations'} to step back through right now.`
            : 'Nothing to undo at the moment.'
        }
      >
        <SegmentedControl
          value={String(depth)}
          options={UNDO_DEPTHS.map((n) => ({ value: String(n), label: String(n) }))}
          onChange={(value) => patchSettings({ undoDepth: Number(value) })}
        />
      </Row>
    </Section>
  )
}

/** Offered rather than a free number: the cost of a deeper history is memory, and these are
 *  the points on that curve worth telling apart. Main clamps anything else to 1..200. */
const UNDO_DEPTHS = [5, 10, 25, 50, 100, 200]

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
  onChange,
  disabled = false
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-[18px] w-[32px] shrink-0 rounded-full transition-colors',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        checked ? 'bg-primary' : 'bg-input',
        disabled && 'cursor-not-allowed opacity-40'
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
