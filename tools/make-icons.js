/**
 * Builds `build/icon.png` and `build/icon.ico` from a square source image, with the corners
 * rounded.
 *
 * Run under Electron rather than plain Node:
 *
 *     npx electron tools/make-icons.js <source.png>
 *
 * It needs a canvas, and a hidden renderer is the one already in the box - the alternative
 * is an image dependency that would have to be rebuilt per platform, which this project
 * avoids everywhere else. `nativeImage.resize` alone can't do it: rounding means drawing.
 *
 * Every size is rendered from the full-resolution source rather than by downscaling the
 * previous one, so the 16px icon is as sharp as the corner radius allows instead of a
 * blurred 1024.
 */

const { app, BrowserWindow, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const SOURCE = process.argv[2]
const OUT_DIR = path.join(__dirname, '..', 'build')

/** What goes in the .ico. 256 is the largest Windows reads from one. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
/** What electron-builder renders the other platforms' icons from. */
const MASTER_SIZE = 1024

/**
 * Corner radius as a share of the icon's width.
 *
 * 18% sits between a Windows tile and a macOS squircle: enough to read as rounded at
 * 256px, not so much that the 16px version loses its corners to the rounding itself.
 */
const RADIUS_RATIO = 0.18

async function main() {
  if (!SOURCE || !fs.existsSync(SOURCE)) {
    console.error('usage: npx electron tools/make-icons.js <source.png>')
    app.exit(1)
    return
  }

  const source = nativeImage.createFromPath(SOURCE)
  if (source.isEmpty()) {
    console.error('could not read', SOURCE)
    app.exit(1)
    return
  }
  const { width, height } = source.getSize()
  console.log(`source: ${width}x${height}`)

  const window = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  await window.loadURL('data:text/html,<body></body>')

  const dataUrl = source.toDataURL()
  const sizes = [...new Set([...ICO_SIZES, MASTER_SIZE])].sort((a, b) => a - b)

  const rendered = await window.webContents.executeJavaScript(`
    (async () => {
      const image = new Image()
      image.src = ${JSON.stringify(dataUrl)}
      await image.decode()

      const out = {}
      for (const size of ${JSON.stringify(sizes)}) {
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d')
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = 'high'

        // Clip first, then draw: the alpha outside the shape is never written, so the
        // corners are transparent rather than blended against a background.
        const radius = Math.round(size * ${RADIUS_RATIO})
        ctx.beginPath()
        ctx.roundRect(0, 0, size, size, radius)
        ctx.clip()

        // Cover, in case the source is not exactly square.
        const scale = Math.max(size / image.width, size / image.height)
        const w = image.width * scale
        const h = image.height * scale
        ctx.drawImage(image, (size - w) / 2, (size - h) / 2, w, h)

        out[size] = canvas.toDataURL('image/png')
      }
      return out
    })()
  `)

  const png = (size) => Buffer.from(rendered[size].split(',')[1], 'base64')

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const masterPath = path.join(OUT_DIR, 'icon.png')
  fs.writeFileSync(masterPath, png(MASTER_SIZE))
  console.log(`wrote ${masterPath} (${MASTER_SIZE}px, ${(fs.statSync(masterPath).size / 1024).toFixed(0)} KB)`)

  const icoPath = path.join(OUT_DIR, 'icon.ico')
  fs.writeFileSync(
    icoPath,
    buildIco(ICO_SIZES.map((size) => ({ size, data: size >= 256 ? png(size) : dib(png(size), size) })))
  )
  console.log(`wrote ${icoPath} (${ICO_SIZES.join(', ')}px)`)

  window.destroy()
  app.exit(0)
}

/**
 * An icon entry as a classic 32bpp DIB: BITMAPINFOHEADER, bottom-up BGRA rows, then an
 * all-clear AND mask, with the header's height doubled to cover both - which is how an icon
 * DIB is laid out.
 *
 * Everything under 256px goes this way, and that is not a matter of taste. The .ico used to
 * carry PNG at every size, on the grounds that Windows has read PNG entries since Vista. It
 * does in a loose .ico file, and the window icon Electron loads did fine with it - but once
 * stamped into the exe, the shell's own extraction (the taskbar, a pinned shortcut, Explorer,
 * `app.getFileIcon`) could not use the small PNG entries and drew the generic application
 * frame instead. Measured: the same exe re-stamped with these entries as DIBs shows the logo.
 * The 256px entry stays PNG, which is the one size Windows expects compressed.
 */
function dib(png, size) {
  // BGRA, premultiplied - which an icon DIB is not, so each pixel is divided back out.
  const bitmap = nativeImage.createFromBuffer(png).toBitmap()
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0) // header size
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8) // colour rows plus mask rows
  header.writeUInt16LE(1, 12) // planes
  header.writeUInt16LE(32, 14) // bits per pixel
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4
      const to = ((size - 1 - y) * size + x) * 4 // bottom-up
      const alpha = bitmap[from + 3]
      const straight = (c) => (alpha === 0 ? 0 : Math.min(255, Math.round((c * 255) / alpha)))
      pixels[to] = straight(bitmap[from])
      pixels[to + 1] = straight(bitmap[from + 1])
      pixels[to + 2] = straight(bitmap[from + 2])
      pixels[to + 3] = alpha
    }
  }
  // The alpha channel does the masking; the AND mask is still required, and all clear.
  const maskRow = Math.ceil(size / 32) * 4
  return Buffer.concat([header, pixels, Buffer.alloc(maskRow * size)])
}

/**
 * Assembles a .ico: a six-byte header, a sixteen-byte directory entry per image, then the
 * images themselves - DIBs below 256px and PNG at 256 (see `dib`).
 */
function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // 1 = icon
  header.writeUInt16LE(entries.length, 4)

  const directory = Buffer.alloc(16 * entries.length)
  let offset = header.length + directory.length

  entries.forEach((entry, index) => {
    const at = index * 16
    // 0 means 256 in this field, which is why it is a single byte.
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, at)
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, at + 1)
    directory.writeUInt8(0, at + 2) // palette size, 0 for truecolour
    directory.writeUInt8(0, at + 3) // reserved
    directory.writeUInt16LE(1, at + 4) // colour planes
    directory.writeUInt16LE(32, at + 6) // bits per pixel
    directory.writeUInt32LE(entry.data.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += entry.data.length
  })

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.data)])
}

app.whenReady().then(main)
