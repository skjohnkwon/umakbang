//! A stretch of a track written out as a file of its own (`lib/trim.ts`): a WAV source gives a
//! WAV, an MP3 gives an MP3 at the source's own bitrate (so a 320k beat does not quietly trim
//! to 128k), and everything else comes out as WAV.

use std::path::Path;

/// `trimName`: "beat (trim 12.3-45.6).wav".
pub fn trim_name(name: &str, from: f64, to: f64, ext: &str) -> String {
    let stem = match name.rfind('.') {
        Some(dot) if dot > 0 => &name[..dot],
        _ => name,
    };
    // `toFixed(1)` rounds half away from zero; `{:.1}` would round half to even.
    let fixed = |v: f64| format!("{:.1}", (v * 10.0).round() / 10.0);
    format!("{stem} (trim {}-{}).{ext}", fixed(from), fixed(to))
}

/// What the trim of a file with this extension is written as.
pub fn output_ext(source_ext: &str) -> &'static str {
    if source_ext.eq_ignore_ascii_case("mp3") { "mp3" } else { "wav" }
}

/// The bytes of `from..to` seconds of `path`, encoded as `output_ext` says.
pub fn trim(path: &Path, source_ext: &str, bitrate_kbps: Option<u32>, from: f64, to: f64) -> Result<Vec<u8>, String> {
    use rodio::Source;
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let decoder = rodio::Decoder::try_from(file).map_err(|_| format!("Couldn't decode .{source_ext} to cut a piece out of it."))?;
    let channels = decoder.channels().get() as usize;
    let rate = decoder.sample_rate().get();
    let start = (from.max(0.0) * rate as f64).floor() as usize * channels;
    let end = (to * rate as f64).ceil() as usize * channels;
    if end <= start {
        return Err("That selection is empty.".into());
    }
    let pcm: Vec<i16> = decoder.skip(start).take(end - start).map(|s| (s.clamp(-1.0, 1.0) * 32767.0).round() as i16).collect();
    if pcm.is_empty() {
        return Err("That selection is empty.".into());
    }
    if output_ext(source_ext) == "mp3" {
        mp3(&pcm, channels, rate, bitrate_kbps.unwrap_or(192))
    } else {
        Ok(wav(&pcm, channels as u16, rate))
    }
}

fn wav(pcm: &[i16], channels: u16, rate: u32) -> Vec<u8> {
    let data = pcm.len() as u32 * 2;
    let mut out = Vec::with_capacity(44 + data as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * channels as u32 * 2).to_le_bytes());
    out.extend_from_slice(&(channels * 2).to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data.to_le_bytes());
    for s in pcm {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

/// `nearestBitrate`: the LAME rate closest to what was asked for.
fn bitrate(kbps: u32) -> mp3lame_encoder::Bitrate {
    use mp3lame_encoder::Bitrate::*;
    let table = [(32, Kbps32), (40, Kbps40), (48, Kbps48), (64, Kbps64), (80, Kbps80), (96, Kbps96), (112, Kbps112), (128, Kbps128), (160, Kbps160), (192, Kbps192), (224, Kbps224), (256, Kbps256), (320, Kbps320)];
    table.iter().min_by_key(|(k, _)| (*k as i64 - kbps as i64).abs()).map(|(_, b)| *b).unwrap_or(Kbps192)
}

fn mp3(pcm: &[i16], channels: usize, rate: u32, kbps: u32) -> Result<Vec<u8>, String> {
    use mp3lame_encoder::{Builder, FlushNoGap, InterleavedPcm, MonoPcm, Quality};
    let mut builder = Builder::new().ok_or("The encoder would not start.")?;
    let out_channels = channels.min(2);
    builder.set_num_channels(out_channels as u8).map_err(|e| format!("{e:?}"))?;
    builder.set_sample_rate(rate).map_err(|e| format!("{e:?}"))?;
    builder.set_brate(bitrate(kbps)).map_err(|e| format!("{e:?}"))?;
    builder.set_quality(Quality::Good).map_err(|e| format!("{e:?}"))?;
    let mut encoder = builder.build().map_err(|e| format!("{e:?}"))?;
    // Anything past stereo keeps its first two channels.
    let frames: Vec<i16> = if channels <= 2 { pcm.to_vec() } else { pcm.chunks(channels).flat_map(|f| [f[0], f[1]]).collect() };
    let mut out = Vec::new();
    out.reserve(mp3lame_encoder::max_required_buffer_size(frames.len()));
    if out_channels == 1 {
        encoder.encode_to_vec(MonoPcm(frames.as_slice()), &mut out).map_err(|e| format!("{e:?}"))?;
    } else {
        encoder.encode_to_vec(InterleavedPcm(frames.as_slice()), &mut out).map_err(|e| format!("{e:?}"))?;
    }
    out.reserve(7200);
    encoder.flush_to_vec::<FlushNoGap>(&mut out).map_err(|e| format!("{e:?}"))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_cuts() {
        assert_eq!(trim_name("beat.wav", 1.25, 9.5, "wav"), "beat (trim 1.3-9.5).wav");
        assert_eq!(output_ext("FLAC"), "wav");
        let pcm: Vec<i16> = (0..8000).map(|i| ((i as f32 * 0.05).sin() * 8000.0) as i16).collect();
        let bytes = wav(&pcm, 1, 8000);
        assert_eq!(&bytes[..4], b"RIFF");
        assert_eq!(bytes.len(), 44 + 16000);
        assert!(!mp3(&pcm, 1, 8000, 128).unwrap().is_empty());
    }
}
