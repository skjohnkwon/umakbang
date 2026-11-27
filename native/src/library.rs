//! The library as SQLite queries. Every view asks for exactly what it draws; nothing here keeps
//! rows between calls. The schema is written by `import.rs` (and, later, by the scanner).

use rusqlite::{Connection, OpenFlags, params};
use std::path::Path;

pub struct Library {
    db: Connection,
}

#[derive(Clone, Debug)]
pub struct FolderRow {
    pub id: i64,
    pub parent: Option<i64>,
    pub name: String,
    pub path: String,
    /// Files at or below this folder.
    pub files: i64,
    /// Newest file at or below it.
    pub latest: f64,
    /// Whether it has subfolders - whether the tree gives it a chevron.
    pub has_children: bool,
}

/// The id of the virtual folder above every library folder - "Library" in the tree and the
/// breadcrumbs. SQLite row ids start at 1, so it can never name a real one.
pub const LIBRARY: i64 = 0;

#[derive(Clone, Debug)]
pub struct FileRow {
    pub path: String,
    pub name: String,
    pub ext: String,
    pub kind: String,
    pub size: i64,
    pub mtime: f64,
    pub duration: Option<f64>,
    pub bpm: Option<f64>,
    pub musical_key: Option<String>,
    pub playable: bool,
    pub sample_rate: Option<i64>,
    pub bit_depth: Option<i64>,
    pub channels: Option<i64>,
    pub bitrate: Option<i64>,
    /// FL Studio: how long the project has been open, in seconds.
    pub project_seconds: Option<f64>,
    /// FL Studio: when the project was made, epoch milliseconds. Carried on the row so that
    /// writing it back - `INSERT OR REPLACE` rewrites every column - cannot drop it.
    pub project_created: Option<f64>,
    /// Whether the prober has read it - set once, so a file is read once.
    pub probed: bool,
    /// The folder it is in, label-relative - shown beside the name when a list spans folders.
    pub dir: String,
}

