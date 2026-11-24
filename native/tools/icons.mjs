// Writes the lucide icons the native UI draws as SVG files, from the same icon data the React app
// renders (`lucide-react`), so a glyph is the same glyph in both. Run from the repo root:
//   node native/tools/icons.mjs
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..', '..')
const source = path.join(root, 'node_modules', 'lucide-react', 'dist', 'esm', 'icons')
const out = path.join(root, 'native', 'assets', 'icons')

const names = `search mouse-pointer-click repeat wand-sparkles dices audio-lines folder-tree list-filter
columns3 picture-in-picture2 pin-off panel-right cog folder-open file-pen-line clapperboard
cloud-download star pin hash locate-fixed plus arrow-left arrow-right corner-left-up refresh-cw
folder-plus columns2 arrow-down arrow-up folder skip-back play pause skip-forward list-music volume2
volume-x gauge scissors music x chevron-right chevron-down minus save clock
file-audio2 file-music file-sliders file-archive file-x2 loader2 pencil-line trash2 copy clipboard-paste
folder-input external-link check chevron-left chevron-up scissors-line-dashed tag circle-x arrow-up-down filter-x download bar-chart3 info file-text upload split maximize2 rotate-ccw package download folder-output folder-search wand2 sparkles alert-triangle type folder-archive`.split(/\s+/).filter(Boolean)

const attrs = (props) =>
  Object.entries(props)
    .filter(([key]) => key !== 'key')
    .map(([key, value]) => `${key}="${value}"`)
    .join(' ')

fs.mkdirSync(out, { recursive: true })
let written = 0
for (const name of names) {
  // `columns3` is the class lucide puts on the element; the module is `columns-3`.
  const candidates = [name, name.replace(/(\D)(\d+)$/, '$1-$2')]
  const file = candidates.map((c) => path.join(source, `${c}.mjs`)).find((f) => fs.existsSync(f))
  if (!file) {
    console.error(`missing icon: ${name}`)
    process.exitCode = 1
    continue
  }
  // Renamed icons stay as one-line modules re-exporting the new name; follow the alias.
  const alias = /export \{ default \} from '\.\/([\w-]+\.mjs)'/.exec(fs.readFileSync(file, 'utf8'))
  const { __iconNode } = await import(pathToFileURL(alias ? path.join(source, alias[1]) : file).href)
  const body = __iconNode.map(([tag, props]) => `<${tag} ${attrs(props)}/>`).join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>\n`
  fs.writeFileSync(path.join(out, `${name}.svg`), svg)
  written++
}
console.log(`wrote ${written} icons to ${path.relative(root, out)}`)
