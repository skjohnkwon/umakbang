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
  fs.writeFileSync(icoPath, buildIco(ICO_SIZES.map((size) => ({ size, data: png(size) }))))
  console.log(`wrote ${icoPath} (${ICO_SIZES.join(', ')}px)`)

  window.destroy()
  app.exit(0)
}

/**
 * Assembles a .ico from PNG-encoded entries.
 *
 * The container is a six-byte header, a sixteen-byte directory entry per image, then the
 * images themselves. PNG payloads are read by Windows Vista and later, which is why there
 * is no BMP path here.
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
