// Copies the Electron app's changelog (src/shared/changelog.ts) into assets/changelog.json, so
// Settings → Updates lists the same entries without a second copy to keep by hand.
import { readFileSync, writeFileSync } from 'node:fs'
const source = readFileSync(new URL('../../src/shared/changelog.ts', import.meta.url), 'utf8')
const start = source.indexOf('[', source.indexOf('export const CHANGELOG'))
const list = new Function(`return ${source.slice(start).replace(/\]\s*(as const)?\s*;?\s*$/, ']')}`)()
writeFileSync(new URL('../assets/changelog.json', import.meta.url), JSON.stringify(list, null, 1))
console.log(`wrote ${list.length} entries`)
