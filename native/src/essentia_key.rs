//! Essentia's `KeyExtractor` (`lib/key-essentia.ts`), ported from its C++ (AGPL-3.0, as umakbang
//! is) stage by stage, with the parameters the Electron app passes it, so a key detected here
//! is the key Electron detected for the same file:
//!
//! FrameCutter (4096, hop 4096, the first frame centred on the start) -> Windowing (Hann,
//! normalised) -> Spectrum -> SpectralPeaks (60 by magnitude, 25-3500Hz, above 1e-4) ->
//! SpectralWhitening -> HPCP (12 bins, 4 harmonics, cosine weighting, 440Hz) -> the frames
//! averaged -> peak-normalised and gated at 0.2 -> Key, correlated against the profile.
//!
//! Single precision throughout, as Essentia's `Real` is: thresholds are compared in the same
//! arithmetic they were tuned in.

use realfft::RealFftPlanner;

const FRAME: usize = 4096;
const HOP: usize = 4096;
const MIN_FREQ: f32 = 25.0;
const MAX_FREQ: f32 = 3500.0;
const PEAK_THRESHOLD: f32 = 0.0001;
const MAX_PEAKS: usize = 60;
const PCP_THRESHOLD: f32 = 0.2;
const REFERENCE: f32 = 440.0;

/// `profileTypes` and `profileTypesWithOther`: major, then minor.
fn profile(name: &str) -> ([f32; 12], [f32; 12]) {
    match name {
        "krumhansl" => ([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88], [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]),
        "temperley" => ([5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0], [5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0]),
        "bgate" => ([1.00, 0.00, 0.42, 0.00, 0.53, 0.37, 0.00, 0.77, 0.00, 0.38, 0.21, 0.30], [1.00, 0.00, 0.36, 0.39, 0.00, 0.38, 0.00, 0.74, 0.27, 0.00, 0.42, 0.23]),
        // edma, and anything unknown.
        _ => ([1.00, 0.29, 0.50, 0.40, 0.60, 0.56, 0.32, 0.80, 0.31, 0.45, 0.42, 0.39], [1.00, 0.31, 0.44, 0.58, 0.33, 0.49, 0.29, 0.78, 0.43, 0.29, 0.53, 0.32]),
    }
}

