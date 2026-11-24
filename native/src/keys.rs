//! Key spellings: `normaliseKey` and `relativeKeyPair` from `shared/keys.ts`.

const MAJOR_NAMES: [&str; 12] = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MINOR_NAMES: [&str; 12] = ["Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "G#m", "Am", "Bbm", "Bm"];

fn pitch_of(letter: &str) -> Option<usize> {
    Some(match letter {
        "C" | "B#" => 0,
        "C#" | "Db" => 1,
        "D" => 2,
        "D#" | "Eb" => 3,
        "E" | "Fb" => 4,
        "F" | "E#" => 5,
        "F#" | "Gb" => 6,
        "G" => 7,
        "G#" | "Ab" => 8,
        "A" => 9,
        "A#" | "Bb" => 10,
        "B" | "Cb" => 11,
        _ => return None,
    })
}

/// "f#min", "Gb Major", "Am" and the rest to one spelling: `F#m`, `Gb`, `Am`.
pub fn normalise(raw: &str) -> Option<String> {
    let value = raw.trim();
    let mut chars = value.chars();
    let letter = chars.next()?.to_ascii_uppercase();
    if !('A'..='G').contains(&letter) {
        return None;
    }
    let rest: String = chars.collect();
    // The pattern is case-insensitive, so `B` is an accidental too - and the accidental is
    // lowercased, or "EB" would be a spelling nothing pairs with.
    let first = rest.chars().next();
    let accidental = match first {
        Some('#') | Some('♯') => "#",
        Some('b') | Some('B') | Some('♭') => "b",
        _ => "",
    };
    let rest = if accidental.is_empty() { rest.as_str() } else { &rest[first.map_or(0, char::len_utf8)..] };
    let quality = rest.trim().to_lowercase();
    let minor = match quality.as_str() {
        "m" | "min" | "minor" => true,
        "" | "maj" | "major" => false,
        _ => return None,
    };
    Some(format!("{letter}{accidental}{}", if minor { "m" } else { "" }))
}

/// A detected key as its relative pair - "Eb/Cm" - since the analysis establishes the note
/// set far more reliably than the tonic.
pub fn relative_pair(key: &str) -> String {
    let Some(normalised) = normalise(key) else { return key.to_string() };
    let minor = normalised.ends_with('m');
    let letter = if minor { &normalised[..normalised.len() - 1] } else { normalised.as_str() };
    let Some(pitch) = pitch_of(letter) else { return normalised };
    let major = if minor { (pitch + 3) % 12 } else { pitch };
    let minor_pitch = if minor { pitch } else { (pitch + 9) % 12 };
    // F# major's relative minor is D#m, not the standalone spelling Ebm.
    let minor_name = if major == 6 { "D#m" } else { MINOR_NAMES[minor_pitch] };
    format!("{}/{}", MAJOR_NAMES[major], minor_name)
}

/// `nameWithMetadata`: `beat_Eb-Cm_140.wav`. The key as its relative pair, hyphenated since a
/// slash in a file name is a folder; whatever is missing skipped; None when there is nothing
/// to add or the name already ends in exactly this, so renaming twice changes nothing.
pub fn name_with_metadata(name: &str, bpm: Option<f64>, key: Option<&str>) -> Option<String> {
    let (stem, ext) = match name.rfind('.') {
        Some(dot) if dot > 0 => (&name[..dot], &name[dot..]),
        _ => (name, ""),
    };
    let mut parts = Vec::new();
    if let Some(key) = key.filter(|k| !k.is_empty()) {
        parts.push(relative_pair(key).replace('/', "-"));
    }
    if let Some(bpm) = bpm {
        parts.push(format!("{}", bpm.round() as i64));
    }
    if parts.is_empty() {
        return None;
    }
    let forbidden = ['/', ':', '*', '?', '"', '<', '>', '|'];
    let suffix = parts.iter().map(|p| p.chars().filter(|c| !forbidden.contains(c)).collect::<String>()).collect::<Vec<_>>().join("_");
    if stem.ends_with(&format!("_{suffix}")) {
        return None;
    }
    Some(format!("{stem}_{suffix}{ext}"))
}

/// `sameKey`: two spellings of one key - `D#m` and `Ebm`.
/// `SHORTCUT_ACTIONS`: the keys umakbang invented, by id - label, hint, default.
pub const SHORTCUTS: [(&str, &str, &str, &str); 7] = [
    ("playPause", "Play / pause", "Bound app-wide, so it works wherever you are.", " "),
    ("random", "Play a random beat", "Picks from your own work, plays it and goes to its folder.", "r"),
    ("tag", "Tag the selection", "Opens the tag editor on the row.", "t"),
    ("rename", "Rename", "Ctrl/⌘+Enter always works too.", "F2"),
    ("up", "Up one level", "Leaves the folder you are in.", "Backspace"),
    ("trash", "Delete", "To the Recycle Bin or Trash, never straight out.", "Delete"),
    ("clearSelection", "Clear the selection", "Also closes whatever popover is open.", "Escape"),
];

/// Ratings and moving around the list: whole families of keys, never lent out.
const RESERVED: [&str; 16] = ["0", "1", "2", "3", "4", "5", "arrowup", "arrowdown", "arrowleft", "arrowright", "pageup", "pagedown", "home", "end", "enter", "tab"];

/// `shortcutKey`: what an action is bound to now.
pub fn shortcut_key<'a>(overrides: &'a std::collections::HashMap<String, String>, id: &str) -> &'a str {
    let default = SHORTCUTS.iter().find(|s| s.0 == id).map_or("", |s| s.3);
    overrides.get(id).map(String::as_str).filter(|k| !k.is_empty()).unwrap_or(default)
}

