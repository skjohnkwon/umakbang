/**
 * What changed, in the app rather than in a file nobody opens.
 *
 * A typed list rather than a parsed `CHANGELOG.md`: the renderer would have to be handed the
 * file's contents over IPC and then parse Markdown to draw it, and the only thing that buys
 * is the ability to write the entries somewhere else. Here they are typechecked, they ship
 * inside the bundle, and adding one is adding an object.
 *
 * Newest first. `version` matches the `package.json` version the entry shipped in, so the
 * Updates section can mark which one you are running.
 */

export interface ChangelogEntry {
  version: string
  /** ISO date, for a stable sort and a locale-formatted label. */
  date: string
  /** One line each, in the language of what it does rather than what was edited. */
  changes: string[]
}

export const CHANGELOG: readonly ChangelogEntry[] = [
  {
    version: '0.1.1',
    date: '2026-07-28',
    changes: [
      'Launch is about twelve times faster: the folder you left open is drawn before the rest of the index is read, and a scan that finds nothing changed now takes seconds rather than most of a minute.',
      'Tempo is read from the FL Studio project beside a bounce instead of guessed from the audio, so a finished track shows the number it was actually made at.',
      'Trim: drag a region on the transport waveform to loop it, and save that stretch as a new file beside the original.',
      'Volume slider on the speaker, with click still toggling mute.',
      'Notes column you can type straight into, saved with your tags and ratings.',
      'Copying a file copies the file, so it pastes into Discord or a folder rather than as a path.',
      'Tags: search them in the sidebar, rename one everywhere from its own right-click, pick from a list while typing, and more of them show on a row.',
      'Rating with 1-5 now rates what is playing rather than what happens to be selected, and the random button leans towards beats you have not rated.',
      'Stats counts tracks rather than files, leaves out the folders you excluded from the random button, and reads tempo from your projects.',
      'Colour follows the visualizer ramp through the stats charts, the ratings, and the BPM, key and date columns.',
      'A new folder button in the explorer, and clicking the row that is already playing restarts it instead of pausing.',
      'The mark in the title bar opens an About box, and this changelog lives under Settings, Updates.'
    ]
  }
]
