//! Playback through rodio: symphonia decodes, cpal plays. The file is streamed from disk, never
//! decoded into memory whole - a three-minute stereo file decoded up front is ~60MB of floats.
//!
//! Every sample on its way to the device passes through `Tap`, which keeps the last few
//! thousand frames in a ring the visualizers read. That is the native counterpart of the
//! Electron app's Web Audio graph: there the analysers hang off the media element, here they
//! hang off the source, and both describe exactly what is being played.

use rodio::source::SeekError;
use rodio::{ChannelCount, DeviceSinkBuilder, MixerDeviceSink, Player as RodioPlayer, Sample, SampleRate, Source};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Frames the ring holds: the fine analyser's 8192-point window with room to spare.
pub const RING: usize = 16384;

/// What the visualizers read: the most recent frames as left and right, and the rate they
/// were played at.
pub struct Ring {
    pub left: Vec<f32>,
    pub right: Vec<f32>,
    /// Frames written since the track started; the next frame lands at `written % RING`.
    pub written: u64,
    pub sample_rate: u32,
}

impl Ring {
    fn new() -> Ring {
        Ring { left: vec![0.0; RING], right: vec![0.0; RING], written: 0, sample_rate: 44100 }
    }

    /// The newest `out.len()` frames of one channel (or of the two averaged, which is how an
    /// AnalyserNode downmixes), oldest first.
    pub fn latest(&self, channel: Channel, out: &mut [f32]) {
        let n = out.len().min(RING);
        let end = self.written as usize;
        for (i, value) in out.iter_mut().enumerate() {
            let back = n - i;
            if back > end {
                *value = 0.0;
                continue;
            }
            let at = (end - back) % RING;
            *value = match channel {
                Channel::Left => self.left[at],
                Channel::Right => self.right[at],
                Channel::Mono => (self.left[at] + self.right[at]) * 0.5,
            };
        }
    }
}

#[derive(Clone, Copy)]
pub enum Channel {
    Left,
    Right,
    Mono,
}

/// Copies frames into the ring as they are pulled. Collected in a small batch first so the
/// lock is taken once per few hundred frames rather than per sample.
struct Tap<S> {
    inner: S,
    ring: Arc<Mutex<Ring>>,
    channels: usize,
    /// Position within the current frame.
    lane: usize,
    frame: [f32; 2],
    batch: Vec<[f32; 2]>,
}

impl<S: Source> Tap<S> {
    fn flush(&mut self) {
        if self.batch.is_empty() {
            return;
        }
        if let Ok(mut ring) = self.ring.lock() {
            for [l, r] in self.batch.drain(..) {
                let at = (ring.written % RING as u64) as usize;
                ring.left[at] = l;
                ring.right[at] = r;
                ring.written += 1;
            }
        } else {
            self.batch.clear();
        }
    }
}

impl<S: Source> Iterator for Tap<S> {
    type Item = Sample;

    fn next(&mut self) -> Option<Sample> {
        let Some(sample) = self.inner.next() else {
            self.flush();
            return None;
        };
        let value = sample as f32;
        match self.lane {
            0 => self.frame = [value, value],
            1 => self.frame[1] = value,
            _ => {}
        }
        self.lane += 1;
        if self.lane >= self.channels {
            self.lane = 0;
            self.batch.push(self.frame);
            if self.batch.len() >= 256 {
                self.flush();
            }
        }
        Some(sample)
    }
}

impl<S: Source> Source for Tap<S> {
    fn current_span_len(&self) -> Option<usize> {
        self.inner.current_span_len()
    }
    fn channels(&self) -> ChannelCount {
        self.inner.channels()
    }
    fn sample_rate(&self) -> SampleRate {
        self.inner.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        self.inner.total_duration()
    }
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        self.inner.try_seek(pos)
    }
}

pub struct Player {
    // The output device; playback stops if it is dropped.
    _sink: MixerDeviceSink,
    player: RodioPlayer,
    pub ring: Arc<Mutex<Ring>>,
    /// The decoder's own idea of the length, when the container states one.
    pub duration: Option<f64>,
}

impl Player {
    /// Output devices by name, as Windows names them.
    pub fn devices() -> Vec<String> {
        use rodio::cpal::traits::HostTrait;
        rodio::cpal::default_host().output_devices().map(|devices| devices.map(|d| d.to_string()).collect()).unwrap_or_default()
    }

    /// Through the named device, or the system default when it is not given or not there.
    pub fn new(device: Option<&str>) -> Result<Player, Box<dyn std::error::Error>> {
        use rodio::cpal::traits::HostTrait;
        let chosen = device.filter(|name| !name.is_empty()).and_then(|name| rodio::cpal::default_host().output_devices().ok()?.find(|d| d.to_string() == name));
        let mut sink = match chosen {
            Some(device) => DeviceSinkBuilder::from_device(device).and_then(|b| b.open_stream()).or_else(|_| DeviceSinkBuilder::open_default_sink())?,
            None => DeviceSinkBuilder::open_default_sink()?,
        };
        // rodio prints a line to stderr when the sink is dropped; there is no console to read it.
        sink.log_on_drop(false);
        let player = RodioPlayer::connect_new(sink.mixer());
        Ok(Player { _sink: sink, player, ring: Arc::new(Mutex::new(Ring::new())), duration: None })
    }

    pub fn play(&mut self, path: &str) -> Result<(), Box<dyn std::error::Error>> {
        // From the `File`, not a `BufReader` of it: only that form tells the decoder the length
        // and that it may seek. Without it a seek forward still works, by decoding and dropping
        // samples, and a seek backward fails silently - click behind the playhead and nothing.
        // Local or on another machine: `remote::decoder` opens either.
        let source = crate::remote::decoder(path)?;
        self.duration = source.total_duration().map(|d| d.as_secs_f64());
        if let Ok(mut ring) = self.ring.lock() {
            *ring = Ring::new();
            ring.sample_rate = source.sample_rate().get();
        }
        let channels = source.channels().get() as usize;
        let tap = Tap { inner: source, ring: self.ring.clone(), channels, lane: 0, frame: [0.0; 2], batch: Vec::with_capacity(256) };
        self.player.clear();
        self.player.append(tap);
        self.player.play();
        Ok(())
    }

    pub fn toggle(&self) {
        if self.player.is_paused() {
            self.player.play();
        } else {
            self.player.pause();
        }
    }

    pub fn is_paused(&self) -> bool {
        self.player.is_paused()
    }

    /// Nothing left to play: the track ran out (or never started).
    pub fn finished(&self) -> bool {
        self.player.empty()
    }

    pub fn position(&self) -> f64 {
        self.player.get_pos().as_secs_f64()
    }

    /// Output level. The tap sits before it, so the visualizers read the same at any volume.
    pub fn set_volume(&self, volume: f32) {
        self.player.set_volume(volume);
    }

    pub fn pause(&self) {
        self.player.pause();
    }

    /// Varispeed: one rate for tempo and pitch together, as tape - which is what playing the
    /// samples faster is.
    pub fn set_speed(&self, rate: f32) {
        self.player.set_speed(rate);
    }

    pub fn seek(&self, seconds: f64) {
        let _ = self.player.try_seek(Duration::from_secs_f64(seconds.max(0.0)));
    }
}
