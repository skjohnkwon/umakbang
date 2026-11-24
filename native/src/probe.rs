//! Reading what a file is from its headers alone (`src/main/probe.ts`), never by decoding it:
//! a 256KB window from the head and 64KB from the tail, parsed per container - WAV, AIFF,
//! FLAC, MP3, MP4/M4A, Ogg/Opus - plus ID3 and Vorbis comments, the ACID loop chunk, and the
//! tempo and key a file name carries. FL Studio projects answer with their own time record
//! (`flp.ts`).

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

const HEAD_BYTES: usize = 256 * 1024;
const TAIL_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Meta {
    pub duration: Option<f64>,
    pub sample_rate: Option<i64>,
    pub bit_depth: Option<i64>,
    pub channels: Option<i64>,
    pub bitrate: Option<i64>,
    pub bpm: Option<f64>,
    pub key: Option<String>,
    /// FL Studio: when the project was made, and how long it has been open, in seconds.
    pub project_created: Option<f64>,
    pub project_seconds: Option<f64>,
}

struct Windows {
    head: Vec<u8>,
    tail: Vec<u8>,
    tail_offset: usize,
    size: usize,
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}
fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

/// `plausibleBpm`: the range music is played at, not the range a float can hold.
pub fn plausible_bpm(v: f64) -> bool {
    v.is_finite() && (40.0..=220.0).contains(&v)
}

