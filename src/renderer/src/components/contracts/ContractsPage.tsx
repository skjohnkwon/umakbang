import type React from 'react'
import { useEffect, useState } from 'react'
import { FileText, FolderOpen, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Hint } from '@/components/ui/tooltip'
import { useContracts } from '@/state/contracts'
import { useLibrary } from '@/state/library'
import { baseName } from '@/lib/paths'
import { cn } from '@/lib/utils'

const SECTIONS = [
  { id: 'history', label: 'Contracts' },
  { id: 'presets', label: 'Purchasers' },
  { id: 'terms', label: 'Your terms' },
  { id: 'template', label: 'Template' }
] as const

/**
 * Everything about contracts that isn't generating one.
 *
 * Built like the settings page rather than the stats page: it is a set of things you keep
 * rather than a set of things you read, and it wants the same narrow nav down the side.
 */
export function ContractsPage(): React.JSX.Element {
  const data = useContracts((s) => s.data)
  const load = useContracts((s) => s.load)
  const setView = useLibrary((s) => s.setView)
  const lastFolderDir = useLibrary((s) => s.lastFolderDir)
  const [active, setActive] = useState<string>('history')

  useEffect(() => {
    void load()
  }, [load])

  const show = (id: string): string => (active === id ? 'block' : 'hidden')

  return (
    <div className="flex min-h-0 flex-1">
      <nav className="scroll-thin w-[168px] shrink-0 overflow-y-auto border-r bg-card/30 py-2">
        <div className="flex items-center gap-1 px-3 pb-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            Contracts
          </span>
          <Hint label="Close (Esc)" side="right">
            <button
              type="button"
              aria-label="Close contracts"
              onClick={() => setView({ mode: 'folder', dir: lastFolderDir })}
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
        <div className={cn('mx-auto max-w-[640px] space-y-3', show('history'))}>
          <HistorySection />
        </div>
        <div className={cn('mx-auto max-w-[560px] space-y-3', show('presets'))}>
          <PresetsSection />
        </div>
        <div className={cn('mx-auto max-w-[560px] space-y-3', show('terms'))}>
          <TermsSection />
        </div>
        <div className={cn('mx-auto max-w-[760px] space-y-3', show('template'))}>
          <TemplateSection />
        </div>
        {!data && <p className="text-[12px] text-muted-foreground">Loading…</p>}
      </div>
    </div>
  )
}

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
    <section className="rounded-md border bg-card/40">
      <header className="border-b px-3 py-2">
        <h2 className="text-[12.5px] font-semibold">{title}</h2>
        {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
      </header>
      <div className="space-y-2.5 px-3 py-2.5">{children}</div>
    </section>
  )
}

function HistorySection(): React.JSX.Element {
  const data = useContracts((s) => s.data)
  const remove = useContracts((s) => s.deleteRecord)
  const choose = useContracts((s) => s.chooseOutputDir)
  const history = data?.history ?? []

  return (
    <>
      <Section title="Where they go" hint="Both the Markdown and the PDF land here.">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[12px]" title={data?.outputDir}>
            {data?.outputDir || 'Not set'}
          </span>
          <Button variant="secondary" size="sm" onClick={() => void choose()}>
            Change
          </Button>
        </div>
      </Section>

      <Section
        title="Generated"
        hint={
          history.length === 0
            ? 'Right-click a track in the library and choose Generate contract.'
            : `${history.length} kept, newest first.`
        }
      >
        {history.map((record) => (
          <div key={record.id} className="flex items-center gap-2 border-b pb-2 last:border-0 last:pb-0">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px] font-medium">
                {record.input.titles.join(' & ')}
              </div>
              <div className="truncate text-[11px] text-muted-foreground">
                {record.input.customer}
                {record.input.alias ? ` (${record.input.alias})` : ''} · ${record.input.price} ·{' '}
                {record.when.replace('T', ' ')}
                {record.pdfError && <span className="text-destructive"> · PDF failed</span>}
              </div>
            </div>
            <Hint label="Open the PDF" side="top">
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={!record.pdfPath}
                onClick={() => record.pdfPath && void window.umakbang.openExternally(record.pdfPath)}
              >
                <FileText className="h-3.5 w-3.5" />
              </Button>
            </Hint>
            <Hint label="Show in folder" side="top">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => void window.umakbang.reveal(record.pdfPath ?? record.markdownPath)}
              >
                <FolderOpen className="h-3.5 w-3.5" />
              </Button>
            </Hint>
            <Hint label="Forget this one" side="top">
              <Button variant="ghost" size="icon-sm" onClick={() => void remove(record.id)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </Hint>
          </div>
        ))}
        {history.length === 0 && (
          <p className="text-[12px] text-muted-foreground/70">Nothing generated yet.</p>
        )}
      </Section>
    </>
  )
}

