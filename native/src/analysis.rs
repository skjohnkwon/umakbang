//! Tempo and key worked out from the audio (`lib/tempo.ts`, `lib/key.ts`, `lib/dsp.ts`,
//! `lib/analysis.ts`), for files that do not declare them.
//!
//! Both detectors read the same signal: the first minute, downmixed to mono and decimated by
//! a whole factor to about 11kHz with a boxcar average. Tempo is a spectral-flux onset
//! envelope, autocorrelated and scored over its metrical multiples, with the octave settled
//! by evidence rather than taste; key is a chromagram correlated against the
//! Krumhansl-Kessler profiles. The Electron app's default key engine is Essentia, which has
//! no native build here yet - this is its built-in detector, `key.ts`, the fallback it ships.

use crate::app::Wake;
use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use winit::event_loop::EventLoopProxy;

const TARGET_RATE: f64 = 11025.0;
const MAX_SECONDS: f64 = 60.0;
const MAX_DECODE_BYTES: u64 = 300 * 1024 * 1024;
/// Below this a tempo is worse than a blank cell (`MIN_TEMPO_CONFIDENCE`).
pub const MIN_TEMPO_CONFIDENCE: f64 = 0.1;
/// Below this the audio is not tonal enough to name a key (`MIN_KEY_FIT`).
pub const MIN_KEY_FIT: f64 = 0.4;

/* ------------------------------------------------------------------ the signal */

/// The first minute of `path`, mono, decimated by a whole factor towards 11kHz.
pub fn decode(path: &Path) -> Option<(Vec<f32>, f64)> {
    let decoder = crate::remote::decoder_limited(&path.to_string_lossy(), MAX_DECODE_BYTES).ok()?;
    use rodio::Source;
    let channels = decoder.channels().get() as usize;
    let rate = decoder.sample_rate().get() as f64;
    let factor = ((rate / TARGET_RATE).floor() as usize).max(1);
    let usable = (rate * MAX_SECONDS) as usize;
    let mut out = Vec::with_capacity(usable / factor);
    let (mut acc, mut in_frame, mut frame_sum, mut channel, mut frames) = (0.0f64, 0usize, 0.0f64, 0usize, 0usize);
    for sample in decoder {
        frame_sum += sample as f64;
        channel += 1;
        if channel < channels {
            continue;
        }
        channel = 0;
        acc += frame_sum / channels as f64;
        frame_sum = 0.0;
        in_frame += 1;
        frames += 1;
        if in_frame == factor {
            out.push((acc / factor as f64) as f32);
            acc = 0.0;
            in_frame = 0;
        }
        if frames >= usable {
            break;
        }
    }
    Some((out, rate / factor as f64))
}

fn hann(size: usize) -> Vec<f32> {
    (0..size).map(|i| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / size as f64).cos() as f32).collect()
}

/// Magnitudes of a real frame, `size / 2` bins.
fn magnitudes(fft: &Arc<dyn realfft::RealToComplex<f32>>, frame: &mut [f32], spectrum: &mut [realfft::num_complex::Complex<f32>], out: &mut [f32]) {
    if fft.process(frame, spectrum).is_err() {
        return;
    }
    for (o, c) in out.iter_mut().zip(spectrum.iter()) {
        *o = (c.re * c.re + c.im * c.im).sqrt();
    }
}

/* ------------------------------------------------------------------ tempo */

const FFT_TEMPO: usize = 512;
const ENVELOPE_RATE: f64 = 100.0;
const MIN_BPM: f64 = 60.0;
const MAX_BPM: f64 = 200.0;
const PRIOR_CENTER_BPM: f64 = 125.0;
const PRIOR_WIDTH_OCTAVES: f64 = 1.5;
const OCTAVE_TOLERANCE: f64 = 0.82;
const TRIPLET_MARGIN: f64 = 1.02;
const SUBDIVISION_THRESHOLD: f64 = 0.5;
const HARMONIC_WEIGHTS: [f64; 4] = [1.0, 0.6, 0.1, 0.7];
const MIN_ONSET_PEAKINESS: f64 = 2.5;

/// `detectTempo`: BPM and how sure, or nothing for under five seconds or no pulse.
pub fn detect_tempo(signal: &[f32], rate: f64) -> Option<(f64, f64)> {
    if (signal.len() as f64) < rate * 5.0 {
        return None;
    }
    let hop = ((rate / ENVELOPE_RATE).round() as usize).max(1);
    let envelope = upsample2(&onset_envelope(signal, hop));
    let fps = 2.0 * rate / hop as f64;
    if (envelope.len() as f64) < fps * 3.0 {
        return None;
    }
    pick_tempo(&envelope, fps)
}

