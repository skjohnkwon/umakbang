use rusqlite::{Connection, OpenFlags};
use std::time::Instant;
fn main() {
    let path = std::env::args().nth(1).unwrap();
    let db = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    db.execute_batch("PRAGMA cache_size = -16000;").unwrap();
    let t = Instant::now();
    let ok = db.execute_batch("CREATE TEMP TABLE r(path TEXT PRIMARY KEY, stars INT); INSERT INTO r VALUES ('x', 3);");
    println!("temp table on read-only: {:?} in {:?}", ok.is_ok(), t.elapsed());
    for term in ["drum", "a", "kick 808", "zzzz"] {
        let t = Instant::now();
        let mut sql = String::from("SELECT count(*) FROM tracks t JOIN folders f ON f.id = t.folder WHERE 1");
        for w in term.split(' ') {
            sql.push_str(&format!(" AND (f.path || '/' || t.name) LIKE '%{w}%'"));
        }
        let n: i64 = db.query_row(&sql, [], |r| r.get(0)).unwrap();
        println!("{term:>9}: {n} in {:?}", t.elapsed());
    }
    let t = Instant::now();
    let n: i64 = db.query_row("SELECT count(*) FROM tracks t JOIN folders f ON f.id = t.folder WHERE instr(lower(f.path || '/' || t.name), 'drum') > 0", [], |r| r.get(0)).unwrap();
    println!("instr lower: {n} in {:?}", t.elapsed());
}