/// Columns later versions read that an older database lacks, added where missing: what the
/// prober reads beyond the basics, whether it has read the file, and each folder's own mtime
/// for the scanner's skip.
/// The tables as the first version had them; `migrate` adds every column since.
pub const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS folders (
       id INTEGER PRIMARY KEY, parent INTEGER, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
       files INTEGER NOT NULL, audio INTEGER NOT NULL, latest REAL NOT NULL);
     CREATE INDEX IF NOT EXISTS folders_parent ON folders(parent, name);
     CREATE TABLE IF NOT EXISTS tracks (
       id INTEGER PRIMARY KEY, folder INTEGER NOT NULL, path TEXT NOT NULL UNIQUE,
       name TEXT NOT NULL, ext TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL,
       mtime REAL NOT NULL, duration REAL, bpm REAL, musical_key TEXT, sample_rate INTEGER,
       playable INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS tracks_folder ON tracks(folder, mtime);";

pub fn migrate(db: &Connection) {
    let has = |table: &str, column: &str| -> bool {
        db.prepare(&format!("SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?1"))
            .and_then(|mut s| s.exists(params![column]))
            .unwrap_or(false)
    };
    for (table, column, kind) in [
        ("tracks", "bit_depth", "INTEGER"),
        ("tracks", "channels", "INTEGER"),
        ("tracks", "bitrate", "INTEGER"),
        ("tracks", "project_seconds", "REAL"),
        ("tracks", "project_created", "REAL"),
        ("tracks", "probed", "INTEGER NOT NULL DEFAULT 0"),
        ("folders", "mtime", "REAL"),
        ("folders", "hash", "TEXT"),
    ] {
        if !has(table, column) {
            let _ = db.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {kind}"));
        }
    }
    // The tree hashes (`v0.6-tree-hashes.md`): a folder's hash is cleared whenever anything in
    // it changes, and a cleared hash clears its parent's, up to the root - so a stale folder's
    // ancestors are always stale too, and only that branch is worked out again. The climb is
    // a trigger firing itself, which needs `recursive_triggers` on the connection that writes.
    let _ = db.execute_batch(
        "CREATE TRIGGER IF NOT EXISTS tracks_tree_insert AFTER INSERT ON tracks BEGIN
           UPDATE folders SET hash = NULL WHERE id = NEW.folder AND hash IS NOT NULL; END;
         CREATE TRIGGER IF NOT EXISTS tracks_tree_delete AFTER DELETE ON tracks BEGIN
           UPDATE folders SET hash = NULL WHERE id = OLD.folder AND hash IS NOT NULL; END;
         CREATE TRIGGER IF NOT EXISTS tracks_tree_update AFTER UPDATE OF folder, name, size, mtime ON tracks BEGIN
           UPDATE folders SET hash = NULL WHERE id IN (OLD.folder, NEW.folder) AND hash IS NOT NULL; END;
         CREATE TRIGGER IF NOT EXISTS folders_tree_climb AFTER UPDATE OF hash ON folders WHEN NEW.hash IS NULL AND NEW.parent IS NOT NULL BEGIN
           UPDATE folders SET hash = NULL WHERE id = NEW.parent AND hash IS NOT NULL; END;
         CREATE TRIGGER IF NOT EXISTS folders_tree_insert AFTER INSERT ON folders WHEN NEW.parent IS NOT NULL BEGIN
           UPDATE folders SET hash = NULL WHERE id = NEW.parent AND hash IS NOT NULL; END;
         CREATE TRIGGER IF NOT EXISTS folders_tree_delete AFTER DELETE ON folders WHEN OLD.parent IS NOT NULL BEGIN
           UPDATE folders SET hash = NULL WHERE id = OLD.parent AND hash IS NOT NULL; END;
         CREATE TRIGGER IF NOT EXISTS folders_tree_move AFTER UPDATE OF name, parent ON folders BEGIN
           UPDATE folders SET hash = NULL WHERE id IN (OLD.parent, NEW.parent, NEW.id) AND hash IS NOT NULL; END;",
    );
}

pub const FOLDER_COLUMNS: &str = "f.id, f.parent, f.name, f.path, f.files, f.latest, EXISTS(SELECT 1 FROM folders c WHERE c.parent = f.id)";

pub fn folder_row(row: &rusqlite::Row) -> rusqlite::Result<FolderRow> {
    Ok(FolderRow {
        id: row.get(0)?,
        parent: row.get(1)?,
        name: row.get(2)?,
        path: row.get(3)?,
        files: row.get(4)?,
        latest: row.get(5)?,
        has_children: row.get(6)?,
    })
}

impl Library {
    pub fn open(path: &Path) -> rusqlite::Result<Library> {
        // Read-write: file operations and re-reads keep the rows current. WAL lets the search
        // thread's read-only connection go on reading while this one writes.
        // Created when missing: a first install has no index to import, only folders to scan.
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE)?;
        // A fixed page cache, so memory does not grow with the size of the library: 16MB.
        // The write log is cut back to 64MB whenever it empties: left alone, it stays as big as
        // the largest write it ever held - a first index of a big library left one at 1.2GB.
        db.execute_batch("PRAGMA journal_mode = WAL; PRAGMA journal_size_limit = 67108864; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA cache_size = -16000; PRAGMA mmap_size = 0; PRAGMA recursive_triggers = ON;")?;
        db.execute_batch(SCHEMA)?;
        migrate(&db);
        Ok(Library { db })
    }

    /// Folds the write log into the database and empties it. Best at launch, before anything
    /// else has the database open: it waits for readers, and gives up if they take too long.
    pub fn shrink_log(&self) {
        let _ = self.db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    }

    /// The folders directly inside `parent` (the library folders for `None`), newest first -
    /// the order the explorer lists them in when it is sorted by Modified.
    pub fn children(&self, parent: Option<i64>) -> Vec<FolderRow> {
        let parent = parent.filter(|&p| p != LIBRARY);
        let sql = format!("SELECT {FOLDER_COLUMNS} FROM folders f WHERE f.parent IS ?1 ORDER BY f.latest DESC, f.name COLLATE NOCASE");
        let mut statement = self.db.prepare_cached(&sql).expect("children query");
        statement
            .query_map(params![parent], folder_row)
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    pub fn folder(&self, id: i64) -> Option<FolderRow> {
        if id == LIBRARY {
            return Some(self.library_root());
        }
        let sql = format!("SELECT {FOLDER_COLUMNS} FROM folders f WHERE f.id = ?1");
        self.db.query_row(&sql, params![id], folder_row).ok()
    }

    pub fn folder_at(&self, path: &str) -> Option<FolderRow> {
        let sql = format!("SELECT {FOLDER_COLUMNS} FROM folders f WHERE f.path = ?1");
        self.db.query_row(&sql, params![path], folder_row).ok()
    }

    /// The virtual folder above the library folders: every file below it, the newest of them.
    pub fn library_root(&self) -> FolderRow {
        let (files, latest) = self
            .db
            .query_row("SELECT coalesce(sum(files), 0), coalesce(max(latest), 0) FROM folders WHERE parent IS NULL", [], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap_or((0, 0.0));
        FolderRow { id: LIBRARY, parent: None, name: String::new(), path: String::new(), files, latest, has_children: true }
    }

    /// The folder and every one above it, outermost first - the breadcrumbs.
    pub fn ancestry(&self, id: i64) -> Vec<FolderRow> {
        let mut chain = Vec::new();
        let mut at = Some(id).filter(|&id| id != LIBRARY);
        while let Some(current) = at.and_then(|id| self.folder(id)) {
            at = current.parent;
            chain.push(current);
        }
        chain.reverse();
        chain
    }

    /// One folder's own files, newest first.
    pub fn files(&self, folder: i64) -> Vec<FileRow> {
        let mut statement = self
            .db
            .prepare_cached(
                &format!("SELECT {FILE_COLUMNS}, f.path FROM tracks t JOIN folders f ON f.id = t.folder WHERE t.folder = ?1 ORDER BY t.mtime DESC"),
            )
            .expect("files query");
        statement
            .query_map(params![folder], |row| {
                file_row(row, row.get(DIR_COLUMN)?)
            })
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// The rows for these paths, wherever they are - a saved view's files. Paths the index does
    /// not know are left out.
    pub fn files_at(&self, paths: &[String]) -> Vec<FileRow> {
        let mut out = Vec::with_capacity(paths.len());
        let Ok(mut statement) = self.db.prepare_cached(
            &format!("SELECT {FILE_COLUMNS}, f.path FROM tracks t JOIN folders f ON f.id = t.folder WHERE t.path = ?1"),
        ) else {
            return out;
        };
        for path in paths {
            let row = statement.query_row(params![path], |row| {
                file_row(row, row.get(DIR_COLUMN)?)
            });
            if let Ok(row) = row {
                out.push(row);
            }
        }
        out
    }

    /// How many files of each kind and each extension the library holds, most first.
    pub fn type_counts(&self) -> (Vec<(String, i64)>, Vec<(String, i64)>) {
        let grouped = |sql: &str| -> Vec<(String, i64)> {
            self.db
                .prepare(sql)
                .and_then(|mut s| s.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map(|rows| rows.filter_map(Result::ok).collect()))
                .unwrap_or_default()
        };
        (
            grouped("SELECT kind, count(*) FROM tracks GROUP BY kind ORDER BY count(*) DESC"),
            grouped("SELECT lower(ext), count(*) FROM tracks GROUP BY lower(ext) ORDER BY count(*) DESC"),
        )
    }

    /// Every playable file outside these folders: what the dice draws from.
    pub fn random_pool(&self, excluded: &[String]) -> Vec<String> {
        let mut outside = String::from("1");
        for dir in excluded {
            let quoted = dir.replace('\'', "''");
            outside.push_str(&format!(" AND NOT (f.path = '{quoted}' OR f.path LIKE '{quoted}/%')"));
        }
        self.db
            .prepare(&format!("SELECT t.path FROM tracks t JOIN folders f ON f.id = t.folder WHERE t.playable = 1 AND {outside}"))
            .and_then(|mut s| s.query_map([], |r| r.get(0)).map(|rows| rows.filter_map(Result::ok).collect()))
            .unwrap_or_default()
    }

    /// The FL Studio project of the same name (`useProjectFor`): how long it has been open, and
    /// where it is - the one beside the file first.
    pub fn project_for(&self, name: &str, dir: &str) -> Option<(f64, String)> {
        let stem = name.rfind('.').filter(|&d| d > 0).map_or(name, |d| &name[..d]).trim().to_lowercase();
        self.db
            .query_row(
                "SELECT t.project_seconds, t.path FROM tracks t JOIN folders f ON f.id = t.folder
                 WHERE t.ext = 'flp' AND lower(t.name) = ?1 ORDER BY f.path = ?2 DESC LIMIT 1",
                params![format!("{stem}.flp"), dir],
                |row| Ok((row.get::<_, Option<f64>>(0)?, row.get::<_, String>(1)?)),
            )
            .ok()
            .and_then(|(seconds, path)| seconds.filter(|&s| s > 0.0).map(|s| (s, path)))
    }

    /// The folder a file is in.
    pub fn folder_of(&self, path: &str) -> Option<i64> {
        self.db.query_row("SELECT folder FROM tracks WHERE path = ?1", params![path], |row| row.get(0)).ok()
    }

    /// Every file called `name` (any case) of exactly `size` bytes, with its path and mtime: the
    /// candidates for a file that moved.
    pub fn files_matching(&self, name: &str, size: f64) -> Vec<(String, f64)> {
        self.db
            .prepare_cached("SELECT path, mtime FROM tracks WHERE name = ?1 COLLATE NOCASE AND size = ?2")
            .and_then(|mut s| s.query_map(params![name, size as i64], |r| Ok((r.get(0)?, r.get(1)?))).map(|rows| rows.filter_map(Result::ok).collect()))
            .unwrap_or_default()
    }

    /// `fillTemposFromProjects`: an audio file with no tempo of its own takes the tempo of the
    /// FL Studio project it was bounced from - the `.flp` in its folder with the same name once
    /// the render words are off (`REFLECT_Master.wav` from `REFLECT.flp`). The detector is right
    /// two times in three on finished tracks and reports exactly half three times in ten; the
    /// project stores the number. A declared tempo, like an ACID chunk: the detector's guess
    /// never overrides it. Only `folder`, or every folder for `None`.
    pub fn fill_tempos_from_projects(&self, folder: Option<i64>) -> usize {
        let mut projects: std::collections::HashMap<(i64, String), f64> = std::collections::HashMap::new();
        let query = "SELECT folder, name, bpm FROM tracks WHERE lower(ext) = 'flp' AND bpm IS NOT NULL AND (?1 IS NULL OR folder = ?1)";
        if let Ok(mut s) = self.db.prepare(query) {
            if let Ok(rows) = s.query_map(params![folder], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, f64>(2)?))) {
                for (f, name, bpm) in rows.filter_map(Result::ok) {
                    if crate::probe::plausible_bpm(bpm) {
                        projects.insert((f, stem_of(&name)), bpm);
                    }
                }
            }
        }
        if projects.is_empty() {
            return 0;
        }
        let waiting: Vec<(i64, i64, String)> = self
            .db
            .prepare("SELECT id, folder, name FROM tracks WHERE kind = 'audio' AND bpm IS NULL AND folder IN (SELECT folder FROM tracks WHERE lower(ext) = 'flp' AND (?1 IS NULL OR folder = ?1))")
            .and_then(|mut s| s.query_map(params![folder], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map(|rows| rows.filter_map(Result::ok).collect()))
            .unwrap_or_default();
        let Ok(tx) = self.db.unchecked_transaction() else { return 0 };
        let mut filled = 0;
        for (id, f, name) in waiting {
            if let Some(bpm) = projects.get(&(f, render_stem(&name))) {
                if tx.execute("UPDATE tracks SET bpm = ?1 WHERE id = ?2", params![bpm, id]).is_ok() {
                    filled += 1;
                }
            }
        }
        let _ = tx.commit();
        filled
    }

    pub fn total_files(&self) -> i64 {
        self.db.query_row("SELECT count(*) FROM tracks", [], |row| row.get(0)).unwrap_or(0)
    }

    /// How much of your own music you have rated, 0..1: rated playable files outside the
    /// folders marked "not your own work", over all playable files outside them. The same
    /// figure as the Electron sidebar's Rated row.
    /// What the Stats page reads: every project and every audio file, with the key a file
    /// declares or, failing that, the one detected for it.
    pub fn stat_rows(&self, detected_key: &std::collections::HashMap<String, String>) -> Vec<crate::stats::Row> {
        let Ok(mut statement) = self.db.prepare(
            "SELECT t.path, t.name, t.ext, t.kind, t.size, t.mtime, t.bpm, t.musical_key, t.project_seconds, t.project_created, f.path
             FROM tracks t JOIN folders f ON f.id = t.folder WHERE t.ext = 'flp' OR t.kind = 'audio'",
        ) else {
            return Vec::new();
        };
        let rows = statement.query_map([], |row| {
            let path: String = row.get(0)?;
            let declared: Option<String> = row.get(7)?;
            let ext: String = row.get(2)?;
            let kind: String = row.get(3)?;
            Ok(crate::stats::Row {
                flp: ext == "flp",
                audio: kind == "audio",
                name: row.get(1)?,
                size: row.get(4)?,
                mtime: row.get::<_, Option<f64>>(5)?.unwrap_or(0.0),
                bpm: row.get(6)?,
                key: declared.filter(|k| !k.is_empty()).or_else(|| detected_key.get(&path).cloned()),
                seconds: row.get(8)?,
                created: row.get(9)?,
                rel_dir: row.get(10)?,
            })
        });
        rows.map(|r| r.flatten().collect()).unwrap_or_default()
    }

    pub fn rated_share(&self, rated: &[String], excluded: &[String]) -> f64 {
        let mut outside = String::from("1");
        for dir in excluded {
            let quoted = dir.replace('\'', "''");
            outside.push_str(&format!(" AND NOT (f.path = '{quoted}' OR f.path LIKE '{quoted}/%')"));
        }
        let own: i64 = self
            .db
            .query_row(
                &format!("SELECT count(*) FROM tracks t JOIN folders f ON f.id = t.folder WHERE t.playable = 1 AND {outside}"),
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if own == 0 {
            return 0.0;
        }
        let mut statement = self
            .db
            .prepare_cached(&format!(
                "SELECT count(*) FROM tracks t JOIN folders f ON f.id = t.folder WHERE t.path = ?1 AND t.playable = 1 AND {outside}"
            ))
            .expect("rated query");
        let mut hits = 0i64;
        for path in rated {
            hits += statement.query_row(params![path], |row| row.get::<_, i64>(0)).unwrap_or(0);
        }
        hits as f64 / own as f64
    }
}

/// What a file row is stored with.
const TRACK_INSERT: &str = "INSERT OR REPLACE INTO tracks
       (folder, path, name, ext, kind, size, mtime, duration, bpm, musical_key, sample_rate, playable, bit_depth, channels, bitrate, project_seconds, probed, project_created)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)";

/// A file row from the columns of `FILE_COLUMNS`, in that order.
pub fn file_row(row: &rusqlite::Row, dir: String) -> rusqlite::Result<FileRow> {
    Ok(FileRow {
        path: row.get(0)?,
        name: row.get(1)?,
        ext: row.get(2)?,
        kind: row.get(3)?,
        size: row.get(4)?,
        mtime: row.get(5)?,
        duration: row.get(6)?,
        bpm: row.get(7)?,
        musical_key: row.get(8)?,
        playable: row.get(9)?,
        sample_rate: row.get(10)?,
        bit_depth: row.get(11)?,
        channels: row.get(12)?,
        bitrate: row.get(13)?,
        project_seconds: row.get(14)?,
        probed: row.get(15)?,
        project_created: row.get(16)?,
        dir,
    })
}

/// What a file row is read with; the folder's path, where it is joined, follows at
/// `DIR_COLUMN`.
pub const FILE_COLUMNS: &str =
    "t.path, t.name, t.ext, t.kind, t.size, t.mtime, t.duration, t.bpm, t.musical_key, t.playable, t.sample_rate, t.bit_depth, t.channels, t.bitrate, t.project_seconds, t.probed, t.project_created";
pub const DIR_COLUMN: usize = 17;

impl Library {
    /// The folder's own counts and newest date, and every one above it, worked out again from
    /// what is now beneath each: after anything was added, removed or moved.
    pub fn recount(&self, id: i64) {
        let mut at = Some(id).filter(|&id| id != LIBRARY);
        while let Some(id) = at {
            let _ = self.db.execute(
                "UPDATE folders SET
                   files = (SELECT count(*) FROM tracks WHERE folder = ?1) + (SELECT coalesce(sum(files), 0) FROM folders WHERE parent = ?1),
                   audio = (SELECT count(*) FROM tracks WHERE folder = ?1 AND kind = 'audio') + (SELECT coalesce(sum(audio), 0) FROM folders WHERE parent = ?1),
                   latest = max(coalesce((SELECT max(mtime) FROM tracks WHERE folder = ?1), 0), coalesce((SELECT max(latest) FROM folders WHERE parent = ?1), 0))
                 WHERE id = ?1",
                params![id],
            );
            at = self.folder(id).and_then(|f| f.parent);
        }
    }

    /// A folder row for `rel` under `parent`, created if it is not there. Its id.
    pub fn ensure_folder(&self, parent: Option<i64>, name: &str, rel: &str) -> Option<i64> {
        if let Some(existing) = self.folder_at(rel) {
            return Some(existing.id);
        }
        self.db
            .execute(
                "INSERT INTO folders (parent, name, path, files, audio, latest) VALUES (?1, ?2, ?3, 0, 0, 0)",
                params![parent.filter(|&p| p != LIBRARY), name, rel],
            )
            .ok()?;
        Some(self.db.last_insert_rowid())
    }

    /// Writes a file row as given, into `folder`.
    pub fn put_file(&self, folder: i64, row: &FileRow) {
        let _ = self.db.execute(
            TRACK_INSERT,
            params![
                folder,
                row.path,
                row.name,
                row.ext,
                row.kind,
                row.size,
                row.mtime,
                row.duration,
                row.bpm,
                row.musical_key,
                row.sample_rate,
                row.playable,
                row.bit_depth,
                row.channels,
                row.bitrate,
                row.project_seconds,
                row.probed,
                row.project_created
            ],
        );
    }

    /// What a re-read added without reading: each such row in the folder probed and written
    /// back, so a file that just arrived has its length and format at once rather than after
    /// the next scan.
    /// Covers the folder's subtree as well, since a re-read that found a new subfolder indexed
    /// it whole, and nothing in it has been read yet either.
    pub fn probe_unread(&self, folder: i64) -> usize {
        let Ok(path) = self.db.query_row("SELECT path FROM folders WHERE id = ?1", params![folder], |r| r.get::<_, String>(0)) else { return 0 };
        // `_` and `%` are common in folder names and mean something to LIKE.
        let pattern = format!("{}/%", path.replace('!', "!!").replace('%', "!%").replace('_', "!_"));
        let folders: Vec<i64> = self
            .db
            .prepare("SELECT DISTINCT t.folder FROM tracks t JOIN folders f ON f.id = t.folder WHERE t.probed = 0 AND (f.id = ?1 OR f.path LIKE ?2 ESCAPE '!')")
            .and_then(|mut s| s.query_map(params![folder, pattern], |r| r.get(0)).map(|rows| rows.filter_map(Result::ok).collect()))
            .unwrap_or_default();
        let mut done = 0;
        for id in folders {
            for mut row in self.files(id).into_iter().filter(|f| !f.probed) {
                crate::scan::probe_into(&mut row);
                self.put_file(id, &row);
                done += 1;
            }
        }
        done
    }

    /// A mounted library's rows, replaced with what its machine says now. Folders that are still
    /// there keep their ids, so a refresh does not pull the folder on screen out from under it;
    /// the counts are worked out once, in memory, rather than folder by folder.
    pub fn replace_remote(&self, label: &str, rows: &[crate::remote::Row]) {
        use std::collections::HashMap;
        let _ = self.db.execute_batch("BEGIN");
        let (own, from, to) = (label.to_string(), format!("{label}/"), format!("{label}0"));
        let existing: HashMap<String, (i64, Option<i64>)> = self
            .db
            .prepare("SELECT path, id, parent FROM folders WHERE path = ?1 OR (path >= ?2 AND path < ?3)")
            .and_then(|mut s| s.query_map(params![own, from, to], |r| Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get(2)?)))).map(|r| r.filter_map(Result::ok).collect()))
            .unwrap_or_default();
        let _ = self.db.execute("DELETE FROM tracks WHERE folder IN (SELECT id FROM folders WHERE path = ?1 OR (path >= ?2 AND path < ?3))", params![own, from, to]);
        let mut ids: HashMap<String, i64> = existing.iter().map(|(p, (id, _))| (p.clone(), *id)).collect();
        let mut parents: HashMap<i64, Option<i64>> = existing.values().map(|(id, parent)| (*id, *parent)).collect();
        // (files, audio, latest) per folder, counting everything at or below it.
        let mut counts: HashMap<i64, (i64, i64, f64)> = HashMap::new();
        for row in rows {
            // The folder and each one above it, created where missing.
            let mut parent: Option<i64> = None;
            let mut path = String::new();
            for segment in row.rel_dir.split('/') {
                if !path.is_empty() {
                    path.push('/');
                }
                path.push_str(segment);
                let id = match ids.get(&path) {
                    Some(&id) => id,
                    None => {
                        let _ = self.db.execute("INSERT INTO folders (parent, name, path, files, audio, latest) VALUES (?1, ?2, ?3, 0, 0, 0)", params![parent, segment, path]);
                        let id = self.db.last_insert_rowid();
                        ids.insert(path.clone(), id);
                        parents.insert(id, parent);
                        id
                    }
                };
                parent = Some(id);
            }
            let Some(folder) = parent else { continue };
            self.put_file(folder, &row.file);
            if row.project_created.is_some() {
                let _ = self.db.execute("UPDATE tracks SET project_created = ?1 WHERE path = ?2", params![row.project_created, row.file.path]);
            }
            let mut at = Some(folder);
            while let Some(id) = at {
                let entry = counts.entry(id).or_insert((0, 0, 0.0));
                entry.0 += 1;
                entry.1 += i64::from(row.file.kind == "audio");
                entry.2 = entry.2.max(row.file.mtime);
                at = parents.get(&id).copied().flatten();
            }
        }
        // Folders nothing is in any more go; the rest take their new counts.
        for (path, id) in &ids {
            match counts.get(id) {
                Some((files, audio, latest)) => {
                    let _ = self.db.execute("UPDATE folders SET files = ?1, audio = ?2, latest = ?3 WHERE id = ?4", params![files, audio, latest, id]);
                }
                None if path != label => {
                    let _ = self.db.execute("DELETE FROM folders WHERE id = ?1", params![id]);
                }
                None => {
                    let _ = self.db.execute("UPDATE folders SET files = 0, audio = 0, latest = 0 WHERE id = ?1", params![id]);
                }
            }
        }
        let _ = self.db.execute_batch("COMMIT");
    }

    /// Size and path of every file at or below a folder: what a delete would take with it.
    pub fn sizes_under(&self, rel: &str) -> Vec<(i64, String)> {
        let Ok(mut statement) = self.db.prepare(
            "SELECT t.size, t.path FROM tracks t JOIN folders f ON f.id = t.folder WHERE f.path = ?1 OR (f.path >= ?2 AND f.path < ?3)",
        ) else {
            return Vec::new();
        };
        statement
            .query_map(params![rel, format!("{rel}/"), format!("{rel}0")], |row| Ok((row.get(0)?, row.get(1)?)))
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    /// Every folder's id, parent, name, path and recorded mtime, and which folders hold rows
    /// the prober has not read: what a scan needs to decide what to skip, read once rather
    /// than asked of the database folder by folder.
    pub fn scan_plan(&self) -> (Vec<(i64, Option<i64>, String, String, Option<f64>)>, std::collections::HashSet<i64>) {
        let folders = self
            .db
            .prepare("SELECT id, parent, name, path, mtime FROM folders")
            .and_then(|mut s| s.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))).map(|rows| rows.filter_map(Result::ok).collect()))
            .unwrap_or_default();
        let unread = self
            .db
            .prepare("SELECT DISTINCT folder FROM tracks WHERE probed = 0")
            .and_then(|mut s| s.query_map([], |r| r.get(0)).map(|rows| rows.filter_map(Result::ok).collect()))
            .unwrap_or_default();
        (folders, unread)
    }

    pub fn set_folder_mtime(&self, id: i64, mtime: f64) {
        let _ = self.db.execute("UPDATE folders SET mtime = ?1 WHERE id = ?2", params![mtime, id]);
    }

    pub fn delete_file(&self, path: &str) {
        let _ = self.db.execute("DELETE FROM tracks WHERE path = ?1", params![path]);
    }

    /// A batch of writes as one transaction: a folder's rows land together, and quickly.
    pub fn begin(&self) {
        let _ = self.db.execute_batch("BEGIN");
    }

    pub fn commit(&self) {
        let _ = self.db.execute_batch("COMMIT");
    }

    /// Fills what the prober reads from the Electron app's saved index, for rows imported
    /// before the database had anywhere to keep it. Returns how many rows it filled.
    pub fn backfill(&self, index: &Path) -> usize {
        use std::io::BufRead;
        let Ok(file) = std::fs::File::open(index) else { return 0 };
        let Ok(mut update) = self.db.prepare(
            "UPDATE tracks SET duration = coalesce(?1, duration), sample_rate = coalesce(?2, sample_rate), bit_depth = ?3, channels = ?4,
               bitrate = ?5, project_seconds = ?6, project_created = ?7, probed = ?8 WHERE path = ?9",
        ) else {
            return 0;
        };
        let _ = self.db.execute_batch("BEGIN");
        let mut filled = 0;
        for line in std::io::BufReader::with_capacity(1 << 20, file).lines().map_while(Result::ok) {
            let Ok(t) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
            let n = |k: &str| t.get(k).and_then(|v| v.as_f64());
            let i = |k: &str| t.get(k).and_then(|v| v.as_i64());
            let probed = t.get("probed").and_then(|v| v.as_bool()).unwrap_or(false);
            if let Some(path) = t.get("path").and_then(|v| v.as_str()) {
                filled += update
                    .execute(params![n("duration"), i("sampleRate"), i("bitDepth"), i("channels"), i("bitrate"), n("projectSeconds"), n("projectCreatedMs"), probed, path])
                    .unwrap_or(0);
            }
        }
        let _ = self.db.execute_batch("COMMIT");
        filled
    }

    /// One file row by its path, and the folder it is in.
    pub fn file_at(&self, path: &str) -> Option<(i64, FileRow)> {
        self.db
            .query_row(
                &format!("SELECT {FILE_COLUMNS}, NULL, t.folder, f.path FROM tracks t JOIN folders f ON f.id = t.folder WHERE t.path = ?1"),
                params![path],
                |row| Ok((row.get::<_, i64>(DIR_COLUMN + 1)?, file_row(row, row.get(DIR_COLUMN + 2)?)?)),
            )
            .ok()
    }

    /// The rows a file operation took away: a file's, or a folder's and everything in it.
    /// Returns the folder whose counts changed.
    pub fn remove(&self, abs: &str, rel: Option<&str>, directory: bool) -> Option<i64> {
        if directory {
            let rel = rel?;
            let parent = self.folder_at(rel).and_then(|f| f.parent);
            let ids: Vec<i64> = {
                let mut statement = self.db.prepare("SELECT id FROM folders WHERE path = ?1 OR (path >= ?2 AND path < ?3)").ok()?;
                statement.query_map(params![rel, format!("{rel}/"), format!("{rel}0")], |r| r.get(0)).ok()?.filter_map(Result::ok).collect()
            };
            for id in &ids {
                let _ = self.db.execute("DELETE FROM tracks WHERE folder = ?1", params![id]);
                let _ = self.db.execute("DELETE FROM folders WHERE id = ?1", params![id]);
            }
            if let Some(parent) = parent {
                self.recount(parent);
            }
            parent
        } else {
            let folder: i64 = self.db.query_row("SELECT folder FROM tracks WHERE path = ?1", params![abs], |r| r.get(0)).ok()?;
            let _ = self.db.execute("DELETE FROM tracks WHERE path = ?1", params![abs]);
            self.recount(folder);
            Some(folder)
        }
    }

    /// Rows for something that has just arrived at `to` (absolute; `to_rel` inside the
    /// library), from `from` - whose old rows lend what was already read off the files
    /// (duration, tempo, key, rate), as `applyTransfer` carries it. What the index never held
    /// is described from the disk.
    pub fn arrive(&self, from: &Path, to: &Path, to_rel: &str, directory: bool) {
        let from_str = from.to_string_lossy().to_string();
        let to_str = to.to_string_lossy().to_string();
        let known: std::collections::HashMap<String, FileRow> = if directory {
            // A folder's old rows, found by absolute prefix ('\' + 1 is ']').
            let sql = format!("SELECT {FILE_COLUMNS} FROM tracks t WHERE t.path >= ?1 AND t.path < ?2");
            match self.db.prepare(&sql) {
                Ok(mut statement) => statement
                    .query_map(params![format!("{from_str}\\"), format!("{from_str}]")], |row| file_row(row, String::new()))
                    .map(|rows| rows.filter_map(Result::ok).map(|r| (r.path.clone(), r)).collect())
                    .unwrap_or_default(),
                Err(_) => return,
            }
        } else {
            self.file_at(&from_str).map(|(_, r)| (r.path.clone(), r)).into_iter().collect()
        };
        let parent_rel = to_rel.rsplit_once('/').map_or("", |(parent, _)| parent);
        let Some(parent) = self.folder_at(parent_rel) else { return };
        let carry = |row: &mut FileRow, origin: &str| {
            if let Some(old) = known.get(origin) {
                row.duration = old.duration;
                row.bpm = old.bpm;
                row.musical_key = old.musical_key.clone();
                row.sample_rate = old.sample_rate;
                row.bit_depth = old.bit_depth;
                row.channels = old.channels;
                row.bitrate = old.bitrate;
                row.project_seconds = old.project_seconds;
                row.probed = old.probed;
            }
        };
        if directory {
            self.index_tree(to, to_rel, Some(parent.id), &mut |row: &mut FileRow| {
                let origin = format!("{from_str}{}", &row.path[to_str.len().min(row.path.len())..]);
                carry(row, &origin);
            });
            self.recount(parent.id);
        } else if let Some(mut row) = crate::files::describe(to, parent_rel) {
            carry(&mut row, &from_str);
            self.put_file(parent.id, &row);
            self.recount(parent.id);
        }
    }

    /// Indexes a folder and everything in it from the disk, as rows under `parent`.
    fn index_tree(&self, abs: &Path, rel: &str, parent: Option<i64>, fill: &mut dyn FnMut(&mut FileRow)) {
        let name = rel.rsplit('/').next().unwrap_or(rel);
        let Some(id) = self.ensure_folder(parent, name, rel) else { return };
        let Ok(entries) = std::fs::read_dir(abs) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            let file_name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                if !crate::files::IGNORED_DIRS.contains(&file_name.to_lowercase().as_str()) {
                    self.index_tree(&path, &format!("{rel}/{file_name}"), Some(id), fill);
                }
            } else if let Some(mut row) = crate::files::describe(&path, rel) {
                fill(&mut row);
                self.put_file(id, &row);
            }
        }
        self.recount(id);
    }

    /// Re-reads one folder from the disk (`describeDir`): new files gain rows, gone ones lose
    /// them, a changed size or date is taken. Subfolders that appeared are indexed whole; ones
    /// that went are dropped. A folder that cannot be read is left exactly as it was - an
    /// unplugged drive is not an empty one. True when anything changed.
    pub fn sync_folder(&self, id: i64, abs: &Path) -> bool {
        let Some(folder) = self.folder(id) else { return false };
        let Ok(entries) = std::fs::read_dir(abs) else { return false };
        let mut on_disk_files = std::collections::HashMap::new();
        let mut on_disk_dirs = std::collections::HashSet::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let path = entry.path();
            if path.is_dir() {
                if !crate::files::IGNORED_DIRS.contains(&name.to_lowercase().as_str()) {
                    on_disk_dirs.insert(name);
                }
            } else if let Some(row) = crate::files::describe(&path, &folder.path) {
                on_disk_files.insert(row.path.clone(), row);
            }
        }
        let mut changed = false;
        for row in self.files(id) {
            match on_disk_files.remove(&row.path) {
                None => {
                    let _ = self.db.execute("DELETE FROM tracks WHERE path = ?1", params![row.path]);
                    changed = true;
                }
                Some(fresh) if fresh.size != row.size || (fresh.mtime - row.mtime).abs() > 1.0 => {
                    let _ = self.db.execute("UPDATE tracks SET size = ?1, mtime = ?2 WHERE path = ?3", params![fresh.size, fresh.mtime, row.path]);
                    changed = true;
                }
                Some(_) => {}
            }
        }
        for row in on_disk_files.values() {
            self.put_file(id, row);
            changed = true;
        }
        for child in self.children(Some(id)) {
            if !on_disk_dirs.remove(&child.name) {
                self.remove("", Some(&child.path), true);
                changed = true;
            }
        }
        for name in on_disk_dirs {
            let rel = if folder.path.is_empty() { name.clone() } else { format!("{}/{name}", folder.path) };
            self.index_tree(&abs.join(&name), &rel, Some(id), &mut |_: &mut FileRow| {});
            changed = true;
        }
        if changed {
            self.recount(id);
        }
        changed
    }
}

