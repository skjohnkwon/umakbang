//! Playback through rodio: symphonia decodes, cpal plays. The file is streamed from disk, never
//! decoded into memory whole - a three-minute stereo file decoded up front is ~60MB of floats.
//!
//! Every sample on its way to the device passes through `Tap`, which keeps the last few
//! thousand frames in a ring the visualizers read. That is the native counterpart of the
//! Electron app's Web Audio graph: there the analysers hang off the media element, here they
//! hang off the source, and both describe exactly what is being played.

use rodio::source::SeekError;
use rodio::{ChannelCount, DeviceSinkBuilder, MixerDeviceSink, Player as RodioPlayer, Sample, SampleRate, Source};
use std::sync::mpsc::{Receiver, Sender, SyncSender, channel, sync_channel};
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
        // `try_lock`, never `lock`: this runs on the audio thread, and waiting there for the
        // visualizers to let go is a gap in the sound - a pop. Busy, the batch waits for the
        // next flush; it is the visualizers that go without, never the speaker.
        match self.ring.try_lock() {
            Ok(mut ring) => {
                let before = ring.written;
                for [l, r] in self.batch.drain(..) {
                    let at = (ring.written % RING as u64) as usize;
                    ring.left[at] = l;
                    ring.right[at] = r;
                    ring.written += 1;
                }
                ring.wrote(before, Instant::now());
            }
            Err(std::sync::TryLockError::WouldBlock) => {
                if self.batch.len() > RING {
                    self.batch.clear();
                }
            }
            Err(std::sync::TryLockError::Poisoned(_)) => self.batch.clear(),
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

/* ------------------------------------------------------------------ decoding ahead */

/// Frames per hand-over from the decoding thread.
const CHUNK_FRAMES: usize = 1024;
/// How far ahead the decoding thread runs: a network read that stalls for this long still
/// plays through.
const AHEAD_SECONDS: usize = 3;
/// Sound coming back after a gap or a seek is faded in over this many frames (~6ms).
const FADE_FRAMES: usize = 256;
/// Frames between the points where rodio looks at the rate again: how soon a varispeed change
/// is heard (about 23ms at 44.1kHz).
const SPAN_FRAMES: usize = 1024;

struct Chunk {
    /// Which seek it was decoded after; anything from before the latest seek is thrown away.
    generation: u64,
    samples: Vec<f32>,
    /// The track ends with this chunk.
    end: bool,
}

enum Order {
    Seek(Duration, u64),
}

/// The decoder, run on a thread of its own and some seconds ahead of the speaker.
///
/// rodio pulls samples from the source inside the audio callback, which has a few milliseconds
/// to fill the device's buffer. Decoding there meant reading the file there: a file on another
/// machine is fetched 512KB at a time over HTTP (`RemoteReader`), and a WAV needs a new block
/// every three seconds, so every three seconds the callback waited on the network and the
/// speaker got a gap - a hard pop. A network share stalls the same way. Now the callback only
/// copies samples already decoded.
///
/// If decoding still falls behind, the sound dies away over a few milliseconds instead of
/// dropping to zero, and comes back faded in: a jump to or from silence is itself the pop.
struct Prefetch {
    chunks: Receiver<Chunk>,
    orders: Sender<Order>,
    chunk: Vec<f32>,
    at: usize,
    generation: u64,
    channels: ChannelCount,
    rate: SampleRate,
    duration: Option<Duration>,
    /// Position within the current frame.
    lane: usize,
    /// Samples out in the current span.
    spun: usize,
    /// Each channel's last value out, decayed while starved.
    held: Vec<f32>,
    /// What was playing when sound came back, still dying away under the fade-in: the new
    /// sound is crossfaded in from it, not from zero, which would be a step if it came back
    /// before the old had died away.
    tail: Vec<f32>,
    starved: bool,
    /// Frames into the fade-in; `FADE_FRAMES` when there is none.
    fade: usize,
    ended: bool,
}

impl Prefetch {
    fn new<S: Source + Send + 'static>(inner: S) -> Prefetch {
        let (channels, rate, duration) = (inner.channels(), inner.sample_rate(), inner.total_duration());
        let width = channels.get() as usize;
        let capacity = (rate.get() as usize * AHEAD_SECONDS / CHUNK_FRAMES).max(4);
        let (chunk_sender, chunks) = sync_channel(capacity);
        let (orders, order_receiver) = channel();
        let _ = std::thread::Builder::new().name("decode".into()).spawn(move || decode(inner, width, chunk_sender, order_receiver));
        let mut prefetch = Prefetch {
            chunks,
            orders,
            chunk: Vec::new(),
            at: 0,
            generation: 0,
            channels,
            rate,
            duration,
            lane: 0,
            spun: 0,
            held: vec![0.0; width],
            tail: vec![0.0; width],
            starved: false,
            fade: 0,
            ended: false,
        };
        // The first chunk is waited for here, on the window's thread, so a track starts with
        // its sound rather than with a stretch of starving.
        if let Ok(first) = prefetch.chunks.recv_timeout(Duration::from_secs(5)) {
            prefetch.ended = first.end;
            prefetch.chunk = first.samples;
        }
        prefetch
    }

    fn advance_lane(&mut self) {
        self.spun += 1;
        if self.spun >= SPAN_FRAMES * self.held.len() {
            self.spun = 0;
        }
        self.lane += 1;
        if self.lane >= self.held.len() {
            self.lane = 0;
            if self.fade < FADE_FRAMES {
                self.fade += 1;
            }
        }
    }
}