fn upsample2(x: &[f32]) -> Vec<f32> {
    if x.is_empty() {
        return Vec::new();
    }
    let mut out = vec![0.0; x.len() * 2 - 1];
    for i in 0..x.len() {
        out[i * 2] = x[i];
        if i + 1 < x.len() {
            out[i * 2 + 1] = 0.5 * (x[i] + x[i + 1]);
        }
    }
    out
}

fn onset_envelope(signal: &[f32], hop: usize) -> Vec<f32> {
    if signal.len() < FFT_TEMPO {
        return Vec::new();
    }
    let frames = (signal.len() - FFT_TEMPO) / hop + 1;
    if frames < 2 {
        return Vec::new();
    }
    let fft = realfft::RealFftPlanner::<f32>::new().plan_fft_forward(FFT_TEMPO);
    let window = hann(FFT_TEMPO);
    let mut frame = vec![0.0f32; FFT_TEMPO];
    let mut spectrum = fft.make_output_vec();
    let bins = FFT_TEMPO / 2;
    let mut mags = vec![0.0f32; bins + 1];
    let mut prev = vec![0.0f32; bins];
    let mut flux = vec![0.0f32; frames];
    for f in 0..frames {
        let offset = f * hop;
        for i in 0..FFT_TEMPO {
            frame[i] = signal[offset + i] * window[i];
        }
        magnitudes(&fft, &mut frame, &mut spectrum, &mut mags);
        let mut sum = 0.0f32;
        for k in 0..bins {
            // Log-compressed, so a quiet hi-hat is not buried under a loud kick.
            let value = (1.0 + 200.0 * mags[k]).ln();
            if f > 0 {
                let diff = value - prev[k];
                if diff > 0.0 {
                    sum += diff;
                }
            }
            prev[k] = value;
        }
        flux[f] = sum;
    }
    flux[0] = flux[1];
    smooth(&detrend(&flux, (ENVELOPE_RATE * 0.8).round() as usize), 1.4)
}

fn smooth(x: &[f32], sigma: f64) -> Vec<f32> {
    let radius = ((sigma * 2.0).ceil() as i64).max(1);
    let mut kernel: Vec<f64> = (-radius..=radius).map(|i| (-0.5 * (i * i) as f64 / (sigma * sigma)).exp()).collect();
    let norm: f64 = kernel.iter().sum();
    kernel.iter_mut().for_each(|v| *v /= norm);
    let n = x.len() as i64;
    (0..n)
        .map(|i| {
            let mut acc = 0.0f64;
            for k in -radius..=radius {
                let j = i + k;
                if j >= 0 && j < n {
                    acc += x[j as usize] as f64 * kernel[(k + radius) as usize];
                }
            }
            acc as f32
        })
        .collect()
}

fn detrend(x: &[f32], window: usize) -> Vec<f32> {
    let n = x.len();
    let half = (window / 2).max(1);
    let mut prefix = vec![0.0f64; n + 1];
    for i in 0..n {
        prefix[i + 1] = prefix[i] + x[i] as f64;
    }
    (0..n)
        .map(|i| {
            let lo = i.saturating_sub(half);
            let hi = (i + half + 1).min(n);
            let mean = (prefix[hi] - prefix[lo]) / (hi - lo) as f64;
            let v = x[i] as f64 - mean;
            if v > 0.0 { v as f32 } else { 0.0 }
        })
        .collect()
}

fn percentile(x: &[f32], q: f64) -> f32 {
    let mut sorted = x.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let index = ((sorted.len() as f64 * q).floor() as usize).min(sorted.len() - 1);
    sorted[index]
}

