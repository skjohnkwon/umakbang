//! Dates as the Electron app prints them (`formatDateTime`): `Intl.DateTimeFormat` with the
//! system locale, which on this machine is en-US - "Nov 07, 2021 03:45 PM", the year left off
//! inside the current one. ICU puts a narrow no-break space before the day period, drawn here as a space.

#[cfg(windows)]
use windows_sys::Win32::Foundation::{FILETIME, SYSTEMTIME};
#[cfg(windows)]
use windows_sys::Win32::System::Time::{FileTimeToSystemTime, SystemTimeToTzSpecificLocalTime};

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

#[cfg(windows)]
fn local(ms: f64) -> Option<SYSTEMTIME> {
    // FILETIME counts 100ns intervals from 1601.
    let ticks = ((ms + 11_644_473_600_000.0) * 10_000.0) as u64;
    let file = FILETIME { dwLowDateTime: ticks as u32, dwHighDateTime: (ticks >> 32) as u32 };
    let mut utc: SYSTEMTIME = unsafe { std::mem::zeroed() };
    let mut local: SYSTEMTIME = unsafe { std::mem::zeroed() };
    // SAFETY: plain conversions between stack structs.
    unsafe {
        if FileTimeToSystemTime(&file, &mut utc) == 0 || SystemTimeToTzSpecificLocalTime(std::ptr::null(), &utc, &mut local) == 0 {
            return None;
        }
    }
    Some(local)
}

/// The same fields Windows' `SYSTEMTIME` carries, so everything below reads one shape.
#[cfg(not(windows))]
#[allow(non_snake_case)]
struct Local {
    wYear: u16,
    wMonth: u16,
    wDayOfWeek: u16,
    wDay: u16,
    wHour: u16,
    wMinute: u16,
    wSecond: u16,
    wMilliseconds: u16,
}

