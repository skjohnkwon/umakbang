"""Scores key detectors against a labelled manifest.

Reports exact accuracy, MIREX weighted score, top-2 accuracy and accuracy per confidence
bucket, each with a bootstrap interval - because at thirty files a gap of 43% against 50%
is very often nothing at all, and a single number invites believing otherwise.

    python score.py manifest.csv --detector "path\\to\\python path\\to\\keydetect.py --json {file}"

A detector is any command printing one JSON object with at least `key`, and optionally
`confidence` and `alternatives`. Results are cached beside the manifest so re-scoring
doesn't re-analyse everything.
"""

from __future__ import annotations

import argparse
import csv
import json
import random
import statistics
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from keys import Key, mirex_score, parse, relation  # noqa: E402

CONFIDENCE_BUCKETS = [(0.0, 0.4), (0.4, 0.55), (0.55, 0.7), (0.7, 1.01)]


def load_manifest(path: Path) -> list[dict]:
    rows = []
    with path.open(encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            reference = parse(row.get("reference_key"))
            if reference is None:
                continue  # unlabelled rows are skipped, so labelling can be partial
            rows.append(
                {
                    "file": row["file"],
                    "reference": reference,
                    "certainty": (row.get("certainty") or "").strip().lower(),
                    "band": (row.get("band") or "").strip(),
                }
            )
    return rows


def run_detector(command: str, path: str, timeout: int) -> dict:
    filled = command.replace("{file}", path)
    try:
        proc = subprocess.run(
            filled, shell=True, capture_output=True, text=True, timeout=timeout
        )
    except subprocess.TimeoutExpired:
        return {}
    text = (proc.stdout or "").strip()
    if not text:
        return {}
    try:
        return json.loads(text)
    except ValueError:
        # A detector that just prints a key is still a detector.
        return {"key": text.splitlines()[0].strip()}


def bootstrap(values: list[float], rounds: int = 2000, seed: int = 7) -> tuple[float, float]:
    """95% interval for the mean. The honest width of a small sample."""
    if not values:
        return (0.0, 0.0)
    rng = random.Random(seed)
    means = []
    n = len(values)
    for _ in range(rounds):
        means.append(statistics.fmean(rng.choices(values, k=n)))
    means.sort()
    return (means[int(0.025 * rounds)], means[int(0.975 * rounds)])


def report(name: str, rows: list[dict], results: dict[str, dict]) -> None:
    exact: list[float] = []
    mirex: list[float] = []
    top2: list[float] = []
    by_bucket: dict[tuple[float, float], list[float]] = defaultdict(list)
    by_band: dict[str, list[float]] = defaultdict(list)
    relations: dict[str, int] = defaultdict(int)

    for row in rows:
        result = results.get(row["file"], {})
        predicted = parse(result.get("key"))
        reference: Key = row["reference"]

        hit = 1.0 if predicted == reference else 0.0
        exact.append(hit)
        mirex.append(mirex_score(predicted, reference))
        relations[relation(predicted, reference)] += 1

        alternatives = [parse(a[0] if isinstance(a, list) else a) for a in result.get("alternatives", [])]
        top2.append(1.0 if hit or (alternatives and alternatives[0] == reference) else 0.0)

        confidence = result.get("confidence")
        if isinstance(confidence, (int, float)):
            for bucket in CONFIDENCE_BUCKETS:
                if bucket[0] <= confidence < bucket[1]:
                    by_bucket[bucket].append(hit)
                    break
        if row["band"]:
            by_band[row["band"]].append(hit)

    n = len(rows)
    print(f"=== {name}  ({n} labelled files) ===")
    for label, values in (("exact", exact), ("MIREX", mirex), ("top-2", top2)):
        low, high = bootstrap(values)
        print(f"  {label:<7} {statistics.fmean(values):.3f}   95% CI [{low:.3f}, {high:.3f}]")

    print("  how the misses fail:")
    for kind, count in sorted(relations.items(), key=lambda kv: -kv[1]):
        print(f"     {kind:<12} {count}")

    if by_bucket:
        print("  accuracy by confidence bucket:")
        for bucket in CONFIDENCE_BUCKETS:
            values = by_bucket.get(bucket, [])
            if not values:
                continue
            print(
                f"     {bucket[0]:.2f}-{min(bucket[1], 1.0):.2f}  n={len(values):<3} "
                f"exact={statistics.fmean(values):.3f}"
            )
        print("  (calibration means these rise left to right; if they don't, the")
        print("   confidence is a diagnostic and not a probability)")

    if by_band:
        print("  accuracy by material:")
        for band, values in sorted(by_band.items(), key=lambda kv: -len(kv[1])):
            print(f"     {band:<11} n={len(values):<3} exact={statistics.fmean(values):.3f}")
    print()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument(
        "--detector",
        action="append",
        default=[],
        metavar="NAME=COMMAND",
        help="Repeatable. `{file}` becomes the path.",
    )
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--refresh", action="store_true", help="ignore the cache")
    args = parser.parse_args()

    rows = load_manifest(args.manifest)
    if not rows:
        print("no labelled rows in the manifest yet - fill in reference_key first")
        return 1

    low_certainty = sum(1 for r in rows if r["certainty"] == "low")
    print(f"{len(rows)} labelled files ({low_certainty} marked low certainty)")
    if len(rows) < 30:
        print("warning: below 30 files, treat every number here as indicative only")
    print()

    cache_path = args.manifest.with_suffix(".results.json")
    cache: dict[str, dict] = {}
    if cache_path.is_file() and not args.refresh:
        try:
            cache = json.loads(cache_path.read_text(encoding="utf-8"))
        except ValueError:
            cache = {}

    for spec in args.detector:
        name, _, command = spec.partition("=")
        if not command:
            print(f"skipping malformed --detector {spec!r}; expected NAME=COMMAND")
            continue
        results = cache.setdefault(name, {})
        for index, row in enumerate(rows, 1):
            if row["file"] in results:
                continue
            print(f"  [{name}] {index}/{len(rows)} {Path(row['file']).name[:48]}", end="\r")
            results[row["file"]] = run_detector(command, row["file"], args.timeout)
            cache_path.write_text(json.dumps(cache, indent=1), encoding="utf-8")
        print(" " * 78, end="\r")
        report(name, rows, results)

    if not args.detector:
        for name, results in cache.items():
            report(name + " (cached)", rows, results)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
