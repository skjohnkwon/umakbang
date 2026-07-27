import type React from 'react'
import { useEffect, useRef } from 'react'
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
import { connectUpdates } from '@/lib/updates'
import { MiniPlayer } from '@/components/MiniPlayer'
import { Notice } from '@/components/Notice'
import { StatsPage } from '@/components/stats/StatsPage'
import { SettingsPage } from '@/components/SettingsPage'
import { ContractsPage } from '@/components/contracts/ContractsPage'
import { ContractDialog } from '@/components/ContractDialog'
import { ImportWizard } from '@/components/ImportWizard'
import { useContracts } from '@/state/contracts'
import { connectLibraryEvents, useLibrary } from '@/state/library'
import { usePlayer } from '@/state/player'
import { useFolderTree, useVisibleRows } from '@/hooks/useLibraryView'
import { SETTLE } from '@/lib/motion'
import { endRowDrag } from '@/lib/drag'

/** How far the left/right arrows scrub the playing track. */
const SEEK_STEP_SECONDS = 3

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
  const folderCount = rows.reduce((total, row) => total + (row.type === 'folder' ? 1 : 0), 0)

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
        window.removeEventListener('dragend', endRowDrag, true)
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

      // Alt turns the same two keys into navigation, which is where every file manager
      // and browser puts Back and Forward. Checked before the seek cases, or holding Alt
      // would scrub instead.
      if (event.altKey && (event.code === 'ArrowLeft' || event.code === 'ArrowRight')) {
        event.preventDefault()
        if (event.code === 'ArrowLeft') useLibrary.getState().goBack()
        else useLibrary.getState().goForward()
        return
      }

      switch (event.code) {
        case 'Space':
          event.preventDefault()
          usePlayer.getState().togglePlay()
          break
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

  const pageKey =
    view.mode === 'stats' || view.mode === 'settings' || view.mode === 'contracts'
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
                    when you step into Stats rather than sliding away with the table. */}
                <NowPlayingBar />
              </main>

              {panelOpen && <NowPlayingPanel />}
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
