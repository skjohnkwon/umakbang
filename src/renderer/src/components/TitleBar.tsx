import type React from 'react'
import { useState } from 'react'
import { ChevronDown, FolderOpen, RefreshCw, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { WindowActions } from '@/components/WindowActions'
import { MiniPlayerExit } from '@/components/MiniPlayer'
import { Logo } from '@/components/Logo'
import { useLibrary } from '@/state/library'
import { baseName } from '@/lib/format'
import { useUpdateStatus } from '@/lib/updates'
import { cn } from '@/lib/utils'

export const SEARCH_INPUT_ID = 'umakbang-search'

export function TitleBar(): React.JSX.Element {
  const platform = useLibrary((s) => s.platform)
  const settings = useLibrary((s) => s.settings)
  const roots = useLibrary((s) => s.roots)
  const ready = useLibrary((s) => s.ready)
  const query = useLibrary((s) => s.query)
  const scanning = useLibrary((s) => s.scanning)
  const miniPlayer = useLibrary((s) => s.miniPlayer)
  const setQuery = useLibrary((s) => s.setQuery)
  const { version } = useUpdateStatus()

  const isMac = platform?.isMac ?? false
  const [searchFocused, setSearchFocused] = useState(false)

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
      {/* The app mark, where a windowed app's icon goes, with the running version beside it.
          Deliberately not a button: every other thing in this bar does something, and a logo
          that looked clickable and wasn't would be the odd one out. Being plain also leaves
          it as drag surface.

          The version comes off the updater's status rather than a new IPC call - `latest` in
          `updater.ts` is seeded with `app.getVersion()` at module scope, so it is answered
          even when the updater itself is disabled, which is every dev run and every portable
          copy. It renders nothing until the first status arrives; an empty gap for a moment
          beats "v" with nothing after it. */}
      <div className="flex items-center gap-1.5">
        <Logo className="h-4 w-4 text-primary" />
        {version && (
          <span className="text-[10px] leading-none tabular-nums text-muted-foreground/70">
            {version}
          </span>
        )}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="app-no-drag max-w-[240px] gap-1 px-1.5">
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">
              {/* Blank rather than "No library" until settings have hydrated. Saying there
                  is no library while the loading screen says otherwise is the same mistake
                  the welcome-screen flash was, just in less space: nobody has been asked
                  anything yet, so there is nothing true to say. */}
              {!ready
                ? ''
                : roots.length === 0
                  ? 'No library'
                  : roots.length === 1
                    ? roots[0].label
                    : `${roots.length} folders`}
            </span>
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[16rem]">
          <DropdownMenuItem onSelect={() => void window.umakbang.pickFolder()}>
            <FolderOpen className="h-3.5 w-3.5" />
            Add a folder…
          </DropdownMenuItem>
          {/* Every open folder, so the one you want to drop is named rather than
              described. Removing one leaves the files on disk untouched. */}
          {roots.map((entry) => (
            <DropdownMenuItem
              key={entry.label}
              title={entry.path}
              onSelect={() => void window.umakbang.removeLibraryFolder(entry.label)}
            >
              <X className="h-3.5 w-3.5" />
              <span className="truncate">Remove {entry.label}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem
            onSelect={() => void window.umakbang.rescan()}
            disabled={roots.length === 0}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', scanning && 'animate-spin')} />
            Rescan library
          </DropdownMenuItem>
          {settings.recentRoots.length > 1 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Recent</DropdownMenuLabel>
              {settings.recentRoots
                .filter((recent) => !roots.some((entry) => entry.path === recent))
                .map((recent) => (
                  <DropdownMenuItem
                    key={recent}
                    onSelect={() => void window.umakbang.openLibrary(recent)}
                    title={recent}
                  >
                    <span className="truncate">{baseName(recent)}</span>
                  </DropdownMenuItem>
                ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="app-no-drag relative mx-auto w-full max-w-[420px]">
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
