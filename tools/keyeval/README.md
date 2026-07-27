# keyeval

Measuring key detectors, so a change can be shown to help rather than assumed to.

This exists because two detectors both scored 1/3 on three files while getting *different*
files right, and there was no way to tell which was better. Three files cannot answer that.
Nothing here tunes anything; it is the apparatus that has to come first.

## Workflow

**1. Propose a set.** Draws from umakbang's own saved index, stratified across duration
bands and across top-level folders, so the set isn't thirty near-identical beats from one
production run.

```bash
python sample.py --count 60 --out manifest.csv
```

Bands are `song`, `short-song`, `loop`, `phrase` and `one-shot`. One-shots are included
sparingly as a control: they have no key, so a detector that confidently names one is
telling you something about its confidence.

**2. Label it by hand.** Fill in `reference_key` (any spelling - `G#m`, `Ab minor` and
`G# minor` all parse to the same key), `source`, and `certainty` as high/medium/low.

Rows left blank are skipped, so labelling can be done in batches. Mark anything doubtful as
`low` rather than guessing: a wrong reference penalises a detector for being right, and
TuneBat is a starting point rather than ground truth. Worth verifying the ambiguous ones
against a second source or by ear before trusting them.

Aim for 30 at an absolute minimum, 50–100 to actually decide anything.

`manifest.csv` is gitignored and stays that way. It is a list of absolute paths into the
library of whoever ran it, song titles and folder names included, and it is worth nothing to
anybody else - those paths don't exist on their machine. Regenerate it with `sample.py`
rather than looking for a committed one.

**3. Score.** `{file}` must be quoted - library paths have spaces in them.

```bash
python score.py manifest.csv \
  --detector 'cqt=python ../keydetect.py --json "{file}"' \
  --detector 'builtin=your-other-command "{file}"'
```

A detector is any command printing JSON with at least `key`, optionally `confidence` and
`alternatives`. Results are cached beside the manifest, so adding labels later only
analyses the new rows.

## What it reports

Exact accuracy, MIREX weighted score, top-2 accuracy, and accuracy per confidence bucket -
each with a bootstrap 95% interval, and a breakdown of *how* the misses fail (dominant,
relative, parallel, unrelated), which is more informative than the score.

The first run against three labelled files produced:

```
exact   0.333   95% CI [0.000, 1.000]
MIREX   0.500   95% CI [0.000, 1.000]
top-2   0.667   95% CI [0.000, 1.000]
misses: 1 exact, 1 dominant, 1 unrelated
confidence 0.40-0.55  n=1  exact=1.000
confidence 0.55-0.70  n=2  exact=0.000
```

Which says: the interval spans the entire range, so the number means nothing yet; top-2 is
meaningfully better than exact, so the right answer is often the runner-up; and the
confidence buckets run *backwards*, so the confidence is a diagnostic and not a
probability. All three are reasons to collect labels before changing anything.

## Self-consistency, which needs no labels

A library that holds both a master and its MP3 already contains pairs of the same
performance. Any disagreement between the two is the detector contradicting *itself*, so it
bounds accuracy from above without anyone labelling anything - and it can be run today,
against hundreds of pairs, while the hand-labelled set is still being built.

```bash
npx esbuild tools/keyeval/consistency.ts --bundle --platform=node \
  --alias:@=./src/renderer/src --outfile=consistency.js
node consistency.js "Z:\SAMPLES" 60
```

It imports the real `detectKey`, so it measures what ships. Files are paired by folder and
by name with the usual bounce suffixes (`_Master`, `final`, `v2`) stripped, and a pair whose
two durations differ by more than two seconds is dropped as two different renders rather
than one track in two containers.

It reports agreement two ways, and the gap between them is the point: **identical key** is
how often the detector picked the same one of the 24, and **same on screen** is how often
the user would see the same thing - relative-pair display (`C/Am`) absorbs a major/relative-
minor flip, which is the most common way the two answers differ. On a 40-pair sample: 90%
identical, 95% same on screen.

