/**
 * Contract generation: fill a template, write the Markdown, print the PDF.
 *
 * The app this replaces went Markdown -> pandoc -> HTML -> wkhtmltopdf -> PDF. Two system
 * binaries is two more than a packed Electron app can count on, and Electron already has a
 * renderer that prints to PDF. So the pipeline here is template -> Markdown -> HTML ->
 * `printToPDF`, and the only dependency is the app itself.
 *
 * The Markdown converter is deliberately small. It covers exactly what these templates use
 * - headings, bold, rules, both kinds of list, hard line breaks and raw inline HTML for the
 * underlines - rather than pretending to be a Markdown implementation.
 */

import { BrowserWindow } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_CONTRACT_PROFILE,
  DEFAULT_CONTRACT_TEMPLATE,
  type ContractData,
  type ContractInput,
  type ContractPreset,
  type ContractProfile,
  type ContractRecord
} from '../shared/contracts'

let file = ''
let data: ContractData = {
  profile: { ...DEFAULT_CONTRACT_PROFILE },
  presets: [],
  history: [],
  template: DEFAULT_CONTRACT_TEMPLATE,
  outputDir: ''
}

export function initContracts(dataDir: string, documentsDir: string): void {
  file = join(dataDir, 'umakbang-contracts.json')
  // Somewhere a person would look for a contract, rather than inside application data.
  data.outputDir = join(documentsDir, 'umakbang contracts')
  if (!existsSync(file)) return
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Partial<ContractData>
    data = {
      profile: { ...DEFAULT_CONTRACT_PROFILE, ...(saved.profile ?? {}) },
      presets: saved.presets ?? [],
      history: saved.history ?? [],
      // An empty template would silently generate an empty contract, which is worse than
      // ignoring what was saved.
      template: saved.template?.trim() ? saved.template : DEFAULT_CONTRACT_TEMPLATE,
      outputDir: saved.outputDir || data.outputDir
    }
  } catch {
    // A corrupt file starts over rather than stopping the app from opening.
  }
}

function persist(): void {
  if (!file) return
  try {
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch {
    // Best effort, like every other cache here.
  }
}

export function getContractData(): ContractData {
  return data
}

export function saveContractProfile(profile: Partial<ContractProfile>): ContractData {
  data.profile = { ...data.profile, ...profile }
  persist()
  return data
}

export function saveContractTemplate(template: string): ContractData {
  if (template.trim()) data.template = template
  persist()
  return data
}

export function setContractOutputDir(dir: string): ContractData {
  data.outputDir = dir
  persist()
  return data
}

/** Presets are keyed by alias, falling back to name, so re-saving one updates it. */
function presetKey(preset: Pick<ContractPreset, 'name' | 'alias'>): string {
  return (preset.alias || preset.name || '').trim().toLowerCase()
}

export function saveContractPreset(preset: ContractPreset): ContractData {
  const clean: ContractPreset = {
    name: preset.name.trim(),
    alias: preset.alias.trim(),
    email: preset.email.trim()
  }
  if (!clean.name && !clean.alias) return data
  const key = presetKey(clean)
  data.presets = [...data.presets.filter((entry) => presetKey(entry) !== key), clean].sort((a, b) =>
    (a.alias || a.name).localeCompare(b.alias || b.name)
  )
  persist()
  return data
}

export function deleteContractPreset(key: string): ContractData {
  const wanted = key.trim().toLowerCase()
  data.presets = data.presets.filter((entry) => presetKey(entry) !== wanted)
  persist()
  return data
}

export function deleteContractRecord(id: string): ContractData {
  data.history = data.history.filter((entry) => entry.id !== id)
  persist()
  return data
}

/* ------------------------------------------------------------------ rendering */

const PLACEHOLDER = /\{([A-Z_]+)\}/g

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen'
]
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

/**
 * Spells a price out, because the contract says the amount twice - once in words and once
 * in figures - and a mismatch between them is the kind of thing that voids a clause.
 */