#[cfg(not(windows))]
fn local(ms: f64) -> Option<Local> {
    let secs = (ms / 1000.0).floor();
    let millis = (ms - secs * 1000.0).clamp(0.0, 999.0) as u16;
    let t = secs as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    // SAFETY: localtime_r writes only into the struct it is handed.
    if unsafe { libc::localtime_r(&t, &mut tm) }.is_null() {
        return None;
    }
    Some(Local {
        wYear: (tm.tm_year + 1900) as u16,
        wMonth: (tm.tm_mon + 1) as u16,
        wDayOfWeek: tm.tm_wday as u16,
        wDay: tm.tm_mday as u16,
        wHour: tm.tm_hour as u16,
        wMinute: tm.tm_min as u16,
        wSecond: tm.tm_sec.min(59) as u16,
        wMilliseconds: millis,
    })
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

/// `formatDate`: "Nov 07", or "Nov 07, 2021" outside the current year.
pub fn date(ms: f64) -> Option<String> {
    if ms <= 0.0 {
        return None;
    }
    let t = local(ms)?;
    let now = local(now_ms())?;
    let month = MONTHS.get(t.wMonth as usize - 1)?;
    Some(if t.wYear == now.wYear { format!("{month} {:02}", t.wDay) } else { format!("{month} {:02}, {}", t.wDay, t.wYear) })
}

/// The local clock time as fractional hours, for `dayPosition`.
pub fn hours(ms: f64) -> f32 {
    local(ms).map_or(12.0, |t| t.wHour as f32 + t.wMinute as f32 / 60.0)
}

/// `YYYYMMDD-HHMMSS` now, local - the backup files' stamp.
pub fn stamp() -> String {
    match local(now_ms()) {
        Some(t) => format!("{:04}{:02}{:02}-{:02}{:02}{:02}", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond),
        None => "00000000-000000".into(),
    }
}

pub fn date_time(ms: f64) -> Option<String> {
    let date = date(ms)?;
    let t = local(ms)?;
    let hour = match t.wHour % 12 {
        0 => 12,
        h => h,
    };
    let period = if t.wHour < 12 { "AM" } else { "PM" };
    // ICU writes a narrow no-break space before the day period. Segoe UI has no glyph for it
    // and Chromium's fallback draws it about as wide as a space; through cosmic-text it came
    // out zero-width, "10:43PM". A plain space is what the Electron app shows.
    Some(format!("{date} {hour:02}:{:02} {period}", t.wMinute))
}

/// Local time minus UTC at instant `utc_ms`, in milliseconds: what a wall-clock reading
/// needs taking off to become an instant again.
pub fn offset_ms(utc_ms: f64) -> f64 {
    let Some(t) = local(utc_ms) else { return 0.0 };
    // The local fields read back as if they were UTC, against the instant itself.
    let days = days_from_civil(t.wYear as i64, t.wMonth as i64, t.wDay as i64) as f64;
    let as_utc = days * 86_400_000.0 + t.wHour as f64 * 3_600_000.0 + t.wMinute as f64 * 60_000.0 + t.wSecond as f64 * 1000.0 + t.wMilliseconds as f64;
    ((as_utc - utc_ms) / 60_000.0).round() * 60_000.0
}

/// Days from 1970-01-01 to a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// A local calendar reading of an instant: the fields `Date` hands the stats page.
#[derive(Clone, Copy, Debug)]
pub struct Parts {
    pub year: i64,
    /// 1-12.
    pub month: i64,
    pub day: i64,
    /// Monday is 0, as the stats page counts weeks.
    pub weekday: usize,
    pub hour: usize,
}

pub fn parts(ms: f64) -> Option<Parts> {
    let t = local(ms)?;
    Some(Parts { year: t.wYear as i64, month: t.wMonth as i64, day: t.wDay as i64, weekday: (t.wDayOfWeek as usize + 6) % 7, hour: t.wHour as usize })
}

/// Local midnight of a civil date, `new Date(y, m - 1, d)`: a month or day out of range rolls
/// over into the next, as it does there.
pub fn midnight(year: i64, month: i64, day: i64) -> f64 {
    let m0 = month - 1;
    let (y, m) = (year + m0.div_euclid(12), m0.rem_euclid(12) + 1);
    let wall = days_from_civil(y, m, 1) as f64 * 86_400_000.0 + (day - 1) as f64 * 86_400_000.0;
    let guess = wall - offset_ms(wall);
    wall - offset_ms(guess)
}

/// `startOfDayMs`.
pub fn start_of_day(ms: f64) -> f64 {
    parts(ms).map_or(ms, |p| midnight(p.year, p.month, p.day))
}

/// `addDays`: by calendar date, so a DST change does not drift it.
pub fn add_days(ms: f64, days: i64) -> f64 {
    parts(ms).map_or(ms + days as f64 * 86_400_000.0, |p| midnight(p.year, p.month, p.day + days))
}

pub fn now() -> f64 {
    now_ms()
}

pub const MONTH_NAMES: [&str; 12] = MONTHS;
pub const WEEKDAY_NAMES: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/// `toLocaleDateString` with a short month: "May 18", "May 18, 2026", "Mon, May 18".
pub fn format_day(ms: f64, year: bool, weekday: bool) -> String {
    let Some(p) = parts(ms) else { return String::new() };
    let mut out = String::new();
    if weekday {
        out.push_str(WEEKDAY_NAMES[p.weekday]);
        out.push_str(", ");
    }
    out.push_str(&format!("{} {}", MONTHS[p.month as usize - 1], p.day));
    if year {
        out.push_str(&format!(", {}", p.year));
    }
    out
}

/// `Date.prototype.toISOString`: UTC, to the millisecond.
pub fn iso_utc(ms: f64) -> String {
    let total = ms.floor() as i64;
    let (days, rem) = (total.div_euclid(86_400_000), total.rem_euclid(86_400_000));
    // Howard Hinnant's `civil_from_days`.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3_600_000, rem / 60_000 % 60, rem / 1000 % 60, rem % 1000)
}

#[cfg(test)]
mod iso_tests {
    #[test]
    fn iso() {
        assert_eq!(super::iso_utc(0.0), "1970-01-01T00:00:00.000Z");
        assert_eq!(super::iso_utc(1_795_000_000_123.0), "2026-11-18T11:06:40.123Z");
    }
}
