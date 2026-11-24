// Pixel comparison of two screenshots of the same size: a heat image of where they differ, and
// the share of differing pixels per region. Runs under Electron for its PNG decoder:
//   npx electron native/tools/compare.js <reference.png> <native.png> <diff.png>
const { app, nativeImage } = require('electron')
const fs = require('fs')

const REGIONS = {
  'title bar': [0, 0, 1360, 38],
  sidebar: [0, 38, 255, 860],
  'pane bar': [255, 38, 799, 68],
  table: [255, 68, 799, 658],
  transport: [255, 658, 799, 860],
  visualizers: [799, 38, 1360, 860]
}

// Not compared: the minimise/maximise/close buttons. A reference captured over the DevTools
// protocol is the page alone, and Windows draws the title bar overlay outside it.
const SKIP = [[1222, 0, 1360, 38]]

app.whenReady().then(() => {
  const [refPath, nativePath, outPath] = process.argv.slice(-3)
  const ref = nativeImage.createFromPath(refPath)
  const nat = nativeImage.createFromPath(nativePath)
  const { width, height } = ref.getSize()
  const a = ref.toBitmap()
  const b = nat.resize({ width, height }).toBitmap()
  const out = Buffer.alloc(width * height * 4)
  const tally = Object.fromEntries(Object.keys(REGIONS).map((k) => [k, { differ: 0, total: 0, sum: 0 }]))
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]))
      // The reference, dimmed, with differences painted red over it by how large they are.
      const base = (a[i] + a[i + 1] + a[i + 2]) / 9
      const heat = Math.min(255, d * 3)
      out[i] = base * (1 - heat / 255)
      out[i + 1] = base * (1 - heat / 255)
      out[i + 2] = Math.min(255, base + heat)
      out[i + 3] = 255
      if (SKIP.some(([x0, y0, x1, y1]) => x >= x0 && x < x1 && y >= y0 && y < y1)) continue
      for (const [name, [x0, y0, x1, y1]] of Object.entries(REGIONS)) {
        if (x >= x0 && x < x1 && y >= y0 && y < y1) {
          const t = tally[name]
          t.total++
          t.sum += d
          if (d > 24) t.differ++
        }
      }
    }
  }
  fs.writeFileSync(outPath, nativeImage.createFromBitmap(out, { width, height }).toPNG())
  for (const [name, t] of Object.entries(tally)) {
    console.log(`${name.padEnd(12)} ${((t.differ / t.total) * 100).toFixed(2).padStart(6)}% of pixels differ visibly, mean difference ${(t.sum / t.total).toFixed(2)}`)
  }
  app.quit()
})