fn pick_tempo(envelope: &[f32], fps: f64) -> Option<(f64, f64)> {
    let n = envelope.len();
    let search_min = ((fps * 60.0 / MAX_BPM).floor() as usize).max(2);
    let search_max = (fps * 60.0 / MIN_BPM).ceil() as usize;
    if n <= search_max * 2 {
        return None;
    }
    let mean = envelope.iter().map(|&v| v as f64).sum::<f64>() / n as f64;
    if mean <= 0.0 || (percentile(envelope, 0.95) as f64) / mean < MIN_ONSET_PEAKINESS {
        return None;
    }
    let x: Vec<f64> = envelope.iter().map(|&v| v as f64 - mean).collect();
    let energy: f64 = x.iter().map(|v| v * v).sum();
    if energy <= 1e-12 {
        return None;
    }
    let zero_lag = energy / n as f64;
    let max_lag = (n / 2).min(search_max * HARMONIC_WEIGHTS.len());
    if max_lag <= search_min {
        return None;
    }
    let mut acf = vec![0.0f64; max_lag + 1];
    for lag in search_min..=max_lag {
        let limit = n - lag;
        let mut sum = 0.0;
        for i in 0..limit {
            sum += x[i] * x[i + lag];
        }
        acf[lag] = sum / limit as f64 / zero_lag;
    }
    let effective_max = search_max.min(max_lag - 1);
    if effective_max <= search_min {
        return None;
    }
    let weighted = |candidate: usize| -> f64 {
        let (mut s, mut w) = (0.0, 0.0);
        for (h, weight) in HARMONIC_WEIGHTS.iter().enumerate() {
            let l = candidate * (h + 1);
            if l > max_lag {
                break;
            }
            s += weight * acf[l];
            w += weight;
        }
        if w == 0.0 { 0.0 } else { s / w }
    };
    let mut score = vec![0.0f64; effective_max + 1];
    for lag in search_min..=effective_max {
        score[lag] = weighted(lag) * tempo_prior(fps * 60.0 / lag as f64);
    }
    let mut best = None;
    let mut best_score = f64::NEG_INFINITY;
    for lag in search_min..=effective_max {
        let peak = (lag == search_min || score[lag] >= score[lag - 1]) && (lag == effective_max || score[lag] >= score[lag + 1]);
        if peak && score[lag] > best_score {
            best_score = score[lag];
            best = Some(lag);
        }
    }
    let lag = resolve_octave(&acf, envelope, best?, search_min, max_lag, fps);
    let refined = interpolate_peak(&acf, lag, search_min, max_lag);
    let bpm = fps * 60.0 / refined;
    if !(MIN_BPM..=MAX_BPM).contains(&bpm) {
        return None;
    }
    // Prominence of the winner over the mean, on the same weighted measure it was chosen by.
    let average = (search_min..=effective_max).map(&weighted).sum::<f64>() / (effective_max - search_min + 1) as f64;
    let peak = weighted(lag);
    let confidence = if peak <= 0.0 { 0.0 } else { ((peak - average) / (1.0 - average.min(0.99))).clamp(0.0, 1.0) };
    Some(((bpm * 10.0).round() / 10.0, confidence))
}

fn local_max(acf: &[f64], lag: usize, min: usize, max: usize) -> f64 {
    let mut m = f64::NEG_INFINITY;
    for l in lag.saturating_sub(1)..=lag + 1 {
        if l >= min && l <= max && acf[l] > m {
            m = acf[l];
        }
    }
    if m == f64::NEG_INFINITY { 0.0 } else { m }
}

fn tempo_prior(bpm: f64) -> f64 {
    let z = (bpm / PRIOR_CENTER_BPM).log2() / PRIOR_WIDTH_OCTAVES;
    (-0.5 * z * z).exp()
}

fn resolve_octave(acf: &[f64], envelope: &[f32], lag: usize, min: usize, max: usize, fps: f64) -> usize {
    let (fold_min, fold_max) = (PRIOR_CENTER_BPM / std::f64::consts::SQRT_2, PRIOR_CENTER_BPM * std::f64::consts::SQRT_2);
    let mut current = lag;
    let triplet = ((current * 2) as f64 / 3.0).round() as usize;
    if triplet >= min && fps * 60.0 / triplet as f64 <= MAX_BPM && local_max(acf, triplet, min, max) > TRIPLET_MARGIN * local_max(acf, current, min, max) {
        current = triplet;
    }
    for _ in 0..2 {
        let bpm = fps * 60.0 / current as f64;
        if bpm < fold_min {
            let faster = (current as f64 / 2.0).round() as usize;
            if faster < min || fps * 60.0 / faster as f64 > MAX_BPM {
                break;
            }
            if local_max(acf, faster, min, max) < OCTAVE_TOLERANCE * local_max(acf, current, min, max) {
                break;
            }
            if subdivision_strength(envelope, current) < SUBDIVISION_THRESHOLD {
                break;
            }
            current = faster;
            continue;
        }
        if bpm > fold_max {
            let slower = current * 2;
            if slower > max || fps * 60.0 / (slower as f64) < MIN_BPM {
                break;
            }
            if local_max(acf, slower, min, max) < OCTAVE_TOLERANCE * local_max(acf, current, min, max) {
                break;
            }
            current = slower;
            continue;
        }
        break;
    }
    current
}

