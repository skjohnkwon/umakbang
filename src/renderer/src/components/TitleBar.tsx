import type React from 'react'
import { useState } from 'react'
import { Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { WindowActions } from '@/components/WindowActions'
import { MiniPlayerExit } from '@/components/MiniPlayer'
import { Logo } from '@/components/Logo'
import { AboutDialog } from '@/components/AboutDialog'
import { useLibrary } from '@/state/library'
import { useUpdateStatus } from '@/lib/updates'

export const SEARCH_INPUT_ID = 'umakbang-search'

export function TitleBar(): React.JSX.Element {
  const platform = useLibrary((s) => s.platform)
  const settings = useLibrary((s) => s.settings)
  const roots = useLibrary((s) => s.roots)
  const query = useLibrary((s) => s.query)
  const miniPlayer = useLibrary((s) => s.miniPlayer)
  const setQuery = useLibrary((s) => s.setQuery)
  const { version } = useUpdateStatus()

  const isMac = platform?.isMac ?? false
  const [searchFocused, setSearchFocused] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)

  // The mini player is 300px wide, most of which the native caption buttons would eat.
  // All it gets is the way back, on the side those buttons aren't.
  if (miniPlayer) {
    return (
      <header
        className="app-drag flex h-[38px] shrink-0 items-center gap-1.5 bg-background"
        style={{ paddingLeft: isMac ? 78 : 6, paddingRight: isMac ? 6 : 144 }}
      >
        <MiniPlayerExit />
        {/* Beside the exit rather than pushed to the far end: this strip reserves 144px on
            the right for the caption buttons, so `ml-auto` in a 300px window parks the mark
            in the middle of nothing. No `app-no-drag` - it is a mark, not a button, so it
            stays part of the handle. */}
        <Logo className="h-3.5 w-3.5 text-primary/60" />
      </header>
    )
  }

  // Visualizers-only keeps nothing but the drag strip: the library name, the search box
  // and the toggles would all be noise over the plots. The toggles reappear in that
  // view's own hover overlay, so nothing becomes unreachable.
  //
  // Only when the plots are actually up, though. With no library there is no hover overlay
  // to put them back, and stripping the bar on the setting alone left the welcome screen
  // with no way to turn the mode off - see `stage` in App.
  if (settings.visualizerOnly && roots.length > 0) {
    return (
      <header
        className="app-drag h-[38px] shrink-0 bg-background"
        style={{ paddingLeft: isMac ? 78 : 10, paddingRight: isMac ? 10 : 144 }}
      />
    )
  }

  return (
    <header
      className="app-drag flex h-[38px] shrink-0 items-center gap-2 border-b bg-background"
      // macOS keeps its traffic lights on the left; Windows and Linux draw native
      // caption buttons over the right edge of the web contents.
      style={{ paddingLeft: isMac ? 78 : 10, paddingRight: isMac ? 10 : 144 }}
    >
      {/* The app mark, where a windowed app's icon goes, with the running version beside it,
          and the way into About. It carries `app-no-drag` because it is a button now - left
          as drag surface, a press would start moving the window instead of opening anything.

          The version comes off the updater's status rather than a new IPC call - `latest` in
          `updater.ts` is seeded with `app.getVersion()` at module scope, so it is answered
          even when the updater itself is disabled, which is every dev run and every portable
          copy. It renders nothing until the first status arrives; an empty gap for a moment
          beats "v" with nothing after it. */}
      <button
        type="button"
        aria-label="About umakbang"
        title="About umakbang"
        onClick={() => setAboutOpen(true)}
        className="app-no-drag flex items-center gap-1.5 rounded px-0.5 py-0.5 transition-colors hover:bg-accent/60"
      >
        <Logo className="h-4 w-4 text-primary" />
        {version && (
          <span className="text-[10px] leading-none tabular-nums text-muted-foreground/70">
            {version}
          </span>
        )}
      </button>

      {aboutOpen && <AboutDialog version={version} onClose={() => setAboutOpen(false)} />}


      <div data-tour="search" className="app-no-drag relative mx-auto w-full max-w-[420px]">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          id={SEARCH_INPUT_ID}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setQuery('')
              event.currentTarget.blur()
            }
          }}
          placeholder={
            searchFocused ? 'name, ext:wav, bpm>120, key:Am, tag:keeper, stars:4-5' : 'Search library'
          }
          className="h-[26px] pl-7 pr-7"
          spellCheck={false}
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
            aria-label="Clear search"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <WindowActions />
    </header>
  )
}
