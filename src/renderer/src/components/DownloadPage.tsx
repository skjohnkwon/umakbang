import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { CloudDownload, FolderOpen, Loader2, Download, X } from 'lucide-react'
import type { Settings, YoutubeInfo, YoutubeToolStatus } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Hint } from '@/components/ui/tooltip'
import { useLibrary } from '@/state/library'
import { baseName } from '@/lib/paths'
import { formatDuration } from '@/lib/format'
import { looksLikeLink } from '@/lib/youtube'

/**
 * Where every download lands. One folder, always, no picker and no setting.
 *
 * It used to follow the folder browsing was last in, which meant a download arrived in the
 * list already on screen - true, and a different answer every time the page was opened. This
 * is a staging folder that is filed out of by hand, so the destination is a fact rather than
 * a question, and `place()` mkdirs it, so it does not have to exist yet.
 *
 * `String.raw` because a Windows path in an ordinary literal eats its own separators: the
 * stem output default was first written that way and `\S`, `\t` and the rest turned it into
 * one unusable string. Same trap, same fix.
 */
const DOWNLOAD_DIR = String.raw`Z:\SECRET SAUCE\Stems\zmisc`

/**
 * Pulling audio off a link, as a place rather than a dialog.
 *
 * It began as a toolbar button and a modal, which suited the one-shot case and nothing else:
 * a download is a minute of somebody else's bandwidth followed by an encode, and the modal
 * had to be closable while it ran, which left the work with nowhere to be seen but a spinner
 * in the toolbar. A page can hold the whole shape of the job - what the link turns out to be,
 * where the file will land, what it will be saved as, and what this sitting has already
 * pulled down - without any of it competing with the library for the screen.
 *
 * It sits under Videos in the sidebar because that is where the things you do *with* audio
 * live rather than the ways of listing what you already have.
 */