/// Suffixes a render carries that the project it came from does not, lower-case. Never `(1)`:
/// a duplicate is a different file named after this one, and stripping it would let any
/// project claim anything named after it.
const RENDER_SUFFIXES: [&str; 8] = ["_master", " master", "_notag", "_final", "_mixdown", "_mix", "_render", "_export"];

fn stem_of(name: &str) -> String {
    let stem = match name.rfind('.') {
        Some(dot) if dot > 0 => &name[..dot],
        _ => name,
    };
    stem.to_lowercase()
}

/// The stem a render shares with its project. Only a suffix shorter than the stem comes off,
/// or `master.wav` would reduce to nothing and match every project in the folder.
fn render_stem(name: &str) -> String {
    let mut stem = stem_of(name);
    loop {
        let Some(suffix) = RENDER_SUFFIXES.iter().find(|s| stem.len() > s.len() && stem.ends_with(*s)) else { return stem.trim().to_string() };
        stem.truncate(stem.len() - suffix.len());
        stem = stem.trim_end().to_string();
    }
}

#[cfg(test)]
mod render_tests {
    #[test]
    fn stems() {
        assert_eq!(super::render_stem("REFLECT_Master.wav"), "reflect");
        assert_eq!(super::render_stem("REFLECT_notag_master.wav"), "reflect");
        assert_eq!(super::render_stem("REFLECT.mp3"), "reflect");
        assert_eq!(super::render_stem("master.wav"), "master");
        assert_eq!(super::render_stem("REFLECT (1).wav"), "reflect (1)");
    }
}

pub fn format_count(n: i64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}
