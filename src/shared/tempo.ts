/**
 * What counts as a tempo a file is allowed to *declare*, shared by the probe and the
 * renderer.
 *
 * Nothing here is about detection - `lib/tempo.ts` works a tempo out from audio and reports
 * between 60 and 200 by construction. This is about the numbers files claim for themselves,
 * in an ACID chunk, an ID3 `TBPM` frame, an MP4 tempo atom or their own name, and those are
 * only as good as whatever wrote them.
 *
 * Measured on this library: of 49,872 audio files carrying a tempo, 57 sit outside this
 * window, and every one sampled was a one-shot - `HAT - REAL BOY.wav` at 346.06,
 * `CLAP - PARKS.wav` at 327, `raygun.wav` at 35.22. A hi-hat has no tempo; what these carry
 * is a loop chunk written by a sample-pack tool that divided a beat count by a length of a
 * third of a second. The old bound was 20 to 400, which is the range of numbers a float can
 * plausibly be rather than the range of tempos music is played at, so all of it was
 * believed - and it landed in the library's BPM column, in `bpm>` filters and across half
 * the width of the stats page's tempo chart.
 *
 * 220 rather than 200 because a declared tempo is a fact and should be given more room than
 * a guess: the fastest genuine readings here are drum & bass at 174 and a handful of tracks
 * named "200bpm", and 220 clears them with margin while excluding every one-shot found.
 */
const MIN_DECLARED_BPM = 40
const MAX_DECLARED_BPM = 220

/** True when a tempo read off a file is worth believing. */
export function plausibleBpm(value: number | undefined): value is number {
  return (
    value !== undefined &&
    Number.isFinite(value) &&
    value >= MIN_DECLARED_BPM &&
    value <= MAX_DECLARED_BPM
  )
}
