//! The app's log: one line per thing worth reading back later (a Pkarr publish or read and how long it
//! took, each step of a link's way to a live connection, an error), in `ghostly.log` under the app's
//! log directory (macOS: `~/Library/Logs/<bundle id>/`), and on stderr as well. Always on, small, and
//! never in the way: writing is best effort, the file is rotated once at 2 MiB, and nothing here can fail
//! the caller.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const FILE_NAME: &str = "ghostly.log";
const ROTATE_AT_BYTES: u64 = 2 * 1024 * 1024;

struct Log {
    path: PathBuf,
    file: Option<File>,
    written: u64,
}

static LOG: OnceLock<Mutex<Log>> = OnceLock::new();

/// Where the lines go. Called once, when the app starts; before that (and in tests) lines only reach stderr.
pub fn init(dir: &Path) {
    let _ = fs::create_dir_all(dir);
    let path = dir.join(FILE_NAME);
    let written = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .ok();
    let _ = LOG.set(Mutex::new(Log {
        path,
        file,
        written,
    }));
    log(&format!("log opened, app {}", env!("CARGO_PKG_VERSION")));
}

/// The path of the log, once `init` ran.
#[cfg(test)]
pub fn path() -> Option<PathBuf> {
    LOG.get()
        .and_then(|log| log.lock().ok())
        .map(|log| log.path.clone())
}

/// One line, prefixed with the time (ms since the epoch): `1790306343681 pkarr publish 1s1boz visible=412ms`.
pub fn log(line: &str) {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    // One line per call, whatever the caller passed.
    let clean: String = line
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect();
    let full = format!("{millis} {clean}\n");
    eprint!("{full}");
    let Some(log) = LOG.get() else { return };
    let Ok(mut log) = log.lock() else { return };
    if log.written + full.len() as u64 > ROTATE_AT_BYTES {
        let rotated = log.path.with_extension("log.1");
        let _ = fs::rename(&log.path, rotated);
        log.file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log.path)
            .ok();
        log.written = 0;
    }
    if let Some(file) = log.file.as_mut() {
        if file.write_all(full.as_bytes()).is_ok() {
            log.written += full.len() as u64;
        }
    }
}

#[cfg(test)]
mod tests {
    // covers: desktop.diagnostics
    use super::*;

    #[test]
    fn a_line_is_one_line_with_the_time_in_front() {
        let dir = std::env::temp_dir().join(format!("ghostly-log-{}", std::process::id()));
        // The global is set once per process: the first test to run opens it; the others reuse it.
        init(&dir);
        log("hello\nworld");
        let text = fs::read_to_string(path().unwrap()).unwrap();
        let line = text
            .lines()
            .find(|l| l.contains("hello"))
            .expect("the line");
        let (time, rest) = line.split_once(' ').unwrap();
        assert!(time.parse::<u128>().is_ok(), "{line}");
        assert_eq!(rest, "hello world");
        let _ = fs::remove_dir_all(dir);
    }
}