fn subdivision_strength(envelope: &[f32], lag: usize) -> f64 {
    let n = envelope.len() as i64;
    let at = |i: f64| -> f64 {
        let j = i.round() as i64;
        if j < 0 || j >= n { 0.0 } else { envelope[j as usize] as f64 }
    };
    let comb = |phase: f64| -> f64 {
        let mut sum = 0.0;
        let mut t = phase;
        while t < n as f64 {
            sum += at(t - 1.0).max(at(t)).max(at(t + 1.0));
            t += lag as f64;
        }
        sum
    };
    let (mut best_phase, mut best) = (0.0, -1.0);
    let step = ((lag as f64 / 48.0).round() as usize).max(1);
    let mut p = 0;
    while p < lag {
        let e = comb(p as f64);
        if e > best {
            best = e;
            best_phase = p as f64;
        }
        p += step;
    }
    if best <= 0.0 { 0.0 } else { comb(best_phase + lag as f64 / 2.0) / best }
}

fn interpolate_peak(acf: &[f64], lag: usize, min: usize, max: usize) -> f64 {
    if lag <= min || lag >= max {
        return lag as f64;
    }
    let (a, b, c) = (acf[lag - 1], acf[lag], acf[lag + 1]);
    let denom = a - 2.0 * b + c;
    if denom.abs() < 1e-12 {
        return lag as f64;
    }
    let delta = 0.5 * (a - c) / denom;
    if !delta.is_finite() || delta.abs() > 1.0 { lag as f64 } else { lag as f64 + delta }
}

/* ------------------------------------------------------------------ key */