fn u16le(b: &[u8], o: usize) -> u32 {
    b.get(o..o + 2).map_or(0, |s| u16::from_le_bytes([s[0], s[1]]) as u32)
}
fn u32le(b: &[u8], o: usize) -> u32 {
    b.get(o..o + 4).map_or(0, |s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}
fn u16be(b: &[u8], o: usize) -> u32 {
    b.get(o..o + 2).map_or(0, |s| u16::from_be_bytes([s[0], s[1]]) as u32)
}
fn u32be(b: &[u8], o: usize) -> u32 {
    b.get(o..o + 4).map_or(0, |s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}
fn ascii(b: &[u8], from: usize, to: usize) -> &[u8] {
    b.get(from..to).unwrap_or(&[])
}

pub fn probe(path: &Path, ext: &str) -> Meta {
    if ext == "flp" {
        let Ok(data) = std::fs::read(path) else { return Meta::default() };
        let Some(project) = parse_flp(&data) else { return Meta::default() };
        // Each part on its own: a project with no time record still has a tempo, and the
        // tempo is the one fact in a folder of bounces that is not a reading.
        return Meta { project_created: project.created_ms, project_seconds: project.seconds, bpm: project.bpm.filter(|b| plausible_bpm(*b)), ..Meta::default() };
    }
    let Some(windows) = read_windows(path) else { return Meta::default() };
    if windows.size == 0 {
        return Meta::default();
    }
    let mut meta = match ext {
        "wav" | "wave" => parse_wav(&windows),
        "aif" | "aiff" | "aifc" => parse_aiff(&windows),
        "flac" => parse_flac(&windows),
        "mp3" => {
            let mut m = parse_mp3(&windows, None);
            // Cover art bigger than the head window pushes the first frame past what was
            // read; one more bounded read at the end of the tag closes the gap.
            if m.sample_rate.is_none() {
                if let Some(audio) = read_past_id3(path, &windows) {
                    m = parse_mp3(&windows, Some(audio));
                }
            }
            m
        }
        "m4a" | "mp4" | "aac" => parse_mp4(&windows),
        "ogg" | "oga" | "opus" => parse_ogg(&windows),
        _ => Meta::default(),
    };
    // File names carry tempo and key more often than tags do: they fill gaps, never override.
    let (bpm, key) = name_hints(&path.to_string_lossy());
    if meta.bpm.is_none() {
        meta.bpm = bpm;
    }
    if meta.key.is_none() {
        meta.key = key;
    }
    meta
}

fn read_windows(path: &Path) -> Option<Windows> {
    let mut file = File::open(path).ok()?;
    let size = file.metadata().ok()?.len() as usize;
    if size == 0 {
        return Some(Windows { head: Vec::new(), tail: Vec::new(), tail_offset: 0, size: 0 });
    }
    let head_len = HEAD_BYTES.min(size);
    let mut head = vec![0u8; head_len];
    let read = read_full(&mut file, &mut head);
    head.truncate(read);
    let (mut tail, mut tail_offset) = (head.clone(), 0);
    if size > head_len {
        let tail_len = TAIL_BYTES.min(size);
        tail_offset = size - tail_len;
        tail = vec![0u8; tail_len];
        file.seek(SeekFrom::Start(tail_offset as u64)).ok()?;
        let read = read_full(&mut file, &mut tail);
        tail.truncate(read);
    }
    Some(Windows { head, tail, tail_offset, size })
}

fn read_full(file: &mut File, buf: &mut [u8]) -> usize {
    let mut filled = 0;
    while filled < buf.len() {
        match file.read(&mut buf[filled..]) {
            Ok(0) | Err(_) => break,
            Ok(n) => filled += n,
        }
    }
    filled
}

fn read_past_id3(path: &Path, w: &Windows) -> Option<(Vec<u8>, usize)> {
    if w.head.len() < 10 || ascii(&w.head, 0, 3) != b"ID3" {
        return None;
    }
    let start = 10 + synchsafe(&w.head, 6);
    if start < w.head.len() || start >= w.size {
        return None;
    }
    let mut file = File::open(path).ok()?;
    file.seek(SeekFrom::Start(start as u64)).ok()?;
    let mut buf = vec![0u8; TAIL_BYTES.min(w.size - start)];
    let read = read_full(&mut file, &mut buf);
    buf.truncate(read);
    (read > 0).then_some((buf, start))
}

/* ------------------------------------------------------------------ WAV */

fn parse_wav(w: &Windows) -> Meta {
    let h = &w.head;
    if h.len() < 12 || ascii(h, 0, 4) != b"RIFF" || ascii(h, 8, 12) != b"WAVE" {
        return Meta::default();
    }
    let mut meta = Meta::default();
    let (mut byte_rate, mut data_size, mut frames) = (0u64, 0u64, 0u64);
    let mut off = 12;
    while off + 8 <= h.len() {
        let id = ascii(h, off, off + 4);
        let chunk = u32le(h, off + 4) as usize;
        let body = off + 8;
        if id == b"fmt " && body + 16 <= h.len() {
            let mut format = u16le(h, body);
            meta.channels = Some(u16le(h, body + 2) as i64);
            meta.sample_rate = Some(u32le(h, body + 4) as i64);
            byte_rate = u32le(h, body + 8) as u64;
            let bits = u16le(h, body + 14);
            // WAVE_FORMAT_EXTENSIBLE hides the real codec in the extension.
            if format == 0xfffe && body + 40 <= h.len() {
                format = u16le(h, body + 24);
            }
            if format == 1 || format == 3 {
                meta.bit_depth = Some(bits as i64);
            }
            if byte_rate > 0 {
                meta.bitrate = Some((byte_rate * 8) as i64);
            }
        } else if id == b"data" {
            // A truncated or streamed file can declare more than is there.
            data_size = (chunk as u64).min(w.size.saturating_sub(body) as u64);
        } else if id == b"fact" && body + 4 <= h.len() {
            frames = u32le(h, body) as u64;
        } else if id == b"acid" && body + 24 <= h.len() {
            // A loop's tempo and root - unless the chunk says it is a one-shot, which a pack
            // tool still writes a beat count into.
            let one_shot = u32le(h, body) & 1 != 0;
            let tempo = f32::from_le_bytes([h[body + 20], h[body + 21], h[body + 22], h[body + 23]]) as f64;
            if !one_shot && plausible_bpm(round2(tempo)) {
                meta.bpm = Some(round2(tempo));
            }
            let root = u16le(h, body + 4);
            if !one_shot && root <= 127 {
                meta.key = Some(PITCH_CLASSES[(root % 12) as usize].to_string());
            }
        } else if id == b"ID3 " || id == b"id3 " {
            apply_id3(&h[body.min(h.len())..(body + chunk).min(h.len())], &mut meta);
        }
        // Word-aligned: an odd size is followed by a pad byte.
        if chunk == 0 {
            break;
        }
        off = body + chunk + (chunk % 2);
    }
    if let Some(rate) = meta.sample_rate.filter(|&r| r > 0) {
        if byte_rate > 0 && data_size > 0 {
            meta.duration = Some(round3(data_size as f64 / byte_rate as f64));
        } else if frames > 0 {
            meta.duration = Some(round3(frames as f64 / rate as f64));
        }
    }
    meta
}

/* ------------------------------------------------------------------ AIFF */

fn parse_aiff(w: &Windows) -> Meta {
    let h = &w.head;
    if h.len() < 12 || ascii(h, 0, 4) != b"FORM" || !(ascii(h, 8, 12) == b"AIFF" || ascii(h, 8, 12) == b"AIFC") {
        return Meta::default();
    }
    let mut meta = Meta::default();
    let mut off = 12;
    while off + 8 <= h.len() {
        let id = ascii(h, off, off + 4);
        let chunk = u32be(h, off + 4) as usize;
        let body = off + 8;
        if id == b"COMM" && body + 18 <= h.len() {
            let channels = u16be(h, body) as i64;
            let frames = u32be(h, body + 2) as f64;
            let bits = u16be(h, body + 6) as i64;
            meta.channels = Some(channels);
            meta.bit_depth = Some(bits);
            let rate = extended80(h, body + 8);
            if rate > 0.0 {
                meta.sample_rate = Some(rate.round() as i64);
                meta.duration = Some(round3(frames / rate));
                if channels > 0 && bits > 0 {
                    meta.bitrate = Some((rate * channels as f64 * bits as f64).round() as i64);
                }
            }
        } else if id == b"ID3 " {
            apply_id3(&h[body.min(h.len())..(body + chunk).min(h.len())], &mut meta);
        }
        if chunk == 0 {
            break;
        }
        off = body + chunk + (chunk % 2);
    }
    meta
}

/// The 80-bit extended float AIFF keeps its sample rate in.
fn extended80(b: &[u8], off: usize) -> f64 {
    if off + 10 > b.len() {
        return 0.0;
    }
    let sign = if b[off] & 0x80 != 0 { -1.0 } else { 1.0 };
    let exponent = (((b[off] & 0x7f) as i32) << 8) | b[off + 1] as i32;
    let mut mantissa = 0f64;
    for i in 0..8 {
        mantissa = mantissa * 256.0 + b[off + 2 + i] as f64;
    }
    if exponent == 0 && mantissa == 0.0 {
        return 0.0;
    }
    sign * mantissa * 2f64.powi(exponent - 16383 - 63)
}

/* ------------------------------------------------------------------ FLAC */

fn parse_flac(w: &Windows) -> Meta {
    let h = &w.head;
    if h.len() < 8 || ascii(h, 0, 4) != b"fLaC" {
        return Meta::default();
    }
    let mut meta = Meta::default();
    let mut off = 4;
    while off + 4 <= h.len() {
        let last = h[off] & 0x80 != 0;
        let kind = h[off] & 0x7f;
        let size = ((h[off + 1] as usize) << 16) | ((h[off + 2] as usize) << 8) | h[off + 3] as usize;
        let body = off + 4;
        if body + size > h.len() {
            break;
        }
        if kind == 0 && size >= 34 {
            // STREAMINFO is bit-packed.
            let mut bits = Bits { buf: h, at: body * 8 };
            bits.skip(16 + 16 + 24 + 24);
            let rate = bits.read(20);
            meta.sample_rate = Some(rate as i64);
            meta.channels = Some(bits.read(3) as i64 + 1);
            meta.bit_depth = Some(bits.read(5) as i64 + 1);
            let total = bits.read(4) * 2u64.pow(32) + bits.read(32);
            if rate > 0 && total > 0 {
                meta.duration = Some(round3(total as f64 / rate as f64));
            }
        } else if kind == 4 {
            apply_vorbis(&h[body..body + size], &mut meta);
        }
        off = body + size;
        if last {
            break;
        }
    }
    meta
}

struct Bits<'a> {
    buf: &'a [u8],
    at: usize,
}

impl Bits<'_> {
    fn skip(&mut self, n: usize) {
        self.at += n;
    }
    fn read(&mut self, n: usize) -> u64 {
        let mut value = 0u64;
        for _ in 0..n {
            let byte = self.buf.get(self.at >> 3).copied().unwrap_or(0);
            value = value * 2 + ((byte >> (7 - (self.at & 7))) & 1) as u64;
            self.at += 1;
        }
        value
    }
}