/// Essentia's key names, bin 0 being A since the HPCP is referenced to 440Hz.
const KEYS: [&str; 12] = ["A", "Bb", "B", "C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab"];
const MAJOR_NAMES: [&str; 12] = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MINOR_NAMES: [&str; 12] = ["Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "G#m", "Am", "Bbm", "Bm"];

fn pitch_class(name: &str) -> Option<usize> {
    Some(match name {
        "C" => 0,
        "C#" | "Db" => 1,
        "D" => 2,
        "D#" | "Eb" => 3,
        "E" => 4,
        "F" => 5,
        "F#" | "Gb" => 6,
        "G" => 7,
        "G#" | "Ab" => 8,
        "A" => 9,
        "A#" | "Bb" => 10,
        "B" => 11,
        _ => return None,
    })
}

/// `lin2db` with Essentia's silence floor.
fn lin2db(v: f32) -> f32 {
    if v < 1e-10 { -100.0 } else { 10.0 * v.log10() }
}

fn db2lin(v: f32) -> f32 {
    10f32.powf(v / 10.0)
}

/// `PeakDetection` over a magnitude spectrum: local maxima with parabolic interpolation on the
/// linear values, between the frequency limits and above the threshold, the loudest `MAX_PEAKS`.
fn spectral_peaks(spectrum: &[f32], rate: f32) -> (Vec<f32>, Vec<f32>) {
    let size = spectrum.len();
    let scale = (rate / 2.0) / (size as f32 - 1.0);
    let mut peaks: Vec<(f32, f32)> = Vec::new();
    let a = spectrum;
    let mut i = 0usize.max((MIN_FREQ / scale).ceil() as usize);
    if i + 1 < size && a[i] > a[i + 1] && a[i] > PEAK_THRESHOLD {
        peaks.push((i as f32 * scale, a[i]));
    }
    let interpolate = |l: f32, m: f32, r: f32, bin: usize| -> (f32, f32) {
        let delta = 0.5 * ((l - r) / (l - 2.0 * m + r));
        (bin as f32 + delta, m - 0.25 * (l - r) * delta)
    };
    loop {
        while i + 1 < size - 1 && a[i] >= a[i + 1] {
            i += 1;
        }
        while i + 1 < size - 1 && a[i] < a[i + 1] {
            i += 1;
        }
        let mut j = i;
        while j + 1 < size - 1 && a[j] == a[j + 1] {
            j += 1;
        }
        if j + 1 < size - 1 && a[j + 1] < a[j] && a[j] > PEAK_THRESHOLD {
            let (bin, value) = if j != i { ((i + j) as f32 * 0.5, a[i]) } else { interpolate(a[j - 1], a[j], a[j + 1], j) };
            let position = bin * scale;
            if position > MAX_FREQ {
                break;
            }
            peaks.push((position, value));
        }
        i = j;
        if i + 1 >= size - 1 {
            if i == size - 2 && a[i - 1] < a[i] && a[i + 1] < a[i] && a[i] > PEAK_THRESHOLD {
                let (bin, value) = interpolate(a[i - 1], a[i], a[i + 1], j);
                peaks.push((bin * scale, value));
            }
            break;
        }
    }
    let pos = MAX_FREQ / scale;
    if (size as f32 - 2.0) < pos && pos <= (size as f32 - 1.0) && a[size - 1] > a[size - 2] && a[size - 1] > PEAK_THRESHOLD {
        peaks.push(((size - 1) as f32 * scale, a[size - 1]));
    }
    // By magnitude, loudest first; equal magnitudes by position.
    peaks.sort_by(|x, y| y.1.partial_cmp(&x.1).unwrap_or(std::cmp::Ordering::Equal).then(x.0.partial_cmp(&y.0).unwrap_or(std::cmp::Ordering::Equal)));
    peaks.truncate(MAX_PEAKS);
    (peaks.iter().map(|p| p.0).collect(), peaks.iter().map(|p| p.1).collect())
}

/// `SpectralWhitening`: each peak against a spectral envelope, so a loud chord and a quiet one
/// weigh alike.
fn whiten(spectrum: &[f32], frequencies: &[f32], magnitudes: &[f32], rate: f32) -> Vec<f32> {
    let max_freq = MAX_FREQ * 1.2;
    let range = rate / 2.0;
    let n = magnitudes.len();
    if n == 0 {
        return Vec::new();
    }
    let db: Vec<f32> = magnitudes.iter().map(|&m| 2.0 * lin2db(m)).collect();
    let mut max_amp = -f32::MAX;
    for k in 0..n {
        if frequencies[k] <= max_freq {
            max_amp = max_amp.max(db[k]);
        }
    }
    let incr = 100.0f32;
    let size = spectrum.len();
    let (mut xs, mut ys) = (Vec::new(), Vec::new());
    let mut freq = 0.0f32;
    while freq <= max_freq && freq <= range {
        let bf = freq - 50f32.max(freq * 0.34);
        let ef = freq + 50f32.max(freq * 0.58);
        let mut b = (bf / range * (size as f32 - 1.0) + 0.5) as i64;
        let mut e = (ef / range * (size as f32 - 1.0) + 0.5) as i64;
        b = b.max(0).min(size as i64 - 1);
        e = e.max(b + 1).min(size as i64);
        let c = b as f32 / 2.0 + e as f32 / 2.0;
        let half = e as f32 - c;
        let (mut weights, mut average) = (0.0f32, 0.0f32);
        for i in b..e {
            let mut w = 1.0 - (i as f32 - c).abs() / half;
            w *= w;
            w *= w;
            let energy = spectrum[i as usize] * spectrum[i as usize];
            w *= energy;
            average += energy * w;
            weights += w;
        }
        if weights != 0.0 {
            average /= weights;
        }
        xs.push(freq);
        ys.push(average);
        freq += incr;
    }
    if ys.len() >= 2 {
        let last = ys.len() - 1;
        ys[last] = ys[last - 1];
    }
    for y in ys.iter_mut() {
        *y = 2.0 * lin2db(y.sqrt());
    }
    // `BPF`: straight lines between the points.
    let envelope = |f: f32| -> f32 {
        let at = ((f / incr).floor() as usize).min(xs.len().saturating_sub(2));
        let (x0, x1) = (xs[at], xs[at + 1]);
        let t = (f - x0) / (x1 - x0);
        ys[at] + (ys[at + 1] - ys[at]) * t
    };
    let mut out = vec![0.0f32; n];
    for k in 0..n {
        let (f, amp) = (frequencies[k], db[k]);
        if f > max_freq - incr || xs.len() < 2 {
            out[k] = amp;
            continue;
        }
        let env = envelope(f);
        if amp < max_amp - 40.0 {
            out[k] = (max_amp - 40.0 - amp) / 2.0;
        }
        out[k] = if amp > env {
            0.0
        } else if amp > env - 30.0 {
            amp - env
        } else {
            -200.0
        };
        out[k] -= 20.0 * f / 4000.0;
    }
    out.iter().map(|v| db2lin(v / 2.0)).collect()
}

/// `initHarmonicContributionTable` with four harmonics: where each harmonic lands, folded into
/// the octave, and how much it counts.
fn harmonics() -> Vec<(f32, f32)> {
    let precision = 0.00001f32;
    let mut table: Vec<(f32, f32)> = Vec::new();
    for i in 0..=4 {
        let mut semitone = 12.0 * ((i + 1) as f32).log2();
        let octweight = 1f32.max((semitone / 12.0) * 0.5);
        while semitone >= 12.0 - precision {
            semitone -= 12.0;
        }
        match table.iter_mut().find(|(s, _)| *s > semitone - precision && *s < semitone + precision) {
            Some(entry) => entry.1 += 1.0 / octweight,
            None => table.push((semitone, 1.0 / octweight)),
        }
    }
    table
}

fn hpcp(frequencies: &[f32], magnitudes: &[f32], table: &[(f32, f32)]) -> [f32; 12] {
    let mut out = [0.0f32; 12];
    for (&freq, &mag) in frequencies.iter().zip(magnitudes) {
        if !(MIN_FREQ..=MAX_FREQ).contains(&freq) {
            continue;
        }
        for &(semitone, strength) in table {
            let f = freq * 2f32.powf(-semitone / 12.0);
            let bin = (f / REFERENCE).log2() * 12.0;
            let left = (bin - 0.5).ceil() as i64;
            let right = (bin + 0.5).floor() as i64;
            for i in left..=right {
                let distance = (bin - i as f32).abs();
                let weight = (std::f32::consts::PI * distance).cos();
                let wrapped = i.rem_euclid(12) as usize;
                out[wrapped] += weight * (mag * mag) * strength * strength;
            }
        }
    }
    out
}

fn normalize(v: &mut [f32]) {
    let max = v.iter().cloned().fold(0.0f32, f32::max);
    if max > 0.0 {
        for x in v.iter_mut() {
            *x /= max;
        }
    }
}

fn correlation(pcp: &[f32; 12], mean_pcp: f32, std_pcp: f32, profile: &[f32; 12], mean_p: f32, std_p: f32, shift: usize) -> f32 {
    if std_pcp == 0.0 || std_p == 0.0 {
        return 0.0;
    }
    let mut r = 0.0f32;
    for i in 0..12 {
        let index = (i as i64 - shift as i64).rem_euclid(12) as usize;
        r += (pcp[i] - mean_pcp) * (profile[index] - mean_p);
    }
    r / (std_pcp * std_p)
}

/// The key, as Electron writes it (`Eb`, `C#m`...), and its strength; None for under three
/// seconds of audio, where the caller falls back to the built-in detector.
pub fn detect(signal: &[f32], rate: f32, profile_name: &str) -> Option<(String, f64)> {
    if (signal.len() as f32) < rate * 3.0 {
        return None;
    }
    let window: Vec<f32> = {
        let w: Vec<f32> = (0..FRAME).map(|i| (0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / (FRAME as f64 - 1.0)).cos()) as f32).collect();
        let sum: f32 = w.iter().map(|x| x.abs()).sum();
        let scale = 2.0 / sum;
        w.iter().map(|x| x * scale).collect()
    };
    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FRAME);
    let mut input = fft.make_input_vec();
    let mut output = fft.make_output_vec();
    let table = harmonics();
    let n = signal.len() as i64;
    let mut sum = [0.0f32; 12];
    let mut frames = 0usize;
    // Frames start half a frame before the audio and step on until one's centre reaches its end.
    let mut start = -((FRAME as i64 + 1) / 2);
    loop {
        if start >= n {
            break;
        }
        let mut frame = [0.0f32; FRAME];
        for (k, slot) in frame.iter_mut().enumerate() {
            let at = start + k as i64;
            if at >= 0 && at < n {
                *slot = signal[at as usize];
            }
        }
        frames += 1;
        // A silent frame gets noise 100dB down, which lands below the peak threshold: it
        // counts towards the average and contributes nothing to it.
        let power: f32 = frame.iter().map(|x| x * x).sum::<f32>() / FRAME as f32;
        if power >= 1e-10 {
            for (k, slot) in input.iter_mut().enumerate() {
                *slot = frame[k] * window[k];
            }
            if fft.process(&mut input, &mut output).is_ok() {
                let spectrum: Vec<f32> = output.iter().map(|c| (c.re * c.re + c.im * c.im).sqrt()).collect();
                let (freqs, mags) = spectral_peaks(&spectrum, rate);
                let white = whiten(&spectrum, &freqs, &mags, rate);
                let h = hpcp(&freqs, &white, &table);
                for i in 0..12 {
                    sum[i] += h[i];
                }
            }
        }
        let last = start + FRAME as i64 / 2 >= n;
        start += HOP as i64;
        if last {
            break;
        }
    }
    if frames == 0 {
        return None;
    }
    let mut pcp = sum.map(|v| v / frames as f32);
    normalize(&mut pcp);
    for v in pcp.iter_mut() {
        if *v < PCP_THRESHOLD {
            *v = 0.0;
        }
    }
    normalize(&mut pcp);
    let (major, minor) = profile(profile_name);
    let mean = |v: &[f32; 12]| v.iter().sum::<f32>() / 12.0;
    let std = |v: &[f32; 12], m: f32| v.iter().map(|x| (x - m) * (x - m)).sum::<f32>().sqrt();
    let (mean_pcp, mean_major, mean_minor) = (mean(&pcp), mean(&major), mean(&minor));
    let (std_pcp, std_major, std_minor) = (std(&pcp, mean_pcp), std(&major, mean_major), std(&minor, mean_minor));
    let (mut best_major, mut at_major, mut best_minor, mut at_minor) = (-1.0f32, 0usize, -1.0f32, 0usize);
    for shift in 0..12 {
        let c = correlation(&pcp, mean_pcp, std_pcp, &major, mean_major, std_major, shift);
        if c > best_major {
            best_major = c;
            at_major = shift;
        }
        let c = correlation(&pcp, mean_pcp, std_pcp, &minor, mean_minor, std_minor, shift);
        if c > best_minor {
            best_minor = c;
            at_minor = shift;
        }
    }
    let (index, minor_scale, strength) = if best_major > best_minor { (at_major, false, best_major) } else { (at_minor, true, best_minor) };
    let root = pitch_class(KEYS[index])?;
    let key = if minor_scale { MINOR_NAMES[root] } else { MAJOR_NAMES[root] };
    Some((key.to_string(), strength as f64))
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_major_triad_reads_as_a() {
        let rate = 11025.0f32;
        let tone = |f: f32, t: f32| (2.0 * std::f32::consts::PI * f * t).sin();
        let signal: Vec<f32> = (0..(rate as usize * 10)).map(|i| {
            let t = i as f32 / rate;
            // A, C#, E across three octaves.
            [220.0, 277.18, 329.63, 440.0, 554.37, 659.25].iter().map(|&f| tone(f, t)).sum::<f32>() * 0.1
        }).collect();
        let (key, strength) = super::detect(&signal, rate, "edma").unwrap();
        assert_eq!(key, "A");
        assert!(strength > 0.5, "{strength}");
    }

    #[test]
    fn harmonic_table() {
        let t = super::harmonics();
        assert_eq!(t.len(), 3);
        assert!((t[0].1 - 3.0).abs() < 1e-4, "{:?}", t);
    }
}
