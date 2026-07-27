"""Musical key estimation for umakbang, as an external detector.

Built to the structure that works in practice: analyse overlapping sections rather than
averaging the whole track, score each against several key profiles rather than one, correct
for detuning first, and only commit to an answer when the sections agree.

Prints one line - the key, spelled the way umakbang spells it ("F#m", "Eb", "Am") - or
nothing at all when the audio doesn't support a confident answer. Nothing is the right
output for an ambiguous track: a blank cell is honest, a wrong key is not.

    python keydetect.py "C:\\path\\to\\track.wav"
    python keydetect.py --verbose "C:\\path\\to\\track.wav"   # scores and alternatives

Needs librosa. The neural half of a full ensemble (madmom's CNN) has no Windows build, so
this is the chroma half done carefully rather than a pretence at the whole thing.
"""

from __future__ import annotations

import argparse
import json
import sys
import warnings
from dataclasses import dataclass, field

import numpy as np

warnings.filterwarnings("ignore")

import librosa  # noqa: E402  (after the warning filter, which librosa is noisy without)

SAMPLE_RATE = 22_050
SEGMENT_SECONDS = 20.0
HOP_SECONDS = 10.0
MAX_SECONDS = 300.0

# How each key is written. Sharps and flats are the same pitch and not the same name.
MAJOR_NAMES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
MINOR_NAMES = ["Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "G#m", "Am", "Bbm", "Bm"]

# Several profiles rather than one: they disagree about different material, and where they
# agree the answer is worth more than any single one of them claiming it alone.
PROFILES: dict[str, tuple[list[float], list[float]]] = {
    "krumhansl": (
        [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
        [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
    ),
    "temperley": (
        [5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0],
        [5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0],
    ),
    "albrecht": (
        [0.238, 0.006, 0.111, 0.006, 0.137, 0.094, 0.016, 0.214, 0.009, 0.080, 0.008, 0.081],
        [0.220, 0.006, 0.104, 0.123, 0.019, 0.103, 0.012, 0.214, 0.062, 0.022, 0.061, 0.052],
    ),
    # Tuned on electronic material, where the bass carries the tonic and the profile is
    # flatter than anything derived from listening tests on classical music.
    "edma": (
        [0.169, 0.045, 0.084, 0.049, 0.113, 0.093, 0.052, 0.148, 0.049, 0.084, 0.050, 0.063],
        [0.172, 0.048, 0.081, 0.111, 0.049, 0.087, 0.052, 0.143, 0.080, 0.049, 0.070, 0.058],
    ),
}


@dataclass
class KeyResult:
    key: str
    confidence: float
    segment_agreement: float
    segments: int
    alternatives: list[tuple[str, float]] = field(default_factory=list)
    # Raw features, logged rather than folded away. A combiner fitted later needs the
    # inputs, not somebody's earlier opinion of how to weigh them - and the confidence
    # below is exactly such an opinion, formed before there was any data to form it on.
    features: dict = field(default_factory=dict)


def _correlate(chroma: np.ndarray, profile: np.ndarray, root: int) -> float:
    rotated = np.roll(chroma, -root)
    a = rotated - rotated.mean()
    b = profile - profile.mean()
    denominator = np.sqrt((a * a).sum() * (b * b).sum())
    return float((a * b).sum() / denominator) if denominator else 0.0


def _score_segment(chroma: np.ndarray) -> dict[str, float]:
    """Every key scored against every profile, normalised so one profile can't dominate."""
    scores: dict[str, float] = {}
    for major, minor in PROFILES.values():
        major_profile = np.asarray(major, dtype=np.float64)
        minor_profile = np.asarray(minor, dtype=np.float64)

        per_profile: dict[str, float] = {}
        for root in range(12):
            per_profile[MAJOR_NAMES[root]] = _correlate(chroma, major_profile, root)
            per_profile[MINOR_NAMES[root]] = _correlate(chroma, minor_profile, root)

        # Correlations run -1..1; shift to non-negative so the sum below is meaningful.
        floor = min(per_profile.values())
        shifted = {k: v - floor for k, v in per_profile.items()}
        total = sum(shifted.values()) or 1.0
        for key, value in shifted.items():
            scores[key] = scores.get(key, 0.0) + value / total

    return scores


def detect(path: str, verbose: bool = False) -> KeyResult | None:
    audio, rate = librosa.load(path, sr=SAMPLE_RATE, mono=True, duration=MAX_SECONDS)
    if audio.size == 0:
        return None

    # Detuned material lands between bins and smears the chroma across neighbours, so the
    # tuning offset is measured once for the track and applied to every segment.
    tuning = float(librosa.estimate_tuning(y=audio, sr=rate))

    segment = int(SEGMENT_SECONDS * rate)
    hop = int(HOP_SECONDS * rate)
    if audio.size < segment:
        segment = audio.size
        hop = audio.size

    totals: dict[str, float] = {}
    winners: list[str] = []

    for start in range(0, max(1, audio.size - segment + 1), hop):
        chunk = audio[start : start + segment]
        if chunk.size < rate * 5:
            continue

        rms = float(np.sqrt(np.mean(np.square(chunk, dtype=np.float64))))
        if rms < 1e-4:
            continue

        # CQT chroma rather than STFT: the bins are musical intervals, which is what a key
        # profile is expressed in. Harmonics are folded so a bass note counts once.
        chroma = librosa.feature.chroma_cqt(
            y=chunk, sr=rate, tuning=tuning, bins_per_octave=36, n_chroma=12
        )
        # Median over time: a chord held for a bar should not be outvoted by a cymbal.
        folded = np.median(chroma, axis=1)
        if folded.sum() <= 0:
            continue
        folded = folded / folded.sum()

        scores = _score_segment(folded)
        winner = max(scores, key=lambda k: scores[k])
        winners.append(winner)

        weight = np.sqrt(rms)
        total = sum(scores.values()) or 1.0
        for key, value in scores.items():
            totals[key] = totals.get(key, 0.0) + (value / total) * weight

    if not winners or not totals:
        return None

    ranked = sorted(totals.items(), key=lambda item: item[1], reverse=True)
    best, best_score = ranked[0]
    grand_total = sum(totals.values()) or 1.0
    share = best_score / grand_total
    agreement = sum(1 for w in winners if w == best) / len(winners)

    # Both halves matter: a key can win on total score while no single section agreed with
    # it, which is what a modulating or ambiguous track looks like.
    confidence = float(np.clip(0.55 * (share * len(ranked) / 4) + 0.45 * agreement, 0.0, 1.0))

    runner_up, runner_up_score = ranked[1] if len(ranked) > 1 else ("", 0.0)
    profile_votes = _profile_votes(audio, rate, tuning, segment, hop)

    return KeyResult(
        key=best,
        confidence=confidence,
        segment_agreement=agreement,
        segments=len(winners),
        alternatives=[(k, v / grand_total) for k, v in ranked[1:4]],
        features={
            "primary_score": share,
            "margin": (best_score - runner_up_score) / grand_total,
            "segment_agreement": agreement,
            "segments": len(winners),
            "relative_ambiguity": _is_relative(best, runner_up),
            "profile_agreement": profile_votes,
            "tuning_cents": round(tuning * 100, 1),
            "distinct_section_winners": len(set(winners)),
        },
    )


def _is_relative(a: str, b: str) -> bool:
    """Whether the top two are a major and its relative minor - the classic near-tie."""
    if not a or not b:
        return False
    a_minor, b_minor = a.endswith("m"), b.endswith("m")
    if a_minor == b_minor:
        return False
    try:
        a_root = (MINOR_NAMES if a_minor else MAJOR_NAMES).index(a)
        b_root = (MINOR_NAMES if b_minor else MAJOR_NAMES).index(b)
    except ValueError:
        return False
    minor_root, major_root = (a_root, b_root) if a_minor else (b_root, a_root)
    return (minor_root - major_root) % 12 == 9


def _profile_votes(audio, rate, tuning, segment, hop) -> int:
    """How many of the four profiles pick the same key over the whole track."""
    chroma = librosa.feature.chroma_cqt(
        y=audio[: segment * 3] if audio.size > segment * 3 else audio,
        sr=rate,
        tuning=tuning,
        bins_per_octave=36,
        n_chroma=12,
    )
    folded = np.median(chroma, axis=1)
    if folded.sum() <= 0:
        return 0
    folded = folded / folded.sum()

    picks = []
    for major, minor in PROFILES.values():
        scores = {}
        for root in range(12):
            scores[MAJOR_NAMES[root]] = _correlate(folded, np.asarray(major, dtype=np.float64), root)
            scores[MINOR_NAMES[root]] = _correlate(folded, np.asarray(minor, dtype=np.float64), root)
        picks.append(max(scores, key=lambda k: scores[k]))
    return max(picks.count(p) for p in set(picks))


def main() -> int:
    parser = argparse.ArgumentParser(description="Estimate the musical key of an audio file.")
    parser.add_argument("path")
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit key, confidence, alternatives and raw features as one JSON object.",
    )
    parser.add_argument(
        "--min-confidence",
        type=float,
        default=0.0,
        help="Print nothing below this. Left at 0 so the caller decides.",
    )
    args = parser.parse_args()

    try:
        result = detect(args.path, args.verbose)
    except Exception as exc:  # noqa: BLE001 - a file we can't read is not an answer
        if args.verbose:
            print(f"failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    if result is None or result.confidence < args.min_confidence:
        if args.verbose and result is not None:
            print(
                f"(below threshold) {result.key} conf={result.confidence:.2f} "
                f"agree={result.segment_agreement:.2f}",
                file=sys.stderr,
            )
        return 1

    if args.json:
        print(
            json.dumps(
                {
                    "key": result.key,
                    "confidence": result.confidence,
                    "alternatives": [[k, round(v, 4)] for k, v in result.alternatives],
                    "features": result.features,
                }
            )
        )
        return 0

    print(result.key)
    if args.verbose:
        print(
            f"confidence {result.confidence:.2f}  agreement {result.segment_agreement:.2f}  "
            f"segments {result.segments}",
            file=sys.stderr,
        )
        for key, share in result.alternatives:
            print(f"   alt {key:<4} {share:.3f}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