fn apply_vorbis(b: &[u8], meta: &mut Meta) {
    if b.len() < 4 {
        return;
    }
    let mut off = 4 + u32le(b, 0) as usize;
    if off + 4 > b.len() {
        return;
    }
    let count = u32le(b, off);
    off += 4;
    for _ in 0..count {
        if off + 4 > b.len() {
            break;
        }
        let len = u32le(b, off) as usize;
        off += 4;
        if off + len > b.len() {
            break;
        }
        let entry = String::from_utf8_lossy(&b[off..off + len]).into_owned();
        off += len;
        if let Some((name, value)) = entry.split_once('=') {
            apply_tag(&name.to_uppercase(), value, meta);
        }
    }
}

/* ------------------------------------------------------------------ MP3 */

fn bitrate_table(version_group: u32, layer: u32) -> Option<[i32; 16]> {
    Some(match (version_group, layer) {
        (1, 3) => [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, -1],
        (1, 2) => [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, -1],
        (1, 1) => [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, -1],
        (2, 3) | (2, 2) => [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, -1],
        (2, 1) => [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, -1],
        _ => return None,
    })
}

fn rate_table(version_bits: u32) -> Option<[u32; 4]> {
    Some(match version_bits {
        3 => [44100, 48000, 32000, 0],
        2 => [22050, 24000, 16000, 0],
        0 => [11025, 12000, 8000, 0],
        _ => return None,
    })
}

struct Frame {
    sample_rate: u32,
    bitrate: u32,
    channels: u32,
    samples_per_frame: u32,
    side_info: usize,
}

fn frame_header(b: &[u8], off: usize) -> Option<Frame> {
    if off + 4 > b.len() {
        return None;
    }
    let (b1, b2, b3) = (b[off + 1] as u32, b[off + 2] as u32, b[off + 3] as u32);
    let version_bits = (b1 >> 3) & 3;
    let layer_bits = (b1 >> 1) & 3;
    if version_bits == 1 || layer_bits == 0 {
        return None;
    }
    let layer = 4 - layer_bits;
    let group = if version_bits == 3 { 1 } else { 2 };
    let kbps = bitrate_table(group, layer)?[((b2 >> 4) & 0x0f) as usize];
    let rate = rate_table(version_bits)?[((b2 >> 2) & 3) as usize];
    if kbps <= 0 || rate == 0 {
        return None;
    }
    let channels = if (b3 >> 6) & 3 == 3 { 1 } else { 2 };
    let samples_per_frame = match layer {
        1 => 384,
        2 => 1152,
        _ if version_bits == 3 => 1152,
        _ => 576,
    };
    let side_info = match (version_bits == 3, channels == 1) {
        (true, true) => 17,
        (true, false) => 32,
        (false, true) => 9,
        (false, false) => 17,
    };
    Some(Frame { sample_rate: rate, bitrate: kbps as u32 * 1000, channels, samples_per_frame, side_info })
}

fn find_sync(b: &[u8], from: usize) -> Option<usize> {
    let limit = b.len().saturating_sub(4).min(from + 128 * 1024);
    (from..limit).find(|&i| b[i] == 0xff && b[i + 1] & 0xe0 == 0xe0 && frame_header(b, i).is_some())
}

