# tools

Optional helpers. Nothing here is part of the app or the build - `electron-builder` only
packages `out/**`, so these are scripts you run yourself and point umakbang at.

## keydetect.py

A better musical key detector than the one built into umakbang, for anyone willing to
install Python. Wire it up in **Settings → Analysis → External key detector**:

```
C:\path\to\venv\Scripts\python.exe X:\cove\tools\keydetect.py "{file}"
```

Setup:

```bash
python -m venv keyenv
keyenv/Scripts/python -m pip install librosa
```

It analyses overlapping 20-second sections rather than averaging the whole track, corrects
for detuning first, scores each section against four key profiles (Krumhansl, Temperley,
Albrecht, and one tuned on electronic material), and combines them by weighted consensus.
`--verbose` prints confidence, section agreement and the runners-up on stderr.

### How good is it

Honestly: not good enough to trust blindly, and neither is the built-in one. Measured
against three files with known keys, both score 1/3 - but they get *different* ones right,
because this one's constant-Q front end reaches answers the built-in cannot (on one file
the correct key ranked 6th of 24 under the built-in scoring and first under this).

Three files is far too small a sample to choose between them or to tune anything. If you
want this made genuinely reliable, the missing ingredient is a validation set: twenty or
thirty files from the genres you actually work in, each with a key you trust. With that it
becomes possible to measure exact and MIREX-weighted accuracy and calibrate, rather than
swapping one chroma algorithm for another and hoping.

### What is deliberately missing

A neural key model - madmom's CNN is the strongest single component available - would very
likely beat both. It has no Windows build: madmom does not compile on Python 3.12, and
Essentia publishes no Windows wheels. Both install cleanly on Linux, so the routes are WSL
with a real distribution, or a container. Either is a bigger commitment than a pip install,
which is why this ships as the careful chroma half rather than a pretence at the ensemble.

## make-icons.js

Rebuilds `build/icon.png` and `build/icon.ico` from a square source image, rounding the
corners on the way:

```bash
npx electron tools/make-icons.js path/to/logo.png
```

Run under Electron rather than Node, because it needs a canvas and a hidden renderer is the
one already in the box - the alternative is an image dependency that would have to be
rebuilt per platform, which this project avoids everywhere else. `nativeImage.resize` can't
do it alone: rounding means drawing.

Every size is rendered from the full-resolution source rather than by downscaling the one
above it, so the 16px icon is as sharp as the corner radius allows. The `.ico` container is
assembled by hand - a header, one directory entry per image, then PNG payloads, which
Windows has read since Vista.
