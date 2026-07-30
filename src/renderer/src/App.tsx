import type React from 'react'
import { useEffect, useMemo, useRef } from 'react'
import { MotionConfig } from 'motion/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SEARCH_INPUT_ID, TitleBar } from '@/components/TitleBar'
import { Sidebar } from '@/components/Sidebar'
import { Toolbar } from '@/components/Toolbar'
import { FileTable } from '@/components/FileTable'
import { NowPlayingPanel } from '@/components/NowPlayingPanel'
import { NowPlayingBar } from '@/components/NowPlayingBar'
import { ThemeBridge } from '@/components/ThemeBridge'
import { VisualizerOnlyView } from '@/components/VisualizerOnlyView'
import { Loading, NoLibrary, NoResults } from '@/components/EmptyState'
import { absolutePath } from '@/lib/paths'
import { runExplorerShortcut } from '@/lib/explorer-shortcuts'
import { matchesShortcut } from '@shared/shortcuts'
import { connectUpdates } from '@/lib/updates'
import { MiniPlayer } from '@/components/MiniPlayer'
import { Notice } from '@/components/Notice'
import { StatsPage } from '@/components/stats/StatsPage'
import { SettingsPage } from '@/components/SettingsPage'
import { ContractsPage } from '@/components/contracts/ContractsPage'
import { VideosPage } from '@/components/videos/VideosPage'
import { ContractDialog } from '@/components/ContractDialog'
import { ImportWizard } from '@/components/ImportWizard'
import { useContracts } from '@/state/contracts'
import { useVideos } from '@/state/videos'
import { connectLibraryEvents, useLibrary } from '@/state/library'
import { usePlayer } from '@/state/player'
import { useFolderTree, useVisibleRows } from '@/hooks/useLibraryView'
import { SETTLE } from '@/lib/motion'
import { endRowDrag } from '@/lib/drag'

/** How far the left/right arrows scrub the playing track. */
const SEEK_STEP_SECONDS = 3

/**
 * Whether a press is a given letter, by physical key *or* by the character it produced.
 *
 * `code` alone is the tidier test - it is layout-independent, so Ctrl+Z is the same physical
 * key on AZERTY - but it is not always populated. Measured: keys injected without a scancode
 * arrive with `code: ''` and only `key: 'Z'` set, which is what a macro tool, a remapper or
 * an on-screen keyboard sends, and this machine has one of those installed. Matching either
 * costs nothing and is what `FileTable`'s own handler has always done, which reads `key`.
 */
function isLetter(event: KeyboardEvent, code: string, letter: string): boolean {
  return event.code === code || event.key.toLowerCase() === letter
}

