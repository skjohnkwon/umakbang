// The same region of two screenshots, enlarged side by side (reference left, native right):
//   npx electron native/tools/zoom.js <reference.png> <native.png> <out.png> <x> <y> <w> <h> [scale]
const { app, nativeImage } = require('electron')
const fs = require('fs')

app.whenReady().then(() => {
  const args = process.argv.slice(-8)
  const [refPath, nativePath, outPath] = args
  const [x, y, w, h, scale] = args.slice(3).map(Number)
  const crop = (path) =>
    nativeImage.createFromPath(path).crop({ x, y, width: w, height: h }).resize({ width: w * scale, height: h * scale, quality: 'good' }).toBitmap()
  const a = crop(refPath)
  const b = crop(nativePath)
  const W = w * scale * 2 + 4
  const H = h * scale
  const out = Buffer.alloc(W * H * 4, 255)
  for (let row = 0; row < H; row++) {
    a.copy(out, row * W * 4, row * w * scale * 4, (row + 1) * w * scale * 4)
    b.copy(out, (row * W + w * scale + 4) * 4, row * w * scale * 4, (row + 1) * w * scale * 4)
  }
  fs.writeFileSync(outPath, nativeImage.createFromBitmap(out, { width: W, height: H }).toPNG())
  app.quit()
})