fn parse_mp3(w: &Windows, audio: Option<(Vec<u8>, usize)>) -> Meta {
    let h = &w.head;
    let mut meta = Meta::default();
    let mut audio_start = 0;
    if h.len() > 10 && ascii(h, 0, 3) == b"ID3" {
        let tag = synchsafe(h, 6);
        apply_id3(&h[..(10 + tag).min(h.len())], &mut meta);
        audio_start = 10 + tag;
    }
    let (frames, search, file_start): (&[u8], usize, usize) = match &audio {
        Some((buf, at)) => (buf, 0, *at),
        None => (h, audio_start, audio_start),
    };
    let Some(at) = find_sync(frames, search) else { return meta };
    let Some(header) = frame_header(frames, at) else { return meta };
    meta.sample_rate = Some(header.sample_rate as i64);
    meta.channels = Some(header.channels as i64);
    // Xing/Info or VBRI hold the frame count: the only true length of a VBR file.
    let xing = at + header.side_info + 4;
    let (mut count, mut bytes) = (0u64, 0u64);
    if xing + 16 <= frames.len() {
        let tag = ascii(frames, xing, xing + 4);
        if tag == b"Xing" || tag == b"Info" {
            let flags = u32be(frames, xing + 4);
            let mut cursor = xing + 8;
            if flags & 1 != 0 {
                count = u32be(frames, cursor) as u64;
                cursor += 4;
            }
            if flags & 2 != 0 {
                bytes = u32be(frames, cursor) as u64;
            }
        }
    }
    let vbri = at + 36;
    if count == 0 && vbri + 26 <= frames.len() && ascii(frames, vbri, vbri + 4) == b"VBRI" {
        bytes = u32be(frames, vbri + 10) as u64;
        count = u32be(frames, vbri + 14) as u64;
    }
    if count > 0 {
        let duration = round3((count * header.samples_per_frame as u64) as f64 / header.sample_rate as f64);
        meta.duration = Some(duration);
        meta.bitrate = Some(if bytes > 0 && duration > 0.0 { ((bytes * 8) as f64 / duration).round() as i64 } else { header.bitrate as i64 });
    } else {
        // Constant bitrate: the payload's size says how long.
        let id3v1 = if w.tail.len() >= 128 && ascii(&w.tail, w.tail.len() - 128, w.tail.len() - 125) == b"TAG" { 128 } else { 0 };
        let audio_bytes = w.size as i64 - file_start as i64 - id3v1;
        meta.bitrate = Some(header.bitrate as i64);
        if header.bitrate > 0 && audio_bytes > 0 {
            meta.duration = Some(round3((audio_bytes * 8) as f64 / header.bitrate as f64));
        }
    }
    meta
}

/* ------------------------------------------------------------------ MP4 */

#[derive(Clone, Copy)]
struct Atom {
    body: usize,
    end: usize,
}

fn find_atom(b: &[u8], from: usize, to: usize, kind: &[u8]) -> Option<Atom> {
    let mut off = from;
    while off + 8 <= to {
        let mut size = u32be(b, off) as u64;
        let atom = ascii(b, off + 4, off + 8);
        let mut body = off + 8;
        if size == 1 {
            if off + 16 > to {
                return None;
            }
            size = u32be(b, off + 8) as u64 * 2u64.pow(32) + u32be(b, off + 12) as u64;
            body = off + 16;
        } else if size == 0 {
            size = (to - off) as u64;
        }
        if size < 8 {
            return None;
        }
        let end = (off as u64 + size).min(to as u64) as usize;
        if atom == kind {
            return Some(Atom { body, end });
        }
        off = (off as u64 + size).min(usize::MAX as u64) as usize;
    }
    None
}

fn find_path(b: &[u8], from: usize, to: usize, path: &[&[u8]]) -> Option<Atom> {
    let mut current = Atom { body: from, end: to };
    for kind in path {
        let next = find_atom(b, current.body, current.end, kind)?;
        // `meta` is a full atom: version and flags before its children.
        current = if *kind == b"meta" { Atom { body: next.body + 4, end: next.end } } else { next };
    }
    Some(current)
}

/// A top-level atom past the head window, found by hopping atom to atom on their sizes.
fn locate_tail_atom(w: &Windows, kind: &[u8]) -> Option<Atom> {
    let mut off = 0usize;
    while off + 8 <= w.size {
        let (container, local): (&[u8], usize) = if off + 8 <= w.head.len() {
            (&w.head, off)
        } else if off >= w.tail_offset && off - w.tail_offset + 8 <= w.tail.len() {
            (&w.tail, off - w.tail_offset)
        } else {
            return None;
        };
        let mut size = u32be(container, local) as u64;
        let atom = ascii(container, local + 4, local + 8);
        let mut body = off + 8;
        if size == 1 {
            if local + 16 > container.len() {
                return None;
            }
            size = u32be(container, local + 8) as u64 * 2u64.pow(32) + u32be(container, local + 12) as u64;
            body = off + 16;
        } else if size == 0 {
            size = (w.size - off) as u64;
        }
        if size < 8 {
            return None;
        }
        if atom == kind {
            if off < w.tail_offset {
                return None;
            }
            return Some(Atom { body: body - w.tail_offset, end: ((off as u64 + size).min(w.size as u64) as usize) - w.tail_offset });
        }
        off = off.saturating_add(size as usize);
    }
    None
}