export default function App(): React.JSX.Element {
  const roots = useLibrary((s) => s.roots)
  const scanning = useLibrary((s) => s.scanning)
  const view = useLibrary((s) => s.view)
  const panelOpen = useLibrary((s) => s.settings.panelOpen)
  const visualizerOnly = useLibrary((s) => s.settings.visualizerOnly)
  const alwaysOnTop = useLibrary((s) => s.settings.alwaysOnTop)
  const miniPlayer = useLibrary((s) => s.miniPlayer)
  const ready = useLibrary((s) => s.ready)
  const progress = useLibrary((s) => s.progress)
  // Tracks are mutated in place, so this reads the length off a store that changed for some
  // other reason - which is exactly what the coalesced revision bump is, and what
  // `Sidebar`'s total count already rides on.
  const trackCount = useLibrary((s) => s.tracks.length)
  const rows = useVisibleRows()
  // Memoised on the rows themselves: App re-renders on every scan progress tick, and a
  // 300k-row reduce per tick is real work for a number that only changes with the rows.
  const folderCount = useMemo(
    () => rows.reduce((total, row) => total + (row.type === 'folder' ? 1 : 0), 0),
    [rows]
  )

  /**
   * Whether the visualizers actually have the window.
   *
   * The mode and the view are not the same thing, and conflating them is what made the app
   * inescapable: with the setting on and no library open, the stage has nothing to draw, so
   * the welcome screen rendered - but the title bar was hidden and the window shrunk to a
   * strip on the strength of the setting alone, leaving no control anywhere that could turn
   * it back off. Everything that hides chrome now asks this, not the setting.
   */
  const stage = visualizerOnly && roots.length > 0

  /**
   * Whether the window is still arriving.
   *
   * Latched, because `arrived` must not go false again: a rescan clears the index and would
   * otherwise pull the whole UI back to a loading screen out from under someone who was
   * using it.
   *
   * `ready` gates the first moment, and it was previously read by nothing at all - so
   * `roots.length === 0` was evaluated before `hydrate`'s two IPC round trips had returned
   * any roots, and every cold start flashed the welcome screen at a user who has a library.
   * `progress === null` covers the gap on the other side, between hydrating and the scanner
   * reporting for the first time, where `scanning` is still false.
   */
  const arrived = useRef(false)
  if (trackCount > 0) arrived.current = true
  const loading =
    !ready || (!arrived.current && roots.length > 0 && (scanning || progress === null))

  useEffect(() => connectLibraryEvents(), [])

  // The updater installs on quit rather than interrupting, so the only thing it needs
  // from the UI is to say that it will. One notice per downloaded version.
  useEffect(
    () =>
      connectUpdates((version) =>
        useLibrary.getState().notify(`umakbang ${version} is ready - it will install when you quit.`)
      ),
    []
  )

  // Watch whichever folder is on screen, so a bounce re-exported into it appears without
  // being asked for. One folder at a time: a recursive watch over a library this size is
  // a different proposition, and the scan still owns everything you aren't looking at.
  useEffect(() => {
    const dir =
      view.mode === 'folder' && roots.length > 0 && view.dir ? absolutePath(roots, view.dir) : null
    void window.umakbang.watchFolder(dir)
    return () => {
      void window.umakbang.watchFolder(null)
    }
  }, [view, roots])

  // The window's own always-on-top state doesn't survive a restart, so restore it once
  // settings have hydrated.
  useEffect(() => {
    void window.umakbang.setAlwaysOnTop(alwaysOnTop)
  }, [alwaysOnTop])

  // Visualizers-only shrinks the window to a strip; leaving it restores the old bounds.
  // Skipped while the mini player has the window, or the two would fight over its size.
  useEffect(() => {
    if (miniPlayer) return
    void window.umakbang.setCompact(stage)
  }, [stage, miniPlayer])

  // The mini player takes the window down to a square pinned above everything else.
  useEffect(() => {
    void window.umakbang.setMini(miniPlayer)
  }, [miniPlayer])

  // The remembered folder may have been renamed or deleted since last time. Once the
  // scan has settled, fall back to the top rather than leaving the user staring at an
  // empty folder that no longer exists.
  const folderIndex = useFolderTree().index
  useEffect(() => {
    if (scanning || view.mode !== 'folder' || view.dir === '') return
    if (folderIndex.size <= 1) return
    if (!folderIndex.has(view.dir)) useLibrary.getState().setView({ mode: 'folder', dir: '' })
  }, [scanning, view, folderIndex])

  // A file dropped anywhere but a folder row would otherwise make the window navigate to
  // it, replacing the app with the file. Folder rows call stopPropagation before this.
  useEffect(() => {
    const swallow = (event: DragEvent): void => {
      event.preventDefault()
      if (event.type === 'dragover' && event.dataTransfer) event.dataTransfer.dropEffect = 'none'
      else endRowDrag()
    }

    window.addEventListener('dragover', swallow)
    window.addEventListener('drop', swallow)
    return () => {
      window.removeEventListener('dragover', swallow)
      window.removeEventListener('drop', swallow)
    }
  }, [])

  // Menu-driven actions from the main process.
  useEffect(() => {
    const focusSearch = (): void => {
      const input = document.getElementById(SEARCH_INPUT_ID) as HTMLInputElement | null
      input?.focus()
      input?.select()
    }
    const offSearch = window.umakbang.onMenuFocusSearch(focusSearch)
    const offRescan = window.umakbang.onMenuRescan(() => void window.umakbang.rescan())
    return () => {
      offSearch()
      offRescan()
    }
  }, [])

  /**
   * Ctrl/⌘+Z, and which undo it meant.
   *
   * The Edit menu's first item owns the accelerator. On a window with a visible menu bar
   * that claims the key in the browser process and the page never sees it - but this window
   * is `titleBarStyle: 'hidden'`, so on Windows there is no menu bar for the accelerator to
   * hang off and the item never fires. Measured: Ctrl+Z did nothing at all. So both paths
   * exist, this one and the keydown fallback below, and they are safe together rather than
   * exclusive: `runUndo` refuses when there is no record or one is already running, and
   * zustand's `set` is synchronous, so whichever path arrives first claims the record and
   * the second is a no-op. Do not "simplify" this by deleting either one.
   *
   * A focused field gets Chromium's own text undo, which only main can trigger -
   * `document.execCommand('undo')` does nothing in a modern Chromium. Everything else gets
   * the file operation.
   */
  useEffect(() => {
    const typingNow = (): boolean => {
      const active = document.activeElement as HTMLElement | null
      return (
        active?.tagName === 'INPUT' ||
        active?.tagName === 'TEXTAREA' ||
        active?.isContentEditable === true
      )
    }
    const offUndo = window.umakbang.onMenuUndo(() => {
      if (typingNow()) {
        void window.umakbang.textUndo()
        return
      }
      void useLibrary.getState().runUndo()
    })
    // Redo has no text equivalent to hand back: `webContents.redo()` exists, but the field
    // being typed in is the search box and a redo there is not a thing anybody reaches for.
    // A focused field simply keeps the key rather than having a file operation happen under it.
    const offRedo = window.umakbang.onMenuRedo(() => {
      if (typingNow()) return
      void useLibrary.getState().runRedo()
    })
    return () => {
      offUndo()
      offRedo()
    }
  }, [])

  // Global transport shortcuts. Left/right scrub the playing track and are deliberately
  // handled only here - the table doesn't bind them, so a keypress can't seek twice.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable === true
      if (typing) return

      const mod = event.ctrlKey || event.metaKey

      // Undo, for the case the Edit menu's accelerator never fires - see the effect above.
      // A focused field has already returned at the `typing` guard, deliberately without
      // `preventDefault`, so Chromium's own text undo still runs there.
      if (mod && !event.shiftKey && isLetter(event, 'KeyZ', 'z')) {
        event.preventDefault()
        void useLibrary.getState().runUndo()
        return
      }

      // Redo, on both of the chords people reach for: Ctrl+Y is what Windows file managers
      // use and what the menu names, Ctrl+Shift+Z is what every editor and DAW uses. Binding
      // one and not the other means half the people who try it conclude there is no redo.
      if (
        mod &&
        ((!event.shiftKey && isLetter(event, 'KeyY', 'y')) ||
          (event.shiftKey && isLetter(event, 'KeyZ', 'z')))
      ) {
        event.preventDefault()
        void useLibrary.getState().runRedo()
        return
      }

      // The explorer's own clipboard keys - Ctrl+C/X/V/A/D and Ctrl+Shift+C/N - which were
      // bound to the table's scroll container and therefore dead everywhere else. See
      // `lib/explorer-shortcuts.ts`; the handler is the table's, not a second copy of it.
      //
      // `defaultPrevented` is what stops one press doing the work twice: React dispatches
      // the table's `onKeyDown` from the root container on the way up, so with focus in the
      // table it has already run and marked the event by the time this listener sees it.
      if (!event.defaultPrevented && runExplorerShortcut(event)) return

      // Alt turns the same two keys into navigation, which is where every file manager
      // and browser puts Back and Forward. Checked before the seek cases, or holding Alt
      // would scrub instead.
      if (event.altKey && (event.code === 'ArrowLeft' || event.code === 'ArrowRight')) {
        event.preventDefault()
        if (event.code === 'ArrowLeft') useLibrary.getState().goBack()
        else useLibrary.getState().goForward()
        return
      }

      /**
       * The app-wide half of the rebindable set - see `shared/shortcuts.ts`.
       *
       * Both of these belong here rather than in the table for the same reason Space always
       * has: the table binding them as well fires them twice for one press. The dice in
       * particular is not about the selection at all, so being bound to the window is what
       * makes it work from the settings page or with nothing selected.
       */
      const { shortcuts } = useLibrary.getState().settings
      if (matchesShortcut(event, shortcuts, 'playPause')) {
        // The video editor owns playback while it is open. Its window listener's
        // preventDefault() does not stop this global Explorer listener.
        if (useVideos.getState().project !== null) return
        event.preventDefault()
        usePlayer.getState().togglePlay()
        return
      }
      if (matchesShortcut(event, shortcuts, 'random')) {
        event.preventDefault()
        usePlayer.getState().playRandom()
        return
      }

      // Arrow keys nudge selected video layers and must not also seek Explorer.
      if (
        useVideos.getState().project !== null &&
        (event.code === 'ArrowLeft' || event.code === 'ArrowRight')
      ) {
        return
      }

      switch (event.code) {
        case 'ArrowRight':
          event.preventDefault()
          usePlayer.getState().seekBy(SEEK_STEP_SECONDS)
          break
        case 'ArrowLeft':
          event.preventDefault()
          usePlayer.getState().seekBy(-SEEK_STEP_SECONDS)
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  /**
   * The two extra buttons on the side of a mouse.
   *
   * Chromium reports them as button 3 and 4, and in an ordinary browser it would navigate
   * the page history itself. Here there is no page history to walk, so without this they
   * do nothing at all - which is the one thing a thumb button should never do in something
   * shaped like a file explorer.
   *
   * Bound on `mouseup` rather than `mousedown` so a press that began inside a menu or a
   * drag doesn't navigate out from under it, and `auxclick` is swallowed so nothing
   * downstream treats it as a middle-click.
   */
  useEffect(() => {
    const onMouseUp = (event: MouseEvent): void => {
      if (event.button !== 3 && event.button !== 4) return
      event.preventDefault()
      if (event.button === 3) useLibrary.getState().goBack()
      else useLibrary.getState().goForward()
    }
    const swallow = (event: MouseEvent): void => {
      if (event.button === 3 || event.button === 4) event.preventDefault()
    }
    window.addEventListener('mouseup', onMouseUp)
    window.addEventListener('auxclick', swallow)
    return () => {
      window.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('auxclick', swallow)
    }
  }, [])

  // Only the stats/browser swap animates. Keying on the folder as well would remount the
  // virtualised table on every navigation, throwing away scroll position and costing more
  // than the animation is worth.
  const drafting = useContracts((s) => s.drafting)
  const importing = useLibrary((s) => s.importing)
  const cancelImport = useLibrary((s) => s.cancelImport)

  /**
   * The video editor takes the whole page.
   *
   * It has a transport of its own and a frame that wants the width, so the app's own
   * transport strip and visualizer panel are folded away while a project is open - two play
   * buttons an inch apart that start different things is the kind of thing you only get
   * wrong once, publicly. The editor carries a button to put them back, and this is only
   * ever about the editor: the videos *list* keeps the normal chrome, because nothing there
   * is competing for it.
   */
  const editingVideo = useVideos((s) => s.project !== null)
  const videoChromeOpen = useVideos((s) => s.chromeOpen)
  const hideChrome = view.mode === 'videos' && editingVideo && !videoChromeOpen

  const pageKey =
    view.mode === 'stats' ||
    view.mode === 'settings' ||
    view.mode === 'contracts' ||
    view.mode === 'videos'
      ? view.mode
      : 'browse'

  return (
    <MotionConfig reducedMotion="user" transition={SETTLE}>
      <TooltipProvider delayDuration={400} skipDelayDuration={200}>
        <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
          <ThemeBridge />
          {/* No title bar on the stage: everything still worth reaching is in the overlay
              that fades in over the plots. Only when the plots are actually up, though -
              see `stage` above. */}
          {!stage && <TitleBar />}

          {loading ? (
            <Loading />
          ) : miniPlayer ? (
            <MiniPlayer />
          ) : stage ? (
            /* Full-window visualizers - the library is still loaded behind it, so
               toggling back is instant and playback never stops. */
            <VisualizerOnlyView />
          ) : roots.length === 0 ? (
            <NoLibrary />
          ) : (
            <div className="flex min-h-0 flex-1">
              <Sidebar />
              {/* Which page is on screen, so a test can read it without guessing from
                  the contents. */}
              <main data-view={view.mode} className="flex min-w-0 flex-1 flex-col">
                {/* Keyed so switching pages replays the enter animation. Deliberately not
                    AnimatePresence - see `.page-in` in index.css for what that cost. */}
                <div key={pageKey} className="page-in flex min-h-0 flex-1 flex-col">
                    {view.mode === 'stats' ? (
                      <StatsPage />
                    ) : view.mode === 'settings' ? (
                      <SettingsPage />
                    ) : view.mode === 'contracts' ? (
                      <ContractsPage />
                    ) : view.mode === 'videos' ? (
                      <VideosPage />
                    ) : (
                      <>
                        <Toolbar
                          rows={rows}
                          folderCount={folderCount}
                          fileCount={rows.length - folderCount}
                        />
                        {/* The table renders even with nothing in it: an empty folder is
                            still somewhere you paste into and make folders in. */}
                        <FileTable rows={rows} empty={<NoResults scanning={scanning} />} />
                      </>
                    )}
                </div>
                {/* Outside the animated swap: the transport belongs to whatever is
                    playing, not to the page you happen to be looking at, so it stays put
                    when you step into Stats rather than sliding away with the table. The
                    video editor is the one exception - see `hideChrome`. */}
                {!hideChrome && <NowPlayingBar />}
              </main>

              {panelOpen && !hideChrome && <NowPlayingPanel />}
            </div>
          )}

          {/* Drafting a contract is a modal over whatever you were doing, because it is
              about the files you had selected when you asked for it. */}
          {drafting && <ContractDialog titles={drafting} />}

          {/* Importing settings from another machine is a conversation, not a button: see
              ImportWizard for why a blind merge is the wrong thing across filesystems. */}
          {importing && (
            <ImportWizard
              backup={importing.backup}
              summary={importing.summary}
              here={importing.here}
              onClose={cancelImport}
            />
          )}

          <Notice />
        </div>
      </TooltipProvider>
    </MotionConfig>
  )
}
