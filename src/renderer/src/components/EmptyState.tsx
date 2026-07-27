import type React from 'react'
import { Download, FolderOpen, SearchX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Logo } from '@/components/Logo'
import { useLibrary } from '@/state/library'

export function NoLibrary(): React.JSX.Element {
  // Offered here as well as in Settings, because a first launch is exactly when a backup
  // from another machine is worth having and the settings page is behind a library the
  // user doesn't have yet. The wizard renders over this screen; it maps folders, it
  // doesn't open one, so choosing a folder is still the next step either way.
  const beginImport = useLibrary((s) => s.beginImport)

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <Logo className="h-9 w-9 text-primary/70" />
      <div>
        <h2 className="text-[15px] font-medium">Point umakbang at your music folder</h2>
        {/* The one place there's room to say it. */}
        <p className="mt-0.5 text-[11px] italic text-muted-foreground/60">
          it&rsquo;s pronounced oo-mahk-bahng
        </p>
        <p className="mx-auto mt-2 max-w-[380px] text-[12.5px] leading-relaxed text-muted-foreground">
          umakbang indexes every audio and project file underneath it, reads their tempo, key
          and format, and lets you audition anything without leaving the window.
        </p>
      </div>
      <Button onClick={() => void window.umakbang.pickFolder()} className="mt-1 gap-1.5">
        <FolderOpen className="h-3.5 w-3.5" />
        Choose folder
      </Button>
      <p className="text-[11px] text-muted-foreground/60">
        Nothing is copied or moved unless you ask.
      </p>
      <div className="mt-3 flex flex-col items-center gap-1 border-t border-border/50 pt-3">
        <Button variant="subtle" size="sm" onClick={() => void beginImport()} className="gap-1.5">
          <Download className="h-3.5 w-3.5" />
          Import settings…
        </Button>
        <p className="max-w-[340px] text-[11px] leading-relaxed text-muted-foreground/60">
          Coming from another machine? Bring your tags, ratings and preferences across from
          a backup.
        </p>
      </div>
    </div>
  )
}

export function NoResults({ scanning }: { scanning: boolean }): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
      <SearchX className="h-6 w-6 text-muted-foreground/50" />
      <p className="text-[12.5px] text-muted-foreground">
        {scanning ? 'Still indexing - results will appear as they are found.' : 'Nothing here.'}
      </p>
      {!scanning && (
        <p className="max-w-[360px] text-[11.5px] leading-relaxed text-muted-foreground/60">
          Try a different folder, or narrow with filters like{' '}
          <code className="rounded bg-secondary px-1 py-px">ext:wav</code>,{' '}
          <code className="rounded bg-secondary px-1 py-px">bpm&gt;120</code> or{' '}
          <code className="rounded bg-secondary px-1 py-px">tag:keeper</code>.
        </p>
      )}
    </div>
  )
}