export function priceToWords(value: string): string {
  const amount = Math.floor(Number(value.replace(/[^0-9.]/g, '')))
  if (!Number.isFinite(amount) || amount < 0) return value
  const words = spell(amount)
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function spell(n: number): string {
  if (n < 20) return ONES[n]
  if (n < 100) {
    const rest = n % 10
    return TENS[Math.floor(n / 10)] + (rest ? `-${ONES[rest]}` : '')
  }
  if (n < 1000) {
    const rest = n % 100
    return `${ONES[Math.floor(n / 100)]} hundred${rest ? ` ${spell(rest)}` : ''}`
  }
  if (n < 1_000_000) {
    const rest = n % 1000
    return `${spell(Math.floor(n / 1000))} thousand${rest ? ` ${spell(rest)}` : ''}`
  }
  const rest = n % 1_000_000
  return `${spell(Math.floor(n / 1_000_000))} million${rest ? ` ${spell(rest)}` : ''}`
}

/** A percentage without a pointless trailing zero: 25 -> "25", 12.50 -> "12.5". */
function formatPercent(value: string): string {
  const number = Number(String(value).replace('%', '').trim())
  if (!Number.isFinite(number)) return '0'
  return String(Math.round(number * 100) / 100)
}

/** Everything the template can ask for, given a profile and one deal's input. */
export function contractValues(
  profile: ContractProfile,
  input: ContractInput,
  today = new Date()
): Record<string, string> {
  const titles = input.titles.map((title) => title.trim()).filter(Boolean)
  const price = String(input.price).replace(/^\$/, '').trim()
  const producerWriter = formatPercent(input.producerWriter)
  const producerPublisher = formatPercent(input.producerPublisher)

  return {
    PRODUCT_TITLE: titles.map((title) => `"${title}"`).join(' & '),
    CONTRACT_DATE: today.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    }),
    PRODUCT_OWNER_FULLNAME: profile.fullName,
    PRODUCER_ALIAS: profile.alias,
    CUSTOMER_FULLNAME: input.customer,
    // The template writes the alias in bold, so an empty one left `****` sitting in the
    // sentence. A purchaser who trades under their own name is the ordinary case, not a
    // missing field.
    CUSTOMER_ALIAS: input.alias.trim() || input.customer,
    PRODUCT_PRICE: `$${price} USD`,
    PRODUCT_PRICE_WORD: priceToWords(price),
    PROD_WRITER: producerWriter,
    PROD_PUBLISHER: producerPublisher,
    PURCH_WRITER: formatPercent(String(100 - Number(producerWriter))),
    PURCH_PUBLISHER: formatPercent(String(100 - Number(producerPublisher))),
    FILE_TYPE: profile.fileType,
    STATE_PROVINCE_COUNTRY: profile.governingState
  }
}

/** Fills the template. Unknown tokens are left alone rather than blanked. */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (match, name: string) => values[name] ?? match)
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Inline Markdown, plus the handful of raw tags the template uses. */
function inline(text: string): string {
  // The template's own `<u>` and `<br>` survive; everything else is escaped first, so a
  // stray angle bracket in a track title cannot become markup.
  const guarded = escapeHtml(text)
    .replace(/&lt;u&gt;/g, '<u>')
    .replace(/&lt;\/u&gt;/g, '</u>')
    .replace(/&lt;br\s*\/?&gt;/g, '<br>')
  return guarded
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
}

/**
 * The subset of Markdown these templates are written in.
 *
 * Not a Markdown implementation: headings, rules, both list kinds, paragraphs, hard breaks
 * from two trailing spaces, and inline bold/italic/underline. Anything else passes through
 * as text, which is the right failure for a legal document - it shows up rather than
 * disappearing.
 */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let paragraph: string[] = []
  let list: 'ul' | 'ol' | null = null

  const closeParagraph = (): void => {
    if (paragraph.length === 0) return
    out.push(`<p>${paragraph.join('<br>\n')}</p>`)
    paragraph = []
  }
  const closeList = (): void => {
    if (!list) return
    out.push(`</${list}>`)
    list = null
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    const hardBreak = /\s{2,}$/.test(raw)

    if (!line.trim()) {
      closeParagraph()
      closeList()
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      closeParagraph()
      closeList()
      const level = heading[1].length
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      continue
    }

    if (/^---+$/.test(line.trim())) {
      closeParagraph()
      closeList()
      out.push('<hr>')
      continue
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    const numbered = /^\s*\d+\.\s+(.*)$/.exec(line)
    if (bullet || numbered) {
      closeParagraph()
      const wanted = bullet ? 'ul' : 'ol'
      if (list !== wanted) {
        closeList()
        out.push(`<${wanted}>`)
        list = wanted
      }
      out.push(`<li>${inline((bullet ?? numbered)![1])}</li>`)
      continue
    }

    // A continuation line inside a list item belongs to that item.
    if (list && /^\s{2,}\S/.test(raw)) {
      const last = out.length - 1
      if (out[last]?.startsWith('<li>')) {
        out[last] = out[last].replace(/<\/li>$/, ` ${inline(line.trim())}</li>`)
        continue
      }
    }

    paragraph.push(inline(line.trim()) + (hardBreak ? '' : ''))
  }
  closeParagraph()
  closeList()
  return out.join('\n')
}