function PresetsSection(): React.JSX.Element {
  const data = useContracts((s) => s.data)
  const save = useContracts((s) => s.savePreset)
  const remove = useContracts((s) => s.deletePreset)
  const [name, setName] = useState('')
  const [alias, setAlias] = useState('')
  const [email, setEmail] = useState('')

  const add = async (): Promise<void> => {
    if (!name.trim() && !alias.trim()) return
    await save({ name, alias, email })
    setName('')
    setAlias('')
    setEmail('')
  }

  return (
    <Section
      title="Purchasers"
      hint="Saved buyers, offered as one-click fills when a contract is drafted."
    >
      {(data?.presets ?? []).map((preset) => (
        <div key={preset.alias || preset.name} className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12.5px]">{preset.alias || preset.name}</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {preset.name}
              {preset.email ? ` · ${preset.email}` : ''}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void remove(preset.alias || preset.name)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}

      <div className="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-1.5 border-t pt-2.5">
        <Input placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} />
        <Input placeholder="Alias" value={alias} onChange={(e) => setAlias(e.target.value)} />
        <Input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Button size="sm" onClick={() => void add()}>
          Add
        </Button>
      </div>
    </Section>
  )
}

function TermsSection(): React.JSX.Element {
  const data = useContracts((s) => s.data)
  const save = useContracts((s) => s.saveProfile)
  const profile = data?.profile

  if (!profile) return <></>

  return (
    <Section
      title="Your terms"
      hint="The producer side of every contract - who you are and what governs the deal."
    >
      <Row label="Full legal name">
        <Input
          defaultValue={profile.fullName}
          onBlur={(event) => void save({ fullName: event.target.value })}
        />
      </Row>
      <Row label="Alias (p.k.a.)">
        <Input
          defaultValue={profile.alias}
          onBlur={(event) => void save({ alias: event.target.value })}
        />
      </Row>
      <Row label="Email">
        <Input
          defaultValue={profile.email}
          onBlur={(event) => void save({ email: event.target.value })}
        />
      </Row>
      <Row label="Governing state">
        <Input
          defaultValue={profile.governingState}
          onBlur={(event) => void save({ governingState: event.target.value })}
        />
      </Row>
      <Row label="Delivered as">
        <Input
          defaultValue={profile.fileType}
          onBlur={(event) => void save({ fileType: event.target.value })}
        />
      </Row>
    </Section>
  )
}

function TemplateSection(): React.JSX.Element {
  const data = useContracts((s) => s.data)
  const save = useContracts((s) => s.saveTemplate)
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? data?.template ?? ''

  return (
    <Section
      title="Template"
      hint="The contract itself. {TOKENS} are filled in when one is generated; anything unknown is left alone."
    >
      <textarea
        value={text}
        onChange={(event) => setDraft(event.target.value)}
        spellCheck={false}
        className="scroll-thin h-[420px] w-full resize-none rounded border bg-background px-2 py-1.5 font-mono text-[11.5px] leading-relaxed outline-none focus-visible:border-primary"
      />
      <div className="flex items-center justify-end gap-1.5">
        <Button variant="ghost" size="sm" disabled={draft === null} onClick={() => setDraft(null)}>
          Revert
        </Button>
        <Button
          size="sm"
          disabled={draft === null}
          onClick={() => {
            if (draft !== null) void save(draft)
            setDraft(null)
          }}
        >
          Save template
        </Button>
      </div>
    </Section>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className="flex items-center gap-3">
      <span className="w-[130px] shrink-0 text-[12px] text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </label>
  )
}

/** Used by the sidebar row, so the icon and the page agree. */
export const contractsPageLabel = (path: string): string => baseName(path)