fn parse_mp4(w: &Windows) -> Meta {
    let mut meta = Meta::default();
    let (buf, moov): (&[u8], Atom) = match find_atom(&w.head, 0, w.head.len(), b"moov") {
        Some(moov) => (&w.head, moov),
        // Without +faststart the moov comes after the media, near the end.
        None => match locate_tail_atom(w, b"moov") {
            Some(moov) => (&w.tail, moov),
            None => return meta,
        },
    };
    if let Some(mvhd) = find_atom(buf, moov.body, moov.end, b"mvhd") {
        let version = buf.get(mvhd.body).copied().unwrap_or(0);
        if version == 1 && mvhd.body + 28 <= buf.len() {
            let scale = u32be(buf, mvhd.body + 20) as f64;
            let duration = u32be(buf, mvhd.body + 24) as f64 * 2f64.powi(32) + u32be(buf, mvhd.body + 28) as f64;
            if scale > 0.0 {
                meta.duration = Some(round3(duration / scale));
            }
        } else if mvhd.body + 20 <= buf.len() {
            let scale = u32be(buf, mvhd.body + 12) as f64;
            let duration = u32be(buf, mvhd.body + 16) as f64;
            if scale > 0.0 {
                meta.duration = Some(round3(duration / scale));
            }
        }
    }
    if let Some(trak) = find_atom(buf, moov.body, moov.end, b"trak") {
        if let Some(stsd) = find_path(buf, trak.body, trak.end, &[b"mdia", b"minf", b"stbl", b"stsd"]) {
            let entry = stsd.body + 8;
            if entry + 36 <= buf.len() {
                meta.channels = Some(u16be(buf, entry + 24) as i64);
                let bits = u16be(buf, entry + 26);
                if bits > 0 && bits <= 32 {
                    meta.bit_depth = Some(bits as i64);
                }
                meta.sample_rate = Some((u32be(buf, entry + 32) >> 16) as i64);
            }
        }
    }
    if let Some(ilst) = find_path(buf, moov.body, moov.end, &[b"udta", b"meta", b"ilst"]) {
        let mut off = ilst.body;
        while off + 8 <= ilst.end {
            let size = u32be(buf, off) as usize;
            if size < 8 {
                break;
            }
            let name = ascii(buf, off + 4, off + 8).to_vec();
            if let Some(data) = find_atom(buf, off + 8, (off + size).min(ilst.end), b"data") {
                if data.body + 8 <= buf.len() {
                    let payload = &buf[(data.body + 8).min(data.end)..data.end];
                    if name == b"tmpo" && payload.len() >= 2 {
                        let bpm = u16be(payload, 0) as f64;
                        if plausible_bpm(bpm) {
                            meta.bpm = Some(bpm);
                        }
                    } else if name == [0xa9, b'k', b'e', b'y'] || name == b"keyy" {
                        apply_tag("KEY", &String::from_utf8_lossy(payload), &mut meta);
                    }
                }
            }
            off += size;
        }
    }
    meta
}

/* ------------------------------------------------------------------ Ogg */

fn ogg_packet(b: &[u8], page: usize) -> Option<(&[u8], usize)> {
    if page + 27 > b.len() || ascii(b, page, page + 4) != b"OggS" {
        return None;
    }
    let segments = b[page + 26] as usize;
    let table = page + 27;
    if table + segments > b.len() {
        return None;
    }
    let size: usize = b[table..table + segments].iter().map(|&s| s as usize).sum();
    let payload = table + segments;
    if payload + size > b.len() {
        return None;
    }
    Some((&b[payload..payload + size], payload + size))
}

fn last_granule(tail: &[u8]) -> u64 {
    if tail.len() < 27 {
        return 0;
    }
    for i in (0..=tail.len() - 27).rev() {
        // `OggS` also turns up in compressed payload; a page header follows it with version 0
        // and a flags byte using only the low three bits.
        if &tail[i..i + 4] == b"OggS" && tail[i + 4] == 0 && tail[i + 5] & 0xf8 == 0 {
            let granule = u32le(tail, i + 6) as u64 + ((u32le(tail, i + 10) as u64) << 32);
            if granule > 0 && granule < (1u64 << 53) {
                return granule;
            }
        }
    }
    0
}

fn parse_ogg(w: &Windows) -> Meta {
    let h = &w.head;
    let mut meta = Meta::default();
    if h.len() < 4 || ascii(h, 0, 4) != b"OggS" {
        return meta;
    }
    let Some((first, next)) = ogg_packet(h, 0) else { return meta };
    let granule_rate;
    if first.len() >= 16 && ascii(first, 1, 7) == b"vorbis" {
        meta.channels = Some(first[11] as i64);
        let rate = u32le(first, 12);
        meta.sample_rate = Some(rate as i64);
        let nominal = if first.len() >= 24 { u32le(first, 20) } else { 0 };
        if nominal > 0 {
            meta.bitrate = Some(nominal as i64);
        }
        granule_rate = rate;
    } else if first.len() >= 19 && ascii(first, 0, 8) == b"OpusHead" {
        meta.channels = Some(first[9] as i64);
        // Opus counts granules on a 48kHz clock whatever the input rate was.
        let rate = u32le(first, 12);
        meta.sample_rate = Some(if rate > 0 { rate } else { 48000 } as i64);
        granule_rate = 48000;
    } else {
        return Meta::default();
    }
    let granule = last_granule(&w.tail);
    if granule > 0 && granule_rate > 0 {
        meta.duration = Some(round3(granule as f64 / granule_rate as f64));
    }
    if let Some((comment, _)) = ogg_packet(h, next) {
        if comment.len() > 7 {
            if ascii(comment, 0, 8) == b"OpusTags" {
                apply_vorbis(&comment[8..], &mut meta);
            } else if ascii(comment, 1, 7) == b"vorbis" {
                apply_vorbis(&comment[7..], &mut meta);
            }
        }
    }
    meta
}