/** The printable document: the same styling the old app's CSS produced. */
export function contractHtml(markdown: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  @page { margin: 1in; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 12pt; line-height: 1.5; color: #000; }
  h1, h2, h3, h4 { font-size: 12pt; margin: 1.2em 0 0.6em; }
  p { margin: 0 0 0.8em; }
  ul, ol { margin: 0 0 0.8em 1.4em; padding: 0; }
  li { margin: 0 0 0.4em; }
  hr { border: none; border-top: 1px solid #999; margin: 1.2em 0; }
  strong, b { font-weight: bold; }
</style></head><body>
${markdownToHtml(markdown)}
</body></html>`
}

/* ------------------------------------------------------------------ generating */

function stamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
}

function safeName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[<>:"/\\|?* -]/g, '').trim().replace(/\.+$/, '') || 'contract'
}

export interface ContractResult {
  record?: ContractRecord
  error?: string
}

/**
 * Writes a contract's Markdown and PDF, and records it.
 *
 * The Markdown is written first and kept whatever happens to the PDF: it is the document,
 * and a failed print shouldn't lose the thing that was generated.
 */
/**
 * The contract as it would be printed, without printing it.
 *
 * The same four steps the PDF goes through - values, template, Markdown, HTML - stopping
 * short of `printToPDF`. It has to be the same path or the preview becomes a mock-up that
 * drifts from the document, which for a legal text is worse than having no preview at all.
 *
 * Deliberately lenient where `generateContract` is strict: this runs on every keystroke,
 * and refusing to draw anything until the form is valid would leave the panel empty for the
 * whole time somebody is filling it in. `priceToWords` and `formatPercent` already fall back
 * rather than throw, so a half-typed price renders as whatever it currently says.
 */
export function previewContract(input: ContractInput): string {
  const titles = input.titles.map((title) => title.trim()).filter(Boolean)
  if (titles.length === 0) {
    return contractHtml('*Add a track title to see the contract.*')
  }
  try {
    const markdown = fillTemplate(
      data.template,
      contractValues(data.profile, { ...input, titles }, new Date())
    )
    return contractHtml(markdown)
  } catch (error) {
    return contractHtml(`*Cannot preview yet: ${describe(error)}*`)
  }
}

export async function generateContract(
  input: ContractInput,
  outputDir: string
): Promise<ContractResult> {
  const titles = input.titles.map((title) => title.trim()).filter(Boolean)
  if (titles.length === 0) return { error: 'A contract needs at least one track title.' }
  if (!input.customer.trim()) return { error: "The purchaser's legal name is required." }
  if (!/^\d+(\.\d+)?$/.test(String(input.price).replace(/^\$/, '').trim())) {
    return { error: 'The price must be a number, like 300.' }
  }

  const now = new Date()
  const markdown = fillTemplate(data.template, contractValues(data.profile, input, now))
  const stem = `${safeName(titles.join(' & '))}-CONTRACT-${stamp(now)}`
  const target = outputDir || data.outputDir
  if (!target) return { error: 'No output folder is set for contracts.' }

  const markdownPath = join(target, `${stem}.md`)
  const pdfPath = join(target, `${stem}.pdf`)
  try {
    await mkdir(target, { recursive: true })
    await writeFile(markdownPath, markdown, 'utf8')
  } catch (error) {
    return { error: `Could not write the contract: ${describe(error)}` }
  }

  let pdfError: string | undefined
  try {
    await printToPdf(contractHtml(markdown), pdfPath)
  } catch (error) {
    pdfError = describe(error)
  }

  const record: ContractRecord = {
    id: `${now.getTime()}`,
    when: now.toISOString().slice(0, 19),
    input: { ...input, titles },
    markdownPath,
    pdfPath: pdfError ? null : pdfPath,
    ...(pdfError ? { pdfError } : {})
  }
  data.history = [record, ...data.history].slice(0, 100)
  persist()
  return { record }
}

/**
 * Prints HTML to a PDF through an offscreen window.
 *
 * `printToPDF` needs a real renderer, so this is a hidden window loaded from a data URL -
 * no temp file, and nothing for a crash to leave behind.
 */
async function printToPdf(html: string, target: string): Promise<void> {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, javascript: false, sandbox: true }
  })
  try {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    const pdf = await window.webContents.printToPDF({
      printBackground: true,
      pageSize: 'Letter',
      margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 }
    })
    await writeFile(target, pdf)
  } finally {
    window.destroy()
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
