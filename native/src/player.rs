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
use std::time::{Duration, Instant};

/// Frames the ring holds: the fine analyser's 8192-point window with room to spare.
pub const RING: usize = 16384;

/// Writes closer together than this are one burst: one pull of the device's buffer, handed over
/// in a few batches microseconds apart.
const BURST_GAP: Duration = Duration::from_millis(2);

/// What the visualizers read: the most recent frames as left and right, and the rate they
/// were played at.
pub struct Ring {
    pub left: Vec<f32>,
    pub right: Vec<f32>,
    /// Frames written since the track started; the next frame lands at `written % RING`.
    pub written: u64,
    pub sample_rate: u32,
    /// Where the newest burst began, and when it arrived.
    burst: Option<(u64, Instant)>,
    /// The time between the last two bursts.
    interval: Option<Duration>,
    /// The last write, which tells the next one whether it starts a burst.
    last_write: Option<Instant>,
}

impl Ring {
    fn new() -> Ring {
        Ring { left: vec![0.0; RING], right: vec![0.0; RING], written: 0, sample_rate: 44100, burst: None, interval: None, last_write: None }
    }

    /// Frames arrive a device buffer at a time: on a Mac rodio asks CoreAudio for ~50ms, so
    /// 2048 frames land at once some 23 times a second. Read straight from the end, every frame
    /// drawn between two bursts showed the same audio and the scope ran at a third of the frame
    /// rate. Notes where each burst starts, and how far apart they come.
    fn wrote(&mut self, before: u64, now: Instant) {
        if self.last_write.is_none_or(|last| now.duration_since(last) > BURST_GAP) {
            if let Some((_, at)) = self.burst {
                self.interval = Some(now.duration_since(at));
            }
            self.burst = Some((before, now));
        }
        self.last_write = Some(now);
    }

    /// The frame the visualizers read up to at `now`: carried from the start of the newest burst
    /// to its end over the time bursts take to come, so the audio moves on each drawn frame as
    /// it does on the speaker. That also keeps it about a buffer behind the end, nearer what is
    /// being heard. Measured from the bursts rather than the sample rate, so varispeed (more
    /// frames a burst) and any device's buffer size come out right.
    pub fn playhead(&self, now: Instant) -> u64 {
        let (Some((start, at)), Some(interval)) = (self.burst, self.interval) else { return self.written };
        if interval.is_zero() || interval > Duration::from_millis(250) {
            return self.written;
        }
        let progress = (now.saturating_duration_since(at).as_secs_f64() / interval.as_secs_f64()).min(1.0);
        start + ((self.written - start) as f64 * progress) as u64
    }

    /// The newest `out.len()` frames of one channel (or of the two averaged, which is how an
    /// AnalyserNode downmixes), oldest first.
    pub fn latest(&self, channel: Channel, out: &mut [f32], now: Instant) {
        let n = out.len().min(RING);
        let end = self.playhead(now) as usize;
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
            let before = ring.written;
            for [l, r] in self.batch.drain(..) {
                let at = (ring.written % RING as u64) as usize;
                ring.left[at] = l;
                ring.right[at] = r;
                ring.written += 1;
            }
            ring.wrote(before, Instant::now());
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

/// Opens `device` with a buffer it takes. rodio asks every device for ~50ms (2048 frames at
/// 48kHz), and a device whose range stops short of that refuses the stream: Bluetooth
/// headphones on a Mac take 15-960 frames, so with those as the output nothing played at all,
/// and rodio's fallbacks ask the other devices for the same. The 50ms is kept where the device
/// takes it and cut to its largest buffer where it does not; failing that, the device's own
/// default. A device that names no range (Windows' shared mode) is asked as rodio asks.
fn open(device: rodio::cpal::Device) -> Result<MixerDeviceSink, rodio::DeviceSinkError> {
    use rodio::cpal::traits::DeviceTrait;
    use rodio::cpal::{BufferSize, SupportedBufferSize};
    let config = device.default_output_config().ok();
    let builder = DeviceSinkBuilder::from_device(device.clone())?;
    let fitted = match config.as_ref().map(|c| (c.buffer_size().clone(), c.sample_rate())) {
        Some((SupportedBufferSize::Range { min, max }, rate)) if min <= max => builder.with_buffer_size(BufferSize::Fixed(aim_frames(rate).clamp(min, max))),
        _ => builder,
    };
    fitted.open_stream().or_else(|first| DeviceSinkBuilder::from_device(device)?.with_buffer_size(BufferSize::Default).open_stream().map_err(|_| first))
}

/// rodio's aim: 50ms of audio, rounded to the nearest power of two.
fn aim_frames(rate: u32) -> u32 {
    let n = (rate / 20).max(1);
    let next = n.next_power_of_two();
    let previous = next >> 1;
    if previous > 0 && n - previous <= next - n { previous } else { next }
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
        let host = rodio::cpal::default_host();
        let chosen = device.filter(|name| !name.is_empty()).and_then(|name| host.output_devices().ok()?.find(|d| d.to_string() == name));
        let opened = match chosen {
            Some(device) => open(device),
            None => host.default_output_device().map_or_else(DeviceSinkBuilder::open_default_sink, open),
        };
        // Whatever rodio finds when the device asked for will not open.
        let mut sink = opened.or_else(|_| DeviceSinkBuilder::open_default_sink())?;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn write(ring: &mut Ring, frames: u64, now: Instant) {
        let before = ring.written;
        ring.written += frames;
        ring.wrote(before, now);
    }

    #[test]
    fn playhead_moves_through_a_burst_between_bursts() {
        let t0 = Instant::now();
        let ms = Duration::from_millis;
        let mut ring = Ring::new();
        // Before two bursts have come there is no interval to pace by: the end.
        write(&mut ring, 2048, t0);
        assert_eq!(ring.playhead(t0 + ms(10)), 2048);
        // One pull, handed over in batches microseconds apart, is one burst.
        for i in 0..8 {
            write(&mut ring, 256, t0 + ms(40) + Duration::from_micros(i * 20));
        }
        assert_eq!(ring.written, 4096);
        let at = t0 + ms(40);
        assert_eq!(ring.playhead(at), 2048);
        // Halfway to the next burst, halfway through this one; past it, held at the end.
        let half = ring.playhead(at + ms(20));
        assert!((2048 + 1000..=2048 + 1048).contains(&half), "{half}");
        assert_eq!(ring.playhead(at + ms(80)), 4096);
        // Each frame drawn between bursts reads a little further on.
        let frames: Vec<u64> = (0..3).map(|i| ring.playhead(at + Duration::from_micros(16_667 * i))).collect();
        assert!(frames[0] < frames[1] && frames[1] < frames[2], "{frames:?}");
    }

    #[test]
    fn buffer_aim_is_rodios_50ms() {
        assert_eq!(aim_frames(48000), 2048);
        assert_eq!(aim_frames(44100), 2048);
        assert_eq!(aim_frames(96000), 4096);
        // What a Bluetooth output takes on a Mac.
        assert_eq!(aim_frames(48000).clamp(15, 960), 960);
    }

    #[test]
    fn playhead_falls_back_to_the_end_after_a_stall() {
        let t0 = Instant::now();
        let mut ring = Ring::new();
        write(&mut ring, 2048, t0);
        write(&mut ring, 2048, t0 + Duration::from_secs(1));
        assert_eq!(ring.playhead(t0 + Duration::from_secs(1)), 4096);
    }
}