/* ------------------------------------------------------------------ ID3v2 */

fn synchsafe(b: &[u8], off: usize) -> usize {
    if off + 4 > b.len() {
        return 0;
    }
    ((b[off] as usize & 0x7f) << 21) | ((b[off + 1] as usize & 0x7f) << 14) | ((b[off + 2] as usize & 0x7f) << 7) | (b[off + 3] as usize & 0x7f)
}

fn apply_id3(b: &[u8], meta: &mut Meta) {
    if b.len() < 10 || ascii(b, 0, 3) != b"ID3" {
        return;
    }
    let major = b[3];
    let flags = b[5];
    let size = synchsafe(b, 6);
    let mut off = 10;
    if flags & 0x40 != 0 && off + 4 <= b.len() {
        off += if major == 4 { synchsafe(b, off) } else { u32be(b, off) as usize + 4 };
    }
    let end = (10 + size).min(b.len());
    let (header, id_len) = if major == 2 { (6, 3) } else { (10, 4) };
    while off + header <= end {
        let id = &b[off..off + id_len];
        if id[0] == 0 {
            break;
        }
        let frame = match major {
            2 => ((b[off + 3] as usize) << 16) | ((b[off + 4] as usize) << 8) | b[off + 5] as usize,
            4 => synchsafe(b, off + 4),
            _ => u32be(b, off + 4) as usize,
        };
        let body = off + header;
        if frame == 0 || body + frame > end {
            break;
        }
        if id == b"TBPM" || id == b"TKEY" || id == b"TBP" || id == b"TKE" {
            let text = id3_text(&b[body..body + frame]);
            apply_tag(if id.starts_with(b"TB") { "BPM" } else { "KEY" }, &text, meta);
        }
        off = body + frame;
    }
}

fn utf16(units: impl Iterator<Item = u16>) -> String {
    String::from_utf16_lossy(&units.collect::<Vec<_>>())
}

fn id3_text(b: &[u8]) -> String {
    let Some((&encoding, body)) = b.split_first() else { return String::new() };
    let le = |s: &[u8]| utf16(s.chunks_exact(2).map(|p| u16::from_le_bytes([p[0], p[1]])));
    let be = |s: &[u8]| utf16(s.chunks_exact(2).map(|p| u16::from_be_bytes([p[0], p[1]])));
    let text = match encoding {
        // UTF-16 with a BOM, which may be big-endian.
        1 if body.len() >= 2 && body[0] == 0xfe && body[1] == 0xff => be(&body[2..]),
        1 => le(body).trim_start_matches('\u{feff}').to_string(),
        2 => be(body),
        3 => String::from_utf8_lossy(body).into_owned(),
        _ => body.iter().map(|&c| c as char).collect(),
    };
    text.trim_end_matches('\0').trim().to_string()
}

/* ------------------------------------------------------------------ tags and names */

const PITCH_CLASSES: [&str; 12] = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/// JavaScript's `parseFloat`: the longest number at the front, ignoring what follows.
fn parse_float(s: &str) -> Option<f64> {
    let s = s.trim_start();
    let mut end = 0;
    let mut seen_dot = false;
    let mut seen_digit = false;
    for (i, c) in s.char_indices() {
        match c {
            '+' | '-' if i == 0 => {}
            '0'..='9' => seen_digit = true,
            '.' if !seen_dot => seen_dot = true,
            _ => break,
        }
        end = i + c.len_utf8();
    }
    if !seen_digit {
        return None;
    }
    s[..end].trim_end_matches('.').parse().ok()
}

fn apply_tag(name: &str, raw: &str, meta: &mut Meta) {
    let value = raw.trim_end_matches('\0').trim();
    if value.is_empty() {
        return;
    }
    match name {
        "BPM" | "TEMPO" => {
            if let Some(bpm) = parse_float(value).map(round2).filter(|&b| plausible_bpm(b)) {
                meta.bpm = Some(bpm);
            }
        }
        "KEY" | "INITIALKEY" | "INITIAL KEY" => {
            if let Some(key) = crate::keys::normalise(value) {
                meta.key = Some(key);
            }
        }
        _ => {}
    }
}