/// `shortcutLabel`.
pub fn shortcut_label(key: &str) -> String {
    match key {
        " " => "Space".into(),
        "Escape" | "escape" => "Esc".into(),
        "backspace" => "Backspace".into(),
        "delete" => "Delete".into(),
        k if k.chars().count() == 1 => k.to_uppercase(),
        k if k.len() > 1 && k.starts_with('f') && k[1..].chars().all(|c| c.is_ascii_digit()) => k.to_uppercase(),
        k => k.to_string(),
    }
}

/// `shortcutConflict`: why a key cannot be bound to `id`, or None.
pub fn shortcut_conflict(overrides: &std::collections::HashMap<String, String>, id: &str, key: &str) -> Option<String> {
    let name = key.to_lowercase();
    if RESERVED.contains(&name.as_str()) {
        return Some(format!("{} is used for ratings and moving around the list.", shortcut_label(key)));
    }
    for (other, label, _, _) in SHORTCUTS {
        if other != id && shortcut_key(overrides, other).to_lowercase() == name {
            return Some(format!("{} is already {}.", shortcut_label(key), label.to_lowercase()));
        }
    }
    None
}

pub fn same_key(a: &str, b: &str) -> bool {
    let (Some(na), Some(nb)) = (normalise(a), normalise(b)) else { return false };
    let minor = na.ends_with('m');
    if minor != nb.ends_with('m') {
        return false;
    }
    let strip = |s: &str| if minor { s[..s.len() - 1].to_string() } else { s.to_string() };
    matches!((pitch_of(&strip(&na)), pitch_of(&strip(&nb))), (Some(x), Some(y)) if x == y)
}

/// `fifthsPosition`: where a key sits on the circle of fifths, 0 (C) to 1 (F), a key and its
/// relative minor alike.
pub fn fifths_position(key: &str) -> Option<f32> {
    let normalised = normalise(key)?;
    let minor = normalised.ends_with('m');
    let pitch = pitch_of(if minor { &normalised[..normalised.len() - 1] } else { &normalised })?;
    let major = if minor { (pitch + 3) % 12 } else { pitch };
    Some(((major * 7) % 12) as f32 / 11.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairs() {
        assert_eq!(relative_pair("Cm"), "Eb/Cm");
        assert_eq!(relative_pair("F#"), "F#/D#m");
        // Eb minor pairs with F#, so it is spelled D#m beside it, as `relativeKeyPair` does.
        assert_eq!(relative_pair("ebm"), "F#/D#m");
        assert_eq!(relative_pair("A minor"), "C/Am");
        assert_eq!(relative_pair("Bb"), "Bb/Gm");
        assert_eq!(relative_pair("B"), "B/G#m");
        assert_eq!(relative_pair("Bm"), "D/Bm");
    }
}

#[cfg(test)]
mod metadata_name_tests {
    #[test]
    fn names() {
        assert_eq!(super::name_with_metadata("beat.wav", Some(140.2), Some("Cm")).as_deref(), Some("beat_Eb-Cm_140.wav"));
        assert_eq!(super::name_with_metadata("beat.wav", Some(140.0), None).as_deref(), Some("beat_140.wav"));
        assert_eq!(super::name_with_metadata("beat_Eb-Cm_140.wav", Some(140.0), Some("Cm")), None);
        assert_eq!(super::name_with_metadata("beat.wav", None, None), None);
    }
}