/// The decoding thread: whole frames, `CHUNK_FRAMES` at a time, handed over as there is room,
/// with seeks taken between chunks and while waiting for room.
fn decode<S: Source>(mut inner: S, width: usize, out: SyncSender<Chunk>, orders: Receiver<Order>) {
    use std::sync::mpsc::{RecvTimeoutError, TryRecvError, TrySendError};
    let mut generation = 0;
    let mut ended = false;
    loop {
        loop {
            match orders.try_recv() {
                Ok(Order::Seek(to, next)) => {
                    let _ = inner.try_seek(to);
                    generation = next;
                    ended = false;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return,
            }
        }
        if ended {
            // Nothing left to decode until a seek back into the track, or the track is dropped.
            match orders.recv() {
                Ok(Order::Seek(to, next)) => {
                    let _ = inner.try_seek(to);
                    generation = next;
                    ended = false;
                    continue;
                }
                Err(_) => return,
            }
        }
        let mut samples = Vec::with_capacity(CHUNK_FRAMES * width);
        while samples.len() < CHUNK_FRAMES * width {
            match inner.next() {
                Some(sample) => samples.push(sample),
                None => {
                    ended = true;
                    break;
                }
            }
        }
        let mut chunk = Chunk { generation, samples, end: ended };
        loop {
            match out.try_send(chunk) {
                Ok(()) => break,
                Err(TrySendError::Disconnected(_)) => return,
                Err(TrySendError::Full(back)) => {
                    chunk = back;
                    match orders.recv_timeout(Duration::from_millis(10)) {
                        Ok(Order::Seek(to, next)) => {
                            // What was decoded ahead is from before the seek: dropped.
                            let _ = inner.try_seek(to);
                            generation = next;
                            ended = false;
                            break;
                        }
                        Err(RecvTimeoutError::Timeout) => {}
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                }
            }
        }
    }
}

impl Iterator for Prefetch {
    type Item = Sample;

    fn next(&mut self) -> Option<Sample> {
        use std::sync::mpsc::TryRecvError;
        loop {
            if self.at < self.chunk.len() {
                let mut sample = self.chunk[self.at];
                self.at += 1;
                if self.fade < FADE_FRAMES {
                    let gain = self.fade as f32 / FADE_FRAMES as f32;
                    self.tail[self.lane] *= 0.99;
                    sample = sample * gain + self.tail[self.lane] * (1.0 - gain);
                }
                self.held[self.lane] = sample;
                self.advance_lane();
                return Some(sample);
            }
            if self.ended {
                return None;
            }
            // Only at a frame boundary, so a chunk after a gap starts on the left channel.
            if self.lane == 0 {
                match self.chunks.try_recv() {
                    Ok(chunk) => {
                        if chunk.generation != self.generation {
                            continue;
                        }
                        self.ended = chunk.end;
                        self.chunk = chunk.samples;
                        self.at = 0;
                        if self.starved {
                            self.starved = false;
                            self.fade = 0;
                            self.tail.copy_from_slice(&self.held);
                        }
                        continue;
                    }
                    Err(TryRecvError::Empty) => {}
                    Err(TryRecvError::Disconnected) => return None,
                }
            }
            // Starved: each channel's last value dies away (to under 1% in ~10ms) rather than
            // stopping dead.
            self.starved = true;
            let sample = self.held[self.lane] * 0.99;
            self.held[self.lane] = sample;
            self.advance_lane();
            return Some(sample);
        }
    }
}

impl Source for Prefetch {
    /// Fixed spans, though nothing in the track changes between them: rodio reads the rate
    /// again only where a span ends, and varispeed works by changing the rate - with no ends,
    /// a new speed was never heard.
    fn current_span_len(&self) -> Option<usize> {
        Some(SPAN_FRAMES * self.held.len() - self.spun)
    }
    fn channels(&self) -> ChannelCount {
        self.channels
    }
    fn sample_rate(&self) -> SampleRate {
        self.rate
    }
    fn total_duration(&self) -> Option<Duration> {
        self.duration
    }
    /// Handed to the decoding thread, not done here: a seek reads the file, and this is the
    /// audio thread. Until the new position's sound arrives the old one dies away, then the new
    /// one fades in.
    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        self.generation += 1;
        let _ = self.orders.send(Order::Seek(pos, self.generation));
        self.chunk.clear();
        self.at = 0;
        self.ended = false;
        self.starved = true;
        Ok(())
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
        let source = Prefetch::new(source);
        let tap = Tap { inner: source, ring: self.ring.clone(), channels, lane: 0, frame: [0.0; 2], batch: Vec::with_capacity(4096) };
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
    use std::num::NonZero;

    /// A stereo test signal: frame `i` holds `value(i)` in both channels, with an optional stall
    /// before one frame, as a network read stalls.
    struct Signal {
        frames: usize,
        at: usize,
        stall_at: Option<usize>,
        ramp: bool,
    }

    impl Signal {
        fn value(&self, frame: usize) -> f32 {
            if self.ramp { frame as f32 / self.frames as f32 } else { 0.5 }
        }
    }

    impl Iterator for Signal {
        type Item = Sample;
        fn next(&mut self) -> Option<Sample> {
            let frame = self.at / 2;
            if frame >= self.frames {
                return None;
            }
            if self.stall_at == Some(frame) && self.at % 2 == 0 {
                self.stall_at = None;
                std::thread::sleep(Duration::from_millis(150));
            }
            self.at += 1;
            Some(self.value(frame))
        }
    }

    impl Source for Signal {
        fn current_span_len(&self) -> Option<usize> {
            None
        }
        fn channels(&self) -> ChannelCount {
            NonZero::new(2).unwrap()
        }
        fn sample_rate(&self) -> SampleRate {
            NonZero::new(44100).unwrap()
        }
        fn total_duration(&self) -> Option<Duration> {
            None
        }
        fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
            self.at = (pos.as_secs_f64() * 44100.0) as usize * 2;
            Ok(())
        }
    }

    /// Pulls `source` to its end (or `limit` samples), as the audio callback does, and returns
    /// how many samples came out and the largest step between consecutive samples of one channel.
    fn pull(source: &mut Prefetch, limit: usize, previous: &mut [f32; 2]) -> (usize, f32) {
        let (mut count, mut worst) = (0, 0.0f32);
        while count < limit {
            let Some(sample) = source.next() else { break };
            let lane = count % 2;
            worst = worst.max((sample - previous[lane]).abs());
            previous[lane] = sample;
            count += 1;
        }
        (count, worst)
    }

    /// A real file through the real output, silently: `UMAKBANG_TEST_AUDIO=<file> cargo test
    /// --release real_playback -- --ignored`. Three seconds should hand three seconds of frames
    /// to the visualizers, and the position move with them.
    #[test]
    #[ignore]
    fn real_playback_keeps_up() {
        let Ok(path) = std::env::var("UMAKBANG_TEST_AUDIO") else { return };
        let mut player = Player::new(None).expect("output");
        player.set_volume(0.0);
        player.play(&path).expect("play");
        std::thread::sleep(Duration::from_secs(3));
        let (written, rate) = player.ring.lock().map(|r| (r.written, r.sample_rate)).unwrap();
        let seconds = written as f64 / rate as f64;
        eprintln!("{seconds:.2}s of frames in 3s, position {:.2}s", player.position());
        assert!((2.7..3.4).contains(&seconds), "{seconds}");
        assert!((2.7..3.4).contains(&player.position()), "{}", player.position());
        // A seek lands, and playback carries on from there.
        player.seek(30.0);
        std::thread::sleep(Duration::from_secs(1));
        eprintln!("after seek: position {:.2}s", player.position());
        assert!((30.5..31.5).contains(&player.position()), "{}", player.position());
    }

    #[test]
    fn a_speed_change_is_heard_mid_track() {
        use rodio::source::UniformSourceIterator;
        // Two seconds at 44.1kHz, resampled to 44.1kHz the way the output does it; after the
        // first half second the speed doubles, so the rest takes half as long.
        // The speed is set as rodio's own player sets it: from a flag, read every few ms.
        let faster = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = faster.clone();
        let source = Prefetch::new(Signal { frames: 88200, at: 0, stall_at: None, ramp: false })
            .speed(1.0)
            .periodic_access(Duration::from_millis(5), move |s| {
                if flag.load(std::sync::atomic::Ordering::Relaxed) {
                    s.set_factor(2.0);
                }
            });
        let mut out = UniformSourceIterator::new(source, NonZero::new(2).unwrap(), NonZero::new(44100).unwrap());
        let mut frames = 0;
        while out.next().is_some() {
            frames += 1;
            if frames == 2 * 22050 {
                faster.store(true, std::sync::atomic::Ordering::Relaxed);
            }
        }
        let frames = frames / 2;
        // 22050 at the old speed, then 66150 more at double: about 55125 in all, not 88200.
        assert!((54000..56500).contains(&frames), "{frames}");
    }

    #[test]
    fn prefetch_passes_the_track_through_whole() {
        let mut source = Prefetch::new(Signal { frames: 5000, at: 0, stall_at: None, ramp: false });
        let mut out = Vec::new();
        while let Some(sample) = source.next() {
            out.push(sample);
        }
        assert_eq!(out.len(), 10000);
        // Faded in from silence over the first few milliseconds, then the signal as it is.
        assert_eq!(out[0], 0.0);
        assert!(out[2 * FADE_FRAMES..].iter().all(|&s| s == 0.5));
    }

    #[test]
    fn a_stalled_decoder_dies_away_and_fades_back_instead_of_popping() {
        // The decoder stalls for 150ms after a second of audio; the callback keeps pulling.
        let mut source = Prefetch::new(Signal { frames: 88200, at: 0, stall_at: Some(44100), ramp: false });
        let (count, worst) = pull(&mut source, 400_000_000, &mut [0.0; 2]);
        // Every frame still came out (plus however much was filled in while starved)...
        assert!(count >= 176400, "{count}");
        // ...and nowhere did a channel jump: a cut to zero would be a step of 0.5.
        assert!(worst < 0.01, "largest step {worst}");
    }

    #[test]
    fn a_seek_crossfades_through_silence() {
        let mut source = Prefetch::new(Signal { frames: 44100, at: 0, stall_at: None, ramp: true });
        let mut previous = [0.0; 2];
        let (_, before) = pull(&mut source, 20000, &mut previous);
        source.try_seek(Duration::from_millis(800)).unwrap();
        let (_, after) = pull(&mut source, 400_000_000, &mut previous);
        // The ramp is at ~0.23 when the seek lands at 0.8: a jump of 0.57 if not faded.
        assert!(before < 0.01 && after < 0.01, "{before} {after}");
    }

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