/// `parseNameHints`: tempo and key from a file name, conservatively - a bare number counts as
/// a tempo only as a token on its own, in 60-200, so sample rates and years do not.
pub fn name_hints(path: &str) -> (Option<f64>, Option<String>) {
    let file = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let stem = match file.rfind('.') {
        Some(dot) if dot > 0 => &file[..dot],
        _ => file,
    };
    let lower = stem.to_lowercase();
    let chars: Vec<char> = lower.chars().collect();
    let word = |c: char| c.is_alphanumeric() || c == '_';

    // `(\d{2,3}(?:\.\d+)?)\s*bpm\b`, then `\bbpm[\s_-]*(\d{2,3}(?:\.\d+)?)\b`.
    let explicit = (|| {
        for start in 0..chars.len() {
            if !chars[start].is_ascii_digit() {
                continue;
            }
            for digits in [3usize, 2] {
                let end = start + digits;
                if end > chars.len() || !chars[start..end].iter().all(|c| c.is_ascii_digit()) {
                    continue;
                }
                let mut at = end;
                if at < chars.len() && chars[at] == '.' && chars.get(at + 1).is_some_and(|c| c.is_ascii_digit()) {
                    at += 1;
                    while at < chars.len() && chars[at].is_ascii_digit() {
                        at += 1;
                    }
                }
                let number: String = chars[start..at].iter().collect();
                let mut after = at;
                while after < chars.len() && chars[after].is_whitespace() {
                    after += 1;
                }
                if chars[after..].starts_with(&['b', 'p', 'm']) && chars.get(after + 3).is_none_or(|&c| !word(c)) {
                    return parse_float(&number);
                }
            }
        }
        for start in 0..chars.len() {
            if !chars[start..].starts_with(&['b', 'p', 'm']) || (start > 0 && word(chars[start - 1])) {
                continue;
            }
            let mut at = start + 3;
            while at < chars.len() && (chars[at].is_whitespace() || chars[at] == '_' || chars[at] == '-') {
                at += 1;
            }
            for digits in [3usize, 2] {
                let end = at + digits;
                if end > chars.len() || !chars[at..end].iter().all(|c| c.is_ascii_digit()) {
                    continue;
                }
                let mut stop = end;
                if stop < chars.len() && chars[stop] == '.' && chars.get(stop + 1).is_some_and(|c| c.is_ascii_digit()) {
                    stop += 1;
                    while stop < chars.len() && chars[stop].is_ascii_digit() {
                        stop += 1;
                    }
                }
                if chars.get(stop).is_none_or(|&c| !word(c)) {
                    return parse_float(&chars[at..stop].iter().collect::<String>());
                }
            }
        }
        None
    })();
    let bpm = match explicit {
        Some(bpm) => Some(round2(bpm)).filter(|&b| plausible_bpm(b)),
        None => stem
            .split(|c: char| c.is_whitespace() || "_-()[]".contains(c))
            .filter(|t| (2..=3).contains(&t.len()) && t.chars().all(|c| c.is_ascii_digit()))
            .filter_map(|t| t.parse::<f64>().ok())
            .find(|v| (60.0..=200.0).contains(v)),
    };

    // `(?:^|[\s_\-([])([A-G])([#b])?[\s_-]?(maj|major|min|minor|m)(?=$|[\s_\-)\].])`, any case;
    // failing that `(?:^|[\s_\-([])([A-G])([#b])(?=$|[\s_\-)\].])`, case as written.
    let original: Vec<char> = stem.chars().collect();
    let before_ok = |i: usize| i == 0 || original[i - 1].is_whitespace() || "_-([".contains(original[i - 1]);
    let after_ok = |i: usize| i >= original.len() || original[i].is_whitespace() || "_-)].".contains(original[i]);
    let mut key = None;
    'search: for i in 0..original.len() {
        if !before_ok(i) || !('a'..='g').contains(&original[i].to_ascii_lowercase()) {
            continue;
        }
        let mut at = i + 1;
        let mut accidental = String::new();
        if at < original.len() && (original[at] == '#' || original[at].eq_ignore_ascii_case(&'b')) {
            accidental.push(original[at]);
            at += 1;
        }
        for skip_sep in [false, true] {
            let mut q = at;
            if skip_sep {
                if q < original.len() && (original[q].is_whitespace() || original[q] == '_' || original[q] == '-') {
                    q += 1;
                } else {
                    continue;
                }
            }
            for quality in ["major", "minor", "maj", "min", "m"] {
                let len = quality.len();
                if q + len <= original.len() && original[q..q + len].iter().collect::<String>().eq_ignore_ascii_case(quality) && after_ok(q + len) {
                    key = crate::keys::normalise(&format!("{}{}{}", original[i], accidental, quality));
                    break 'search;
                }
            }
        }
        // `b` as an accidental and as a quality both start here; the regex backtracks to try
        // the letter without one.
        if !accidental.is_empty() && accidental.eq_ignore_ascii_case("b") {
            for quality in ["major", "minor", "maj", "min", "m"] {
                let q = i + 1;
                let len = quality.len();
                if q + len <= original.len() && original[q..q + len].iter().collect::<String>().eq_ignore_ascii_case(quality) && after_ok(q + len) {
                    key = crate::keys::normalise(&format!("{}{quality}", original[i]));
                    break 'search;
                }
            }
        }
    }
    if key.is_none() {
        for i in 0..original.len().saturating_sub(1) {
            if before_ok(i) && ('A'..='G').contains(&original[i]) && (original[i + 1] == '#' || original[i + 1] == 'b') && after_ok(i + 2) {
                key = crate::keys::normalise(&format!("{}{}", original[i], original[i + 1]));
                break;
            }
        }
    }
    (bpm, key)
}

/* ------------------------------------------------------------------ FL Studio */

pub struct FlpProject {
    pub created_ms: Option<f64>,
    pub seconds: Option<f64>,
    pub bpm: Option<f64>,
}

/// Ids 128-191 carry a dword - except these two, measured over a library's projects.
fn wide_event(id: u8) -> Option<usize> {
    match id {
        169 => Some(8),
        172 => Some(5),
        _ => None,
    }
}

