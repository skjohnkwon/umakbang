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
    version: '0.1.2',
    date: '2026-07-29',
    changes: [
      'Videos: make the reel without leaving umakbang. Right-click a beat and pick "Make video…", or open Videos in the sidebar. Build the post out of layers - the screen capture cropped and zoomed to the part of the playlist you want on screen, a waveform or spectrum driven by the track itself, artwork, captions - and export MP4 at 9:16, 4:5, 1:1 or 16:9, which is what Instagram and TikTok take. No ffmpeg and nothing else to install: the encoder is the one already inside the app.',
      'The built-in screen recorder takes a monitor or just your DAW\'s window, with what the machine is playing and a microphone, and captures the webcam as its own separate file - so where the face-cam sits is decided afterwards while you look at the beat, rather than burned in at the one moment nobody is thinking about framing.',
      'Recordings and exports seek properly everywhere - Windows Media Player, a DAW\'s video track, anything - because each one is re-indexed on the way out. The browser\'s own recorder writes a file that plays start to finish and cannot be scrubbed at all.',
      'A timeline under the frame, with one row per layer, draggable clip bodies and trim edges, and a Split & shuffle that chops a clip into pieces and reorders them without changing how long it runs. Presets set up the two shapes a reel usually takes.',
      'Undo, at last: Ctrl+Z takes back a move, a copy, a rename or a new folder, and Ctrl+Y or Ctrl+Shift+Z puts it forward again. Ratings, tags and notes follow the files back. A file that something else has written to since is left where it is and reported rather than quietly reversed, and how many operations Undo steps back through is yours to set in Settings.',
      'Accented and non-English file names keep their tags, ratings, notes and detected tempo. Windows and macOS write a name like ÁNDALE.mp3 as two different sequences of characters, and umakbang was filing them as two different files - so a library carried to the other machine came back untagged. Existing files are repaired the first time they are read.',
      'The keys umakbang invented - play/pause, the dice, tagging, rename, up, delete, clear selection - can be rebound in Settings, Shortcuts. The traditional Ctrl chords deliberately cannot: they arrive with the system and every other application agrees about them.',
      'Copy, cut, paste, duplicate and select-all work wherever you are in the explorer instead of only while the file list has focus - pressing the dice used to move focus off the list and leave them dead. Ctrl/Cmd+Enter also renames, for a keyboard where F2 costs an fn.',
      'Choose which output the sound plays through, in Settings. An interface that has been unplugged is named as missing rather than falling back to the system default as though you had picked it.',
      'Deleting says what it is about to take with it: how many files, how much disk, what is underneath a folder, and how many of those you rated four stars or tagged.',
      'A file moved or deleted outside umakbang now dims in place instead of vanishing from the list. Its rating, tags and note are still there to read, a row no longer disappears from under the pointer, and an unplugged drive or a permission error stops emptying a whole folder in silence.',
      'Drag the line under the tag chips to trade room between your tags and the folder tree, and double-click it to put it back. The tag strip was capped at three lines however many tags you had.',
      '"New folder with these items" in the right-click menu, named after the beat it gathers, and names Windows cannot really use - CON, NUL, com1, or one over 255 characters - are refused with a sentence instead of making a file the rest of the machine cannot open.',
      'One headroom setting for the visualizers, shared by the explorer and the video editor. The sidebar starts with Files, and Downloads is a Quick access pin you can remove.'
    ]
  },
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
