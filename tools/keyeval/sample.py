"""Proposes a validation set, spread across the material actually in the library.

Reads umakbang's own saved index rather than walking the disk: it already holds every
indexed file with its probed duration, which is what the strata are built from.

The point is to avoid the failure mode where a set is thirty near-identical beats from one
production run. Files are drawn across duration bands and across top-level folders, with a
cap per combination, so no single corner of the library dominates.

    python sample.py --count 60 --out manifest.csv

Then fill in `reference_key` by hand. Leave rows blank and they are simply skipped by the
scorer, so it is fine to label in batches.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import random
from collections import defaultdict
from pathlib import Path

# Bands chosen to separate the kinds of material that behave differently, not by even
# spacing: a 4-bar loop and a 3-minute song are different problems for a key detector.
BANDS: list[tuple[str, float, float]] = [
    ("song", 120.0, 1e9),
    ("short-song", 45.0, 120.0),
    ("loop", 8.0, 45.0),
    ("phrase", 3.0, 8.0),
    # Included deliberately and sparingly: these have no key to find, and a detector that
    # confidently names one is telling you something about its confidence.
    ("one-shot", 0.0, 3.0),
]

# How many of the set may come from each band. One-shots are a control, not a third of it.
BAND_SHARE = {"song": 0.34, "short-song": 0.22, "loop": 0.26, "phrase": 0.12, "one-shot": 0.06}

PLAYABLE = {"wav", "mp3", "flac", "aiff", "aif", "m4a", "ogg", "opus", "wave"}


def default_index() -> Path | None:
    root = Path(os.environ.get("APPDATA", "")) / "umakbang"
    if not root.is_dir():
        return None
    found = sorted(root.glob("umakbang-index-*.ndjson"), key=lambda p: p.stat().st_size)
    return found[-1] if found else None


def band_of(duration: float) -> str | None:
    for name, low, high in BANDS:
        if low <= duration < high:
            return name
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index", type=Path, default=None, help="umakbang-index-*.ndjson")
    parser.add_argument("--count", type=int, default=60)
    parser.add_argument("--per-folder", type=int, default=3, help="cap per folder per band")
    parser.add_argument("--seed", type=int, default=20260726)
    parser.add_argument("--out", type=Path, default=Path("manifest.csv"))
    args = parser.parse_args()

    index = args.index or default_index()
    if not index or not index.is_file():
        print("no index found; pass --index")
        return 1

    random.seed(args.seed)
    buckets: dict[tuple[str, str], list[dict]] = defaultdict(list)

    with index.open(encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                track = json.loads(line)
            except ValueError:
                continue
            if track.get("ext") not in PLAYABLE:
                continue
            duration = track.get("duration")
            if not isinstance(duration, (int, float)):
                continue
            band = band_of(float(duration))
            if band is None:
                continue
            # Top-level folder is a good proxy for "a different kind of material".
            top = (track.get("relDir") or "").split("/")[0] or "(root)"
            buckets[(band, top)].append(track)

    if not buckets:
        print("index held nothing with a probed duration")
        return 1

    chosen: list[dict] = []
    for band, _low, _high in BANDS:
        want = max(1, round(args.count * BAND_SHARE.get(band, 0.0)))
        folders = [key for key in buckets if key[0] == band]
        random.shuffle(folders)

        picked: list[dict] = []
        # Round-robin over folders so one big folder can't fill the band on its own.
        for depth in range(args.per_folder):
            for key in folders:
                if len(picked) >= want:
                    break
                pool = buckets[key]
                if len(pool) > depth:
                    picked.append(random.choice(pool))
            if len(picked) >= want:
                break
        chosen.extend(picked[:want])

    # Stable, de-duplicated, and shuffled so labelling order isn't correlated with band.
    seen: set[str] = set()
    unique = []
    for track in chosen:
        path = track.get("path")
        if not path or path in seen:
            continue
        seen.add(path)
        unique.append(track)
    random.shuffle(unique)

    with args.out.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["file", "reference_key", "source", "certainty", "notes", "band", "seconds"])
        for track in unique:
            writer.writerow(
                [track["path"], "", "", "", "", band_of(float(track["duration"])), round(float(track["duration"]), 1)]
            )

    counts: dict[str, int] = defaultdict(int)
    for track in unique:
        counts[band_of(float(track["duration"])) or "?"] += 1

    print(f"wrote {len(unique)} rows to {args.out}")
    for band, _low, _high in BANDS:
        print(f"  {band:<11} {counts.get(band, 0)}")
    print()
    print("Fill in reference_key (e.g. 'G# minor'), source (TuneBat/manual), certainty")
    print("(high/medium/low). Rows left blank are skipped, so labelling can be done in")
    print("batches. Mark anything you are unsure of as low rather than guessing - a wrong")
    print("label penalises a detector for being right.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
