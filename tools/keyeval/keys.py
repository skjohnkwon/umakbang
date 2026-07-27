"""Canonical key labels and MIREX scoring.

Labels arrive spelled every possible way - "G#m", "Abm", "G# minor", "Ab min" - and any of
them is the same key. Everything is reduced to (pitch class, mode) before it is compared,
so a detector is never marked wrong for choosing a different spelling of the right answer.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

PITCH_OF = {
    "C": 0, "B#": 0,
    "C#": 1, "DB": 1,
    "D": 2,
    "D#": 3, "EB": 3,
    "E": 4, "FB": 4,
    "F": 5, "E#": 5,
    "F#": 6, "GB": 6,
    "G": 7,
    "G#": 8, "AB": 8,
    "A": 9,
    "A#": 10, "BB": 10,
    "B": 11, "CB": 11,
}

# One canonical spelling per key, for display. Which one hardly matters; that there is only
# one does.
MAJOR_NAMES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
MINOR_NAMES = ["Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "G#m", "Am", "Bbm", "Bm"]

_LABEL = re.compile(
    r"^\s*([A-Ga-g])\s*([#b♯♭]?)\s*[-_ ]*"
    r"(maj|major|min|minor|m|M)?\s*$"
)


@dataclass(frozen=True)
class Key:
    pitch: int
    minor: bool

    def __str__(self) -> str:
        return MINOR_NAMES[self.pitch] if self.minor else MAJOR_NAMES[self.pitch]


def parse(label: str | None) -> Key | None:
    """Any reasonable spelling to a canonical key, or None if it isn't one."""
    if not label:
        return None
    text = label.strip()
    if not text:
        return None

    # "G# minor", "Ab min", "F#m", "Eb"
    match = _LABEL.match(text.replace("♯", "#").replace("♭", "b"))
    if not match:
        return None

    letter, accidental, quality = match.groups()
    pitch = PITCH_OF.get((letter + accidental).upper())
    if pitch is None:
        return None

    q = (quality or "").lower()
    # A bare "M" means major; a bare "m" means minor. Case is the only thing separating
    # them, so the regex keeps it and this is where it matters.
    minor = q in {"m", "min", "minor"} and (quality != "M")
    return Key(pitch, minor)


def mirex_score(predicted: Key | None, reference: Key | None) -> float:
    """
    The standard partial-credit scale.

    A fifth away or the relative key are musically near misses rather than nonsense, and a
    detector that makes them is doing something different from one that returns noise.
    """
    if predicted is None or reference is None:
        return 0.0
    if predicted == reference:
        return 1.0

    distance = (predicted.pitch - reference.pitch) % 12

    # Perfect fifth up or down, same mode.
    if predicted.minor == reference.minor and distance in (7, 5):
        return 0.5
    # Relative major/minor.
    if predicted.minor != reference.minor:
        if reference.minor and distance == 3:
            return 0.3
        if not reference.minor and distance == 9:
            return 0.3
        # Parallel major/minor.
        if distance == 0:
            return 0.2
    return 0.0


def relation(predicted: Key | None, reference: Key | None) -> str:
    """A word for how a prediction is wrong, which is more use than the score alone."""
    if predicted is None or reference is None:
        return "missing"
    if predicted == reference:
        return "exact"
    distance = (predicted.pitch - reference.pitch) % 12
    if predicted.minor == reference.minor and distance == 7:
        return "dominant"
    if predicted.minor == reference.minor and distance == 5:
        return "subdominant"
    if predicted.minor != reference.minor and (
        (reference.minor and distance == 3) or (not reference.minor and distance == 9)
    ):
        return "relative"
    if predicted.minor != reference.minor and distance == 0:
        return "parallel"
    return "unrelated"
