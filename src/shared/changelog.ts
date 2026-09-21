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
    version: '0.3.0',
    date: '2026-09-21',
    changes: [
      'Favourite forty plugins at once. FL offers it one plugin at a time, which is fine for the one you just installed and miserable for the forty you have had for a year. Settings, Plugins opens a manager with the scan on one side and your favourites on the other: search it, narrow it by format, select a run and move the lot across. It refuses to write while FL is open and says so before you pick anything, because FL rewrites that database when it quits and would throw the change away.',
      'A plugin can be more than one format, and is now filed under every one it was found in. 63 of the 606 here were kept under only the first, so filtering to VST3 hid plugins that had a VST3.',
      'Your settings follow you between machines. Each one records when its own settings last changed, that stamp travels with them, and the newest wins - so there is no machine to elect as the authority and nothing to configure. It happens on launch, with a button for when you want it sooner.',
      'Folders are deliberately left out of that. A path names a place on a disk, and the disk is the thing two machines do not share, so a downloads folder arriving from the other computer could only ever be wrong - and because those settings are filled in only when empty, it would have stayed wrong for good. Any that already arrived are mended.',
      'Another machine is a Devices section under Folders, grouped by the computer serving it, rather than a row in the folder tree indistinguishable from a folder on this disk. It is out of the Folders menu too, where it used to be listed among your own folders as something to remove.',
      'The library count and the whole Stats page are about your own music again. Mounting another machine was adding its files to the list behind both, so a third of a million files quietly joined your library and every figure on a page about your own work answered for two people at once.',
      'Packing a project brings the audio FL consolidated for it. Those tracks are recorded as a variable rather than a path, so they did not look like library files and were left out - one project here packed fifteen samples and silently dropped four tracks of its own audio, under a note saying they were "factory content, most likely".',
      'Stats can be switched off in Settings, Pages, which takes its sidebar entry with it and stops anything being computed for it.',
      'The library dropdown is gone from the title bar. Everything in it is reachable without it: the plus in the sidebar adds a folder, a right-click on a folder removes it, and Rescan Library is in the application menu beside the other library-wide actions.'
    ]
  },
  {
    version: '0.2.0',
    date: '2026-09-21',
    changes: [
      'Your other machine\'s library, in this window. Link a computer under Settings, Remote and its folders appear in the sidebar beside your own - browse them, search them, play from them, scrub them. Nothing is copied to get there: the audio streams as you listen, and a library of 327,000 files opens in about a second because the other machine sends what it already knows rather than being walked over the network.',
      'A library on another machine is read-only, and looks it. Everything that would change a file is simply absent from the menu rather than greyed out, because it is not a thing you can do here rather than a thing you cannot do yet.',
      'Copy anything over with one click, at about 26 MB/s - a 104MB pack in under four seconds. Files arrive as several pieces at once over one pooled connection, which on a link with any distance in it is the difference between that and two minutes. Every file is checked against the original before it takes its name, so a copy is either right or it is not there.',
      '"Pack & copy" on a project brings the beat and every sample it plays, flat inside a zip - the same shape as FL\'s own loop packages, and the shape that opens anywhere. Samples recorded under a drive letter that was reassigned years ago are found anyway.',
      'It says which plugins you are missing before you pack, not after you have opened the project and saved over its settings. Settings, Plugins compares what FL has found on each machine, both directions, so you can also see what the other one would be missing from you.',
      'Archives are part of the library now. `.zip` and `.rar` files are listed, searched and counted like anything else - 872 of them here that the explorer had never shown - and "Extract here" unpacks one into a folder beside it.',
      'Every FL project reads to the end. Two events in the format carry more bytes than the rule says, and a walk that believed the rule lost its place at the first one - measured across 2,796 projects here, it now reaches the end of all of them, which is what makes packing a project trustworthy at all.',
      'Refresh takes away what is gone. A file deleted outside umakbang used to dim and stay dimmed until a full rescan; asking for a re-read now settles it, while the background watcher still only dims - it cannot tell a deleted file from a folder it could not open.',
      'Video exports come out the right length. A thirty second reel was writing twelve seconds of picture against thirty of sound - two and a half times speed, then a frozen frame for the rest - because the recorder built into the browser muxes frames as they arrive and drops whatever it cannot keep up with. They are encoded now rather than recorded, so a thirty second project is nine hundred frames over exactly thirty seconds, and it renders about four times faster than real time.',
      'Export is a button in the editor header with a dialog behind it, carrying the percentage while it runs so you can close it and come back. Each project keeps a list of what it has exported, and reveals any of them in the file manager.',
      'YT2MP3, in the sidebar: paste a link and get the audio as a file. It describes what it found - title, length, thumbnail - before fetching anything, and the MP3 is made here rather than by another program you would have to install.',
      'Splitting stems works again. The shipped default was a model the service refuses for every stem it offers, so a fresh install could not separate anything, and the explanation sent back by the service was being turned into `[object Object]` on the way to the notice. Stems also appear in the library as soon as they land instead of waiting for a rescan.',
      'Starting is about three times quicker to the first row - the scanner is now started alongside the window rather than after it, and the metadata cache is read when something first needs it rather than before anything can happen.',
      'The first launch shows you round: seven steps, about twenty seconds, pointing at the real thing each one describes. It runs itself and Skip or Escape ends it for good.',
      'Selecting two tags now narrows rather than widens, and the number on each chip is how many files clicking it would leave - a chip that would empty the list is faded rather than something to find out by pressing.',
      'Your tags, ratings and notes are snapshotted five minutes after you stop changing them, so a bad write costs minutes rather than a day.',
      'Your machines are listed under Settings, Developer, Tailnet, with what each is serving and what it has been asked for.'
    ]
  },
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