const FFT_KEY: usize = 8192;
const MAJOR_NAMES: [&str; 12] = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MINOR_NAMES: [&str; 12] = ["Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "G#m", "Am", "Bbm", "Bm"];
const MAJOR_PROFILE: [f64; 12] = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE: [f64; 12] = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/// `detectKey`: the best of the 24 keys and how well it fits, for three seconds or more.
pub fn detect_key(signal: &[f32], rate: f64) -> Option<(String, f64)> {
    if (signal.len() as f64) < rate * 3.0 || signal.len() < FFT_KEY {
        return None;
    }
    let fft = realfft::RealFftPlanner::<f32>::new().plan_fft_forward(FFT_KEY);
    let window = hann(FFT_KEY);
    let mut frame = vec![0.0f32; FFT_KEY];
    let mut spectrum = fft.make_output_vec();
    let bins = FFT_KEY / 2;
    let mut mags = vec![0.0f32; bins + 1];
    let class: Vec<i8> = (0..bins)
        .map(|bin| {
            let hz = bin as f64 * rate / FFT_KEY as f64;
            if !(65.0..=2100.0).contains(&hz) {
                return -1;
            }
            let note = (12.0 * (hz / 440.0).log2() + 69.0).round() as i64;
            note.rem_euclid(12) as i8
        })
        .collect();
    let mut chroma = [0.0f64; 12];
    let mut offset = 0;
    let mut frames = 0;
    while offset + FFT_KEY <= signal.len() {
        for i in 0..FFT_KEY {
            frame[i] = signal[offset + i] * window[i];
        }
        magnitudes(&fft, &mut frame, &mut spectrum, &mut mags);
        for bin in 0..bins {
            if class[bin] >= 0 {
                chroma[class[bin] as usize] += mags[bin] as f64;
            }
        }
        frames += 1;
        offset += FFT_KEY / 2;
    }
    let total: f64 = chroma.iter().sum();
    if frames == 0 || total <= 0.0 {
        return None;
    }
    chroma.iter_mut().for_each(|c| *c /= total);
    let mut best = ("", f64::NEG_INFINITY);
    for root in 0..12 {
        for (names, profile) in [(&MAJOR_NAMES, &MAJOR_PROFILE), (&MINOR_NAMES, &MINOR_PROFILE)] {
            let score = correlate(&chroma, profile, root);
            if score > best.1 {
                best = (names[root], score);
            }
        }
    }
    Some((best.0.to_string(), best.1))
}

fn correlate(chroma: &[f64; 12], profile: &[f64; 12], root: usize) -> f64 {
    let mean_c = chroma.iter().sum::<f64>() / 12.0;
    let mean_p = profile.iter().sum::<f64>() / 12.0;
    let (mut num, mut dc, mut dp) = (0.0, 0.0, 0.0);
    for i in 0..12 {
        let c = chroma[(i + root) % 12] - mean_c;
        let p = profile[i] - mean_p;
        num += c * p;
        dc += c * c;
        dp += p * p;
    }
    if dc > 0.0 && dp > 0.0 { num / (dc * dp).sqrt() } else { 0.0 }
}

/* ------------------------------------------------------------------ the worker */

#[derive(Clone, Debug)]
pub struct Result {
    pub path: String,
    pub bpm: Option<f64>,
    pub key: Option<(String, f64)>,
    /// The key came from the external command, which states rather than estimates: no fit.
    pub external: bool,
}

/// `analysis:externalKey`: the command with `{file}` filled in, through the shell, its output
/// put through the same normalising a tag's key is.
pub fn external_key(template: &str, path: &str) -> Option<String> {
    use std::os::windows::process::CommandExt;
    if template.trim().is_empty() || !Path::new(path).exists() {
        return None;
    }
    let command = template.replace("{file}", path);
    let out = std::process::Command::new("cmd.exe").args(["/d", "/s", "/c"]).raw_arg(&command).creation_flags(0x0800_0000).stdin(std::process::Stdio::null()).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// Files waiting to be analysed, newest request first, worked through by a couple of
/// threads: what is on screen now is what the user is looking at.
pub struct Queue {
    waiting: Mutex<VecDeque<(String, bool)>>,
    /// Asked for by name (Reprocess), worked through first and never dropped for scrolling.
    pinned: Mutex<VecDeque<(String, bool)>>,
    /// Reprocess all: drained only when nothing on screen is waiting.
    bulk: Mutex<VecDeque<(String, bool)>>,
    ready: Condvar,
    /// How many of the workers may take work (`analysisConcurrency`, 1..10).
    allowed: AtomicUsize,
    key_command: Mutex<String>,
    /// `keyEngine` and `keyProfile`.
    key_engine: Mutex<(String, String)>,
}

/// The most workers there can ever be; the setting picks how many of them run.
const MAX_WORKERS: usize = 10;

impl Queue {
    pub fn spawn(threads: usize, proxy: EventLoopProxy<Wake>) -> Arc<Queue> {
        let queue = Arc::new(Queue {
            waiting: Mutex::new(VecDeque::new()),
            pinned: Mutex::new(VecDeque::new()),
            bulk: Mutex::new(VecDeque::new()),
            ready: Condvar::new(),
            allowed: AtomicUsize::new(threads.clamp(1, MAX_WORKERS)),
            key_command: Mutex::new(String::new()),
            key_engine: Mutex::new(("essentia".into(), "krumhansl".into())),
        });
        for n in 0..MAX_WORKERS {
            let (queue, proxy) = (queue.clone(), proxy.clone());
            let _ = std::thread::Builder::new().name(format!("analysis-{n}")).spawn(move || loop {
                let next = {
                    let mut waiting = queue.waiting.lock().unwrap_or_else(|e| e.into_inner());
                    loop {
                        // A worker past the allowed count sits out until it is let back in.
                        if n >= queue.allowed.load(Ordering::SeqCst) {
                            waiting = queue.ready.wait(waiting).unwrap_or_else(|e| e.into_inner());
                            continue;
                        }
                        if let Some(item) = queue.pinned.lock().ok().and_then(|mut p| p.pop_front()) {
                            break item;
                        }
                        if let Some(item) = waiting.pop_front() {
                            break item;
                        }
                        if let Some(item) = queue.bulk.lock().ok().and_then(|mut b| b.pop_front()) {
                            break item;
                        }
                        waiting = queue.ready.wait(waiting).unwrap_or_else(|e| e.into_inner());
                    }
                };
                let (path, wants_key) = next;
                let _ = proxy.send_event(Wake::Analysing(path.clone()));
                // A configured command answers for the key instead of the detector.
                let command = queue.key_command.lock().map(|c| c.clone()).unwrap_or_default();
                let external = (wants_key && !command.trim().is_empty()).then(|| external_key(&command, &path).and_then(|k| crate::keys::normalise(&k))).flatten();
                let result = match decode(Path::new(&path)) {
                    Some((signal, rate)) => Result {
                        bpm: detect_tempo(&signal, rate).filter(|(_, c)| *c >= MIN_TEMPO_CONFIDENCE).map(|(b, _)| b),
                        key: if let Some(k) = external.clone() {
                            Some((k, 1.0))
                        } else if wants_key && command.trim().is_empty() {
                            // Essentia's reading, or the built-in one where it has none to give
                            // (under three seconds), as the Electron worker falls back.
                            let (engine, profile) = queue.key_engine.lock().map(|e| e.clone()).unwrap_or_default();
                            let found = if engine == "essentia" { crate::essentia_key::detect(&signal, rate as f32, &profile).or_else(|| detect_key(&signal, rate)) } else { detect_key(&signal, rate) };
                            found.filter(|(_, fit)| *fit >= MIN_KEY_FIT)
                        } else {
                            None
                        },
                        external: external.is_some(),
                        path,
                    },
                    None => Result { path, bpm: None, key: None, external: false },
                };
                if proxy.send_event(Wake::Analysed(result)).is_err() {
                    return;
                }
            });
        }
        queue
    }

    /// A whole library's worth, behind everything else.
    pub fn bulk(&self, paths: Vec<(String, bool)>) {
        if let Ok(mut bulk) = self.bulk.lock() {
            bulk.extend(paths);
        }
        let _guard = self.waiting.lock();
        self.ready.notify_all();
    }

    pub fn set_concurrency(&self, n: usize) {
        self.allowed.store(n.clamp(1, MAX_WORKERS), Ordering::SeqCst);
        let _guard = self.waiting.lock();
        self.ready.notify_all();
    }

    pub fn set_key_engine(&self, engine: &str, profile: &str) {
        if let Ok(mut e) = self.key_engine.lock() {
            *e = (engine.to_string(), profile.to_string());
        }
    }

    pub fn set_key_command(&self, command: &str) {
        if let Ok(mut c) = self.key_command.lock() {
            *c = command.to_string();
        }
    }

    /// Files to analyse whatever is on screen.
    pub fn pin(&self, paths: Vec<(String, bool)>) {
        if let Ok(mut pinned) = self.pinned.lock() {
            pinned.extend(paths);
        }
        let _guard = self.waiting.lock();
        self.ready.notify_all();
    }

    /// Puts what is on screen at the front, and drops what scrolled away.
    pub fn want(&self, paths: Vec<(String, bool)>) {
        let mut waiting = self.waiting.lock().unwrap_or_else(|e| e.into_inner());
        waiting.retain(|(p, _)| paths.iter().any(|(q, _)| q == p));
        for item in paths {
            if !waiting.iter().any(|(p, _)| *p == item.0) {
                waiting.push_back(item);
            }
        }
        self.ready.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A click track at 120 BPM: an impulse every half second over a little noise.
    #[test]
    fn finds_a_click_track_tempo() {
        let rate = 11025.0;
        let seconds = 20.0;
        let n = (rate * seconds) as usize;
        let mut seed = 1u32;
        let signal: Vec<f32> = (0..n)
            .map(|i| {
                seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12345);
                let noise = ((seed >> 16) as f32 / 65536.0 - 0.5) * 0.01;
                let phase = i % (rate as usize / 2);
                noise + if phase < 200 { (1.0 - phase as f32 / 200.0) * (i as f32 * 0.3).sin() } else { 0.0 }
            })
            .collect();
        let (bpm, confidence) = detect_tempo(&signal, rate).expect("a tempo");
        assert!((bpm - 120.0).abs() < 1.0, "{bpm}");
        assert!(confidence > MIN_TEMPO_CONFIDENCE, "{confidence}");
    }

    /// An A minor triad sustained: the key comes out as A minor or its relative, C.
    #[test]
    fn hears_a_minor_triad() {
        let rate = 11025.0;
        let n = (rate * 8.0) as usize;
        let freqs = [220.0, 261.63, 329.63, 110.0];
        let signal: Vec<f32> = (0..n).map(|i| freqs.iter().map(|f| (2.0 * std::f64::consts::PI * f * i as f64 / rate).sin() as f32 * 0.2).sum()).collect();
        let (key, fit) = detect_key(&signal, rate).expect("a key");
        assert!(key == "Am" || key == "C", "{key}");
        assert!(fit > 0.4, "{fit}");
    }
}
