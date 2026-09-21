/**
 * Unpacking an archive, using what the operating system already has.
 *
 * No library and no native module, which is the same rule the rest of the app follows: the
 * encoder is the one already in Electron, the icons come from the shell, and a zip is
 * unpacked by the thing every machine already unpacks zips with. `unzip` ships with macOS
 * and every Linux worth the name; Windows has had `Expand-Archive` in PowerShell since 5.0.
 *
 * Only `.zip`. `.rar` and `.7z` need a tool that is not on a stock machine, and an action
 * that works on some archives and silently fails on others is worse than one that is only
 * offered where it works.
 */

import { execFile } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Extraction of a large archive is not quick, but it is not unbounded either. */
const EXTRACT_TIMEOUT_MS = 10 * 60_000

export function canExtract(path: string): boolean {
  return extname(path).toLowerCase() === '.zip'
}

/**
 * A folder beside the archive that nothing else is using.
 *
 * `stems.zip` unpacks into `stems/`. If that name is taken - very often it is, because the
 * folder it came from is still sitting there - the copy is numbered rather than merged into
 * whatever is already there.
 */
async function freeDir(archive: string): Promise<string> {
  const parent = dirname(archive)
  const stem = archive.slice(parent.length + 1, archive.length - extname(archive).length)
  let candidate = join(parent, stem)
  for (let n = 2; ; n++) {
    try {
      await stat(candidate)
    } catch {
      return candidate
    }
    candidate = join(parent, `${stem} (${n})`)
  }
}

/**
 * Zips a folder's *contents*, so the archive opens flat.
 *
 * Flat is the whole point: FL finds a project's samples by looking in the folder the
 * project is in, so a zip whose entries are nested one folder deep unpacks into something
 * that cannot find its own sounds. FL's own loop packages put every file at the root of the
 * archive, and this matches them.
 */
export async function zipDir(dir: string, target: string): Promise<string | null> {
  try {
    if (process.platform === 'win32') {
      await run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Compress-Archive -LiteralPath ${quotePs(join(dir, '*'))} -DestinationPath ${quotePs(target)} -Force`
        ],
        { timeout: EXTRACT_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
      )
    } else {
      // `-r .` from inside the folder, so entries are named `beat.flp` rather than
      // `beat/beat.flp`. `-X` leaves out the resource forks macOS would otherwise add.
      await run('zip', ['-q', '-r', '-X', target, '.'], {
        cwd: dir,
        timeout: EXTRACT_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024
      })
    }
    return null
  } catch (error) {
    return `Could not zip it: ${describe(error)}`
  }
}

export interface ExtractResult {
  /** Where it landed. Absent when it did not. */
  dir?: string
  /** Already phrased for a person. */
  error?: string
}

export async function extractArchive(archive: string): Promise<ExtractResult> {
  if (!canExtract(archive)) {
    return { error: 'Only .zip archives can be unpacked here.' }
  }

  let target: string
  try {
    target = await freeDir(archive)
    await mkdir(target, { recursive: true })
  } catch (error) {
    return { error: `Could not make a folder for it: ${(error as Error).message}` }
  }

  try {
    if (process.platform === 'win32') {
      // `-LiteralPath`, because a bare `-Path` treats `[` and `]` as wildcards and a sample
      // pack named `[FREE] Kit` would not be found at all.
      await run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Expand-Archive -LiteralPath ${quotePs(archive)} -DestinationPath ${quotePs(target)} -Force`
        ],
        { timeout: EXTRACT_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
      )
    } else {
      // `-o` overwrites without asking, which matters because the folder was just made and
      // nothing can be in it - a prompt here would hang the process forever with no window
      // to answer it in.
      await run('unzip', ['-q', '-o', archive, '-d', target], {
        timeout: EXTRACT_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024
      })
    }
  } catch (error) {
    return { error: `Could not unpack it: ${describe(error)}` }
  }

  return { dir: target }
}

/** Single quotes, doubled to escape - PowerShell's own rule. */
function quotePs(value: string): string {
  return `'${value.split("'").join("''")}'`
}

function describe(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr
  if (stderr) return stderr.trim().split('\n')[0]
  return (error as Error).message
}