fn varint(b: &[u8], start: usize) -> (u64, usize) {
    let (mut value, mut scale, mut pos) = (0u64, 1u64, start);
    while pos < b.len() {
        let byte = b[pos];
        pos += 1;
        value += (byte & 0x7f) as u64 * scale;
        if byte & 0x80 == 0 {
            break;
        }
        scale *= 128;
        if scale > 0x1000_0000 {
            break;
        }
    }
    (value, pos)
}

/// An OLE date (days from 1899-12-30, the machine's local wall clock) to epoch milliseconds,
/// kept as the same clock time here.
fn ole_to_local_ms(days: f64) -> f64 {
    let utc_ms = -2_209_161_600_000.0 + days * 86_400_000.0;
    utc_ms - crate::localtime::offset_ms(utc_ms)
}

/// `parseFlp`: one walk of the event stream for the time record (237) and the tempo (156, or
/// the old 66), stopping once both are in hand.
pub fn parse_flp(d: &[u8]) -> Option<FlpProject> {
    if d.len() < 12 || ascii(d, 0, 4) != b"FLhd" {
        return None;
    }
    let mut pos = 8 + u32le(d, 4) as usize;
    if pos + 8 > d.len() || ascii(d, pos, pos + 4) != b"FLdt" {
        return None;
    }
    let length = u32le(d, pos + 4) as usize;
    pos += 8;
    let events = pos;
    let end = (pos + length).min(d.len());
    let mut found = FlpProject { created_ms: None, seconds: None, bpm: None };
    let mut coarse = None;
    while pos < end {
        let before = pos;
        let id = d[pos];
        pos += 1;
        if id < 64 {
            pos += 1;
        } else if id < 128 {
            if id == 66 && coarse.is_none() && pos + 2 <= d.len() {
                coarse = Some(u16le(d, pos) as f64);
            }
            pos += 2;
        } else if id < 192 {
            if id == 156 && found.bpm.is_none() && pos + 4 <= d.len() {
                found.bpm = Some(round2(u32le(d, pos) as f64 / 1000.0));
            }
            pos += wide_event(id).unwrap_or(4);
        } else {
            let (size, next) = varint(d, pos);
            pos = next;
            if id == 237 && found.seconds.is_none() && size >= 16 && pos + 16 <= d.len() {
                let created = f64::from_le_bytes(d[pos..pos + 8].try_into().ok()?);
                let span = f64::from_le_bytes(d[pos + 8..pos + 16].try_into().ok()?);
                if created > 0.0 && created < 100_000.0 {
                    let ms = ole_to_local_ms(created);
                    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0);
                    // FL Studio 3 shipped in 2003: anything outside 1998..next year is corrupt.
                    if ms >= 883_612_800_000.0 && ms <= now + 365.0 * 86_400_000.0 {
                        found.created_ms = Some(ms);
                    }
                }
                found.seconds = Some((if span.is_finite() { span.max(0.0) } else { 0.0 } * 86_400.0).round());
            }
            pos = pos.saturating_add(size as usize);
        }
        if found.bpm.is_some() && found.seconds.is_some() {
            break;
        }
        if pos <= before {
            break;
        }
    }
    if found.bpm.is_none() {
        found.bpm = coarse;
    }
    if !found.bpm.is_some_and(plausible_bpm) {
        // The byte pattern, for a stream the walk could not follow to the tempo.
        let limit = d.len().saturating_sub(5).min(events + 4096);
        found.bpm = (events..limit).filter(|&i| d[i] == 156).map(|i| u32le(d, i + 1)).filter(|m| m % 100 == 0).map(|m| round2(m as f64 / 1000.0)).find(|&b| plausible_bpm(b)).or(found.bpm);
    }
    Some(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_names_like_the_electron_app() {
        assert_eq!(name_hints("C:/x/Loop 140 BPM Am.wav"), (Some(140.0), Some("Am".into())));
        assert_eq!(name_hints("C:/x/kick bpm128 F#min.wav"), (Some(128.0), Some("F#m".into())));
        // `_` is a word character to the regex, so there is no boundary before this "bpm".
        assert_eq!(name_hints("C:/x/kick_bpm128_F#min.wav"), (None, Some("F#m".into())));
        assert_eq!(name_hints("C:/x/beat 92 Eb.mp3"), (Some(92.0), Some("Eb".into())));
        assert_eq!(name_hints("C:/x/2024 mix 44100.wav"), (None, None));
        assert_eq!(name_hints("C:/x/A Day.wav"), (None, None));
        assert_eq!(name_hints("C:/x/bass Bbmaj.wav").1, Some("Bb".into()));
    }

    #[test]
    fn probes_a_wav() {
        let dir = std::env::temp_dir().join(format!("umakbang-probe-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("tone 120 bpm.wav");
        let (rate, frames) = (44100u32, 44100u32);
        let data = vec![0u8; (frames * 4) as usize];
        let mut wav = b"RIFF".to_vec();
        wav.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&rate.to_le_bytes());
        wav.extend_from_slice(&(rate * 4).to_le_bytes());
        wav.extend_from_slice(&4u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(data.len() as u32).to_le_bytes());
        wav.extend_from_slice(&data);
        std::fs::write(&path, wav).unwrap();
        let meta = probe(&path, "wav");
        assert_eq!((meta.sample_rate, meta.channels, meta.bit_depth, meta.duration, meta.bpm), (Some(44100), Some(2), Some(16), Some(1.0), Some(120.0)));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
