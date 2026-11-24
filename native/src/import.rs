//! Converts the Electron app's saved index (NDJSON, one `Track` per line) into SQLite.
//!
//! Streamed line by line, so the import itself never holds the library either. Folders get a
//! table of their own with their recursive counts - the tree and the folder rows read those
//! directly instead of counting files every time they are drawn.

use rusqlite::{Connection, params};
use serde::Deserialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::time::Instant;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Track {
    path: String,
    rel_dir: String,
    name: String,
    #[serde(default)]
    ext: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    size: i64,
    #[serde(default)]
    mtime_ms: f64,
    duration: Option<f64>,
    bpm: Option<f64>,
    musical_key: Option<String>,
    sample_rate: Option<i64>,
    #[serde(default)]
    playable: bool,
}

struct Folder {
    id: i64,
    parent: Option<i64>,
    name: String,
    files: i64,
    audio: i64,
    latest: f64,
}

pub fn run(index: &Path, db_path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let started = Instant::now();
    let _ = std::fs::remove_file(db_path);
    let mut db = Connection::open(db_path)?;
    db.execute_batch(
        &format!("PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF; {}", crate::library::SCHEMA),
    )?;

    // Folder paths to their entry while importing: ~22k folders, not the 328k files.
    let mut folders: HashMap<String, Folder> = HashMap::new();
    let mut next_id = 1i64;
    let tx = db.transaction()?;
    let mut rows = 0usize;
    {
        let mut insert = tx.prepare(
            "INSERT OR IGNORE INTO tracks
               (folder, path, name, ext, kind, size, mtime, duration, bpm, musical_key, sample_rate, playable)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        )?;
        let reader = BufReader::with_capacity(1 << 20, File::open(index)?);
        for line in reader.lines() {
            let line = line?;
            if line.is_empty() {
                continue;
            }
            let Ok(track) = serde_json::from_str::<Track>(&line) else { continue };

            // The folder and each one above it, created as needed and counted.
            let mut parent: Option<i64> = None;
            let mut path = String::new();
            let mut own = 0i64;
            for segment in track.rel_dir.split('/') {
                if !path.is_empty() {
                    path.push('/');
                }
                path.push_str(segment);
                let entry = folders.entry(path.clone()).or_insert_with(|| {
                    let folder = Folder {
                        id: next_id,
                        parent,
                        name: segment.to_string(),
                        files: 0,
                        audio: 0,
                        latest: 0.0,
                    };
                    next_id += 1;
                    folder
                });
                entry.files += 1;
                if track.kind == "audio" {
                    entry.audio += 1;
                }
                if track.mtime_ms > entry.latest {
                    entry.latest = track.mtime_ms;
                }
                parent = Some(entry.id);
                own = entry.id;
            }

            insert.execute(params![
                own,
                track.path,
                track.name,
                track.ext,
                track.kind,
                track.size,
                track.mtime_ms,
                track.duration,
                track.bpm,
                track.musical_key,
                track.sample_rate,
                track.playable
            ])?;
            rows += 1;
        }
    }
    {
        let mut insert = tx.prepare(
            "INSERT INTO folders (id, parent, name, path, files, audio, latest) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?;
        for (path, folder) in &folders {
            insert.execute(params![
                folder.id,
                folder.parent,
                folder.name,
                path,
                folder.files,
                folder.audio,
                folder.latest
            ])?;
        }
    }
    tx.commit()?;
    db.execute_batch("PRAGMA journal_mode = DELETE; VACUUM;")?;
    let size = std::fs::metadata(db_path)?.len();
    println!(
        "imported {rows} files in {} folders in {:.1}s; database {} MB",
        folders.len(),
        started.elapsed().as_secs_f64(),
        size / 1_000_000
    );
    Ok(())
}