Disagreements come with both margins, and they are the cheapest source of hard cases there
is. `INFINITY_Master.wav` against `INFINITY.mp3` is the one that prompted this: Em at 0.612
against Am at 0.591 on the master, Am at 0.613 against Em at 0.581 on the MP3. The music is
in Am. The chroma of the two files differs by less than one point in total across all twelve
classes, and that is enough to swap first and second place - so this is not a format bug to
be fixed but a tie to be broken, and breaking it is a change that has to be measured against
labels rather than argued for from one track.

## Candidate detectors, measured before adopting

`variants.ts` scores candidate changes on the same pairs. It shares the chroma frames
between variants, so adding one costs correlation arithmetic rather than another decode.

```bash
npx esbuild tools/keyeval/variants.ts --bundle --platform=node \
  --alias:@=./src/renderer/src --outfile=variants.js
node variants.js "Z:\SAMPLES" 70
```

It exists because of a near miss. TuneBat states it is "powered by industry leading
technology developed by the Music Technology Group at UPF" - that is Essentia, and
`essentia.js` is its WebAssembly build, which is how it runs in a browser. The obvious move
is to graft the separable pieces of that approach onto `key.ts`: the EDMA profile, folding
frames by median instead of by accumulated magnitude, picking spectral peaks instead of
summing every bin.

On `INFINITY_Master.wav` - the track that prompted this, where the master reads Em and its
MP3 reads Am - *every one of those changes fixed it*, and with margins three to ten times
the 0.0013 the shipping detector wins by. Adopting them looked obviously right.

Over 69 pairs it evaporates:

```
  variant                    identical      same on screen   median margin
  peaks + median + EDMA      65/69 (94%)    66/69 (96%)      0.0059
  median frames + KK         64/69 (93%)    65/69 (94%)      0.0037
  equal-weight + EDMA        64/69 (93%)    65/69 (94%)      0.0052
  SHIPPING raw + KK          63/69 (91%)    65/69 (94%)      0.0043
  raw + EDMA                 62/69 (90%)    63/69 (91%)      0.0047
  ...
  equal-weight frames + KK   59/69 (86%)    64/69 (93%)      0.0040
  median + EDMA              58/69 (84%)    63/69 (91%)      0.0054
```

Nothing separates from the shipping detector - two pairs out of 69 is noise, and
`equal-weight frames`, which fixed the motivating track by the widest margin of any single
change, lands second from bottom. Whatever makes Essentia better is the whole HPCP front end
— tuning estimation, harmonic weighting, interpolated spectral peaks, band-wise
normalisation - and not any one ingredient that can be bolted on. Half-porting it is
measurably not worth doing.

So the choice is the real library or nothing. `essentia.js` is **AGPL-3.0**: for one install
that is never handed to anybody, copyleft never triggers; ship the installer to someone else
and umakbang has to be AGPL-3.0 too, or carry a commercial licence from MTG. Lifting
TuneBat's own minified bundle is neither - that is their build, and it is strictly worse
than taking the library from source.

## Before adding a neural model

Fix the dataset and the split first, then don't touch either:

- 70% development, 30% untouched test. With only 30 files use repeated cross-validation
  rather than trusting one split.
- Score the existing detectors on the frozen set.
- Only then set up WSL or a container for madmom's CNN - neither it nor Essentia has a
  Windows build.
- Keep the CNN only if it improves the untouched test score, or materially improves top-2
  and calibration.

Fit any combiner on logged features rather than on final confidences. `keydetect.py --json`
emits them: primary score, margin to the runner-up, section agreement, section count,
relative-major/minor ambiguity, profile agreement, tuning offset, and how many distinct
keys the sections chose. A logistic regression is enough; the point is that it is fitted to
data rather than to somebody's guess about weights - which is precisely how a bass-energy
tie-break got added earlier and had to be removed for making things worse.
