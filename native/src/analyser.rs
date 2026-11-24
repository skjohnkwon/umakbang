//! Web Audio's `AnalyserNode`, as Chromium implements it (`RealtimeAnalyser`), so the panels
//! fed by it draw what the Electron app's panels draw from the same sound.
//!
//! The frequency path is Chromium's: the newest `size` samples, a Blackman window, a real FFT
//! scaled by `1 / size`, then each bin smoothed against its value from the previous call and
//! mapped from `[min_db, max_db]` onto a byte. The byte is truncated, not rounded, and the dB
//! of an exact zero is far below any floor: both as Chromium has them.

use realfft::{RealFftPlanner, RealToComplex};
use std::sync::Arc;

pub struct Analyser {
    pub size: usize,
    smoothing: f32,
    min_db: f32,
    max_db: f32,
    window: Vec<f32>,
    smoothed: Vec<f32>,
    fft: Arc<dyn RealToComplex<f32>>,
    input: Vec<f32>,
    spectrum: Vec<realfft::num_complex::Complex<f32>>,
    scratch: Vec<realfft::num_complex::Complex<f32>>,
}

impl Analyser {
    pub fn new(size: usize, smoothing: f32, min_db: f32, max_db: f32) -> Analyser {
        let fft = RealFftPlanner::<f32>::new().plan_fft_forward(size);
        // Blackman with alpha 0.16, the window the spec names.
        let window = (0..size)
            .map(|i| {
                let x = i as f64 / size as f64;
                (0.42 - 0.5 * (2.0 * std::f64::consts::PI * x).cos() + 0.08 * (4.0 * std::f64::consts::PI * x).cos()) as f32
            })
            .collect();
        Analyser {
            size,
            smoothing,
            min_db,
            max_db,
            window,
            smoothed: vec![0.0; size / 2],
            input: vec![0.0; size],
            spectrum: fft.make_output_vec(),
            scratch: fft.make_scratch_vec(),
            fft,
        }
    }

    pub fn bins(&self) -> usize {
        self.size / 2
    }

    /// One analysis over `samples` (the newest `size`), folded into the smoothed magnitudes.
    /// Chromium runs this once per render quantum however often it is asked; this app asks once
    /// per frame, which is what the panels do too.
    pub fn analyse(&mut self, samples: &[f32]) {
        for ((dst, &src), &w) in self.input.iter_mut().zip(samples).zip(&self.window) {
            *dst = src * w;
        }
        if self.fft.process_with_scratch(&mut self.input, &mut self.spectrum, &mut self.scratch).is_err() {
            return;
        }
        let scale = 1.0 / self.size as f32;
        let k = self.smoothing;
        for (i, smoothed) in self.smoothed.iter_mut().enumerate() {
            // The packed Nyquist term is dropped: bin 0 carries the DC term alone.
            let c = self.spectrum[i];
            let magnitude = if i == 0 { c.re.abs() } else { (c.re * c.re + c.im * c.im).sqrt() } * scale;
            let next = k * *smoothed + (1.0 - k) * magnitude;
            *smoothed = if next.is_finite() { next } else { 0.0 };
        }
    }

    /// `getByteFrequencyData`.
    pub fn bytes(&self, out: &mut [u8]) {
        let range = 1.0 / (self.max_db - self.min_db);
        for (dst, &m) in out.iter_mut().zip(&self.smoothed) {
            let db = if m > 0.0 { 20.0 * m.log10() } else { -1000.0 };
            let scaled = 255.0 * (db - self.min_db) * range;
            *dst = scaled.clamp(0.0, 255.0) as u8;
        }
    }
}

/// `getByteTimeDomainData`: 128 at silence, truncated.
pub fn time_bytes(samples: &[f32], out: &mut [u8]) {
    for (dst, &s) in out.iter_mut().zip(samples) {
        *dst = (128.0 * (s + 1.0)).clamp(0.0, 255.0) as u8;
    }
}