export function DownloadPage(): React.JSX.Element {
  const settings = useLibrary((s) => s.settings)
  const patchSettings = useLibrary((s) => s.patchSettings)
  const download = useLibrary((s) => s.downloadFromLink)
  const job = useLibrary((s) => s.youtubeJob)
  const setView = useLibrary((s) => s.setView)
  const lastFolderDir = useLibrary((s) => s.lastFolderDir)

  const [url, setUrl] = useState('')
  const [tool, setTool] = useState<YoutubeToolStatus | null>(null)
  const [installing, setInstalling] = useState(false)
  const [installPercent, setInstallPercent] = useState<number | null>(null)
  const [info, setInfo] = useState<YoutubeInfo | null>(null)
  const [probing, setProbing] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  /** What this sitting has pulled down, newest first. Session-only, deliberately. */
  const [got, setGot] = useState<string[]>([])

  const dir = DOWNLOAD_DIR

  // Which probe is the current one. A slow answer for a link that has since been replaced
  // must not overwrite the fast answer for the one on screen.
  const generation = useRef(0)

  // The field starts empty on purpose. It used to offer whatever was on the clipboard, which
  // is right exactly as often as the last thing copied was the link you wanted - and wrong
  // silently the rest of the time, since a filled field reads as a link you chose. The field
  // is focused, so Ctrl+V is the whole of the difference.
  useEffect(() => {
    void window.umakbang.youtubeToolStatus().then(setTool)
  }, [])

  // Escape leaves, which is what every other page here answers to.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return
      setView({ mode: 'folder', dir: lastFolderDir })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setView, lastFolderDir])

  const ready = tool?.ready === true

  const probe = useCallback(
    async (value: string): Promise<void> => {
      const mine = ++generation.current
      setInfo(null)
      setProblem(null)
      if (!looksLikeLink(value) || !ready) return

      setProbing(true)
      const answer = await window.umakbang.probeYoutube(value.trim())
      if (mine !== generation.current) return
      setProbing(false)
      if (answer.error || !answer.info) {
        setProblem(answer.error ?? 'That link could not be read.')
        return
      }
      setInfo(answer.info)
    },
    [ready]
  )

  // Reads the link a beat after typing stops. Per keystroke would spawn a process per
  // character; only on Enter would mean the common case - paste, then press the button -
  // never describes what is about to be downloaded at all.
  useEffect(() => {
    if (!ready) return
    const timer = setTimeout(() => void probe(url), 400)
    return () => clearTimeout(timer)
  }, [url, ready, probe])

  const install = async (): Promise<void> => {
    setInstalling(true)
    setInstallPercent(0)
    const off = window.umakbang.onYoutubeProgress((progress) => {
      if (progress.phase === 'tool') setInstallPercent(progress.percent ?? 0)
    })
    setTool(await window.umakbang.installYoutubeTool())
    off()
    setInstallPercent(null)
    setInstalling(false)
  }

  const running = job !== null
  const playlist = info?.playlist === true
  const canDownload = ready && !running && info !== null && !playlist

  async function start(): Promise<void> {
    if (!canDownload) return
    // Awaited only to catch the finished path for the list below; the page stays usable
    // throughout, and closing it does not stop the job - the toolbar carries the spinner.
    const written = await download(url.trim(), dir)
    if (written) {
      setGot((previous) => [written, ...previous])
      setUrl('')
      setInfo(null)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <CloudDownload className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-[12.5px] font-medium">YT2MP3</span>
        <Hint label="Close (Esc)" side="bottom">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close YT2MP3"
            className="ml-auto"
            onClick={() => setView({ mode: 'folder', dir: lastFolderDir })}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </Hint>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="mx-auto max-w-[640px] space-y-3">
          {tool === null ? (
            <p className="text-[12px] text-muted-foreground">Checking…</p>
          ) : !ready ? (
            <section className="space-y-2 rounded-md border bg-card/40 px-3 py-3">
              <h2 className="text-[12.5px] font-semibold">One thing to fetch first</h2>
              <p className="text-[11.5px] leading-relaxed text-muted-foreground">
                This needs yt-dlp, which umakbang downloads once and then keeps up to date by
                itself. It lands beside umakbang&rsquo;s own data, not in your library, so it
                survives an update and a portable copy carries it.
              </p>
              {tool.error && <p className="text-[11px] text-destructive">{tool.error}</p>}
              <Button size="sm" disabled={installing} onClick={() => void install()}>
                {installing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {installing
                  ? installPercent !== null && installPercent > 0
                    ? `Downloading… ${Math.round(installPercent)}%`
                    : 'Downloading…'
                  : 'Install the downloader'}
              </Button>
            </section>
          ) : (
            <>
              <section className="space-y-2.5 rounded-md border bg-card/40 px-3 py-3">
                <label className="block">
                  <span className="mb-1 block text-[10.5px] uppercase tracking-wide text-muted-foreground/80">
                    Link
                  </span>
                  <Input
                    autoFocus
                    value={url}
                    spellCheck={false}
                    placeholder="https://…"
                    onChange={(event) => setUrl(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && canDownload) void start()
                    }}
                    className="h-8 text-[12.5px]"
                  />
                </label>

                {probing && (
                  <p className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Reading the link…
                  </p>
                )}

                {problem && (
                  <p className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
                    {problem}
                  </p>
                )}

                {playlist && (
                  <p className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
                    That link is a playlist{info?.count ? ` of ${info.count} videos` : ''}. Paste
                    a link to a single video.
                  </p>
                )}

                {info && !playlist && (
                  <div className="flex gap-2.5 rounded border bg-background/40 p-2">
                    {info.thumbnail && (
                      /* A `data:` URL that main fetched, not the site's own address: `img-src`
                         carries no remote origin, so an `<img>` pointed at the CDN is refused
                         by the CSP and draws nothing at all. See `inlineThumbnail`. */
                      <img
                        src={info.thumbnail}
                        alt=""
                        className="h-[54px] w-24 shrink-0 rounded object-cover"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12.5px] font-medium" title={info.title}>
                        {info.title}
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {[info.uploader, info.seconds ? formatDuration(info.seconds) : 'live']
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    </div>
                  </div>
                )}

                <Button className="w-full" disabled={!canDownload} onClick={() => void start()}>
                  {running ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                  Download
                </Button>

                {running && job && (
                  <div className="space-y-1 rounded border bg-background/40 px-2 py-2">
                    <div className="flex items-center gap-1.5 text-[11.5px]">
                      <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                      <span className="truncate">{job.title ?? 'Working…'}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-auto h-5 shrink-0"
                        onClick={() => void window.umakbang.cancelYoutube()}
                      >
                        Stop
                      </Button>
                    </div>
                    <div className="text-[10.5px] uppercase tracking-wider text-muted-foreground/70">
                      {job.phase === 'converting' ? 'encoding' : job.phase}
                      {job.percent !== undefined ? ` · ${Math.round(job.percent)}%` : ''}
                    </div>
                  </div>
                )}
              </section>

              <section className="rounded-md border bg-card/40">
                <header className="border-b px-3 py-2">
                  <h2 className="text-[12.5px] font-semibold">Where it lands</h2>
                  <p className="text-[11px] text-muted-foreground">
                    Always the same folder, so a download is never somewhere you have to go
                    looking for. File them out of it from the library.
                  </p>
                </header>
                <div className="flex items-center gap-2 px-3 py-2.5">
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={dir}>
                    {dir}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void window.umakbang.reveal(dir)}
                  >
                    <FolderOpen className="h-3 w-3" /> Show
                  </Button>
                </div>
              </section>

              <section className="rounded-md border bg-card/40">
                <header className="border-b px-3 py-2">
                  <h2 className="text-[12.5px] font-semibold">Saved as</h2>
                  <p className="text-[11px] text-muted-foreground">
                    MP3 is what most people mean by this. The original stream is strictly
                    better audio - it is what came down, with no second lossy generation over
                    it - and it arrives as m4a or webm.
                  </p>
                </header>
                <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                  <select
                    value={settings.youtubeFormat}
                    onChange={(event) =>
                      patchSettings({
                        youtubeFormat: event.target.value as Settings['youtubeFormat']
                      })
                    }
                    aria-label="Download format"
                    className="h-7 rounded-md border bg-background px-2 text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="mp3">MP3</option>
                    <option value="source">The original stream</option>
                  </select>
                  {settings.youtubeFormat === 'mp3' && (
                    <select
                      value={settings.youtubeBitrate}
                      onChange={(event) =>
                        patchSettings({ youtubeBitrate: Number(event.target.value) })
                      }
                      aria-label="MP3 bitrate"
                      className="h-7 rounded-md border bg-background px-2 text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      {[128, 160, 192, 256, 320].map((rate) => (
                        <option key={rate} value={rate}>
                          {rate} kbps
                        </option>
                      ))}
                    </select>
                  )}
                  <span className="text-[11px] text-muted-foreground">
                    {tool?.version ? `yt-dlp ${tool.version}` : ''}
                  </span>
                </div>
              </section>

              {got.length > 0 && (
                <section className="rounded-md border bg-card/40">
                  <header className="border-b px-3 py-2">
                    <h2 className="text-[12.5px] font-semibold">This sitting</h2>
                    <p className="text-[11px] text-muted-foreground">
                      Not a history - the files are in the library, which is the record. This
                      is only so the one you just pulled down is a click away.
                    </p>
                  </header>
                  <div>
                    {got.map((path) => (
                      <div key={path} className="flex items-center gap-2 border-b px-3 py-1.5 last:border-b-0">
                        <span className="min-w-0 flex-1 truncate text-[12px]" title={path}>
                          {baseName(path)}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void window.umakbang.reveal(path)}
                        >
                          <FolderOpen className="h-3 w-3" /> Show
                        </Button>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * The icon the sidebar and the toolbar use, so every way in agrees.
 *
 * A cloud rather than the plain download arrow, which the Downloads saved view already owns:
 * two controls carrying one glyph and meaning different things is worse than either icon
 * being slightly less obvious on its own.
 */
export const YoutubeIcon = CloudDownload
