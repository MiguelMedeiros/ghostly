//! Files sent and received in chats, as real files in the app's data folder: `files/<space>/<id>`,
//! one folder per profile (`space` is the page's database name). The peer in the WebView writes a
//! file in order, a step at a time, and reads it back in ranges, so no file is ever held whole in
//! memory, on either side of the IPC. Ids and spaces are checked to be plain names, never paths.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use tauri::ipc::{InvokeBody, Request, Response};

/// The most one call moves: the page reads and writes 1 MiB at a time, this leaves room.
pub const MAX_STEP: u64 = 16 * 1024 * 1024;

/// A copy the page stages to save bytes it holds in memory through the save dialog: `save-<uuid>`.
const STAGED_SAVE_PREFIX: &str = "save-";

/// A profile space (the page's database name) is a plain name, never a path.
pub fn check_space(space: &str) -> Result<(), String> {
    if space.is_empty()
        || space.len() > 100
        || space.starts_with('.')
        || !space
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
    {
        return Err("Invalid profile space".into());
    }
    Ok(())
}

/// What a profile's files take on disk ([`FileStore::usage`]), for Settings' "Storage used".
#[derive(serde::Serialize, Default, Debug, PartialEq, Eq)]
pub struct Usage {
    /// The bytes of the files sent and received.
    pub files: u64,
    /// How many files.
    pub count: u64,
    /// The bytes of the copies staged for a save (a backup, a file being saved).
    pub staged: u64,
}

/// Where the files are: set once the app knows its data folder.
#[derive(Clone)]
pub struct FileStore {
    base: PathBuf,
}

impl FileStore {
    pub fn new(base: PathBuf) -> Self {
        Self { base }
    }

    /// Once at start: a files folder an older version made with the default mode (others may list it, on a
    /// machine whose home folders they may enter) becomes the user's alone. Best effort.
    pub fn keep_private(&self) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if self.base.is_dir() {
                let _ = fs::set_permissions(&self.base, fs::Permissions::from_mode(0o700));
            }
        }
    }

    /// Once at start, before anyone can press Save: copies staged for a save that never finished are removed from every
    /// profile's folder. The page removes its copy once the save command answers (`saveStaged` in
    /// packages/browser/src/platform/services.ts), but a save dialog that never answers (on Linux GTK's can open
    /// out of sight, and waits with no timeout) keeps the command waiting, and closing the app or reloading the page
    /// then leaves the copy behind. Nothing is being saved yet here. Best effort.
    pub fn remove_staged_saves(&self) {
        let Ok(spaces) = fs::read_dir(&self.base) else {
            return;
        };
        for space in spaces.flatten() {
            let name = space.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if check_space(name).is_ok() && space.path().is_dir() {
                let _ = self.remove_where(name, STAGED_SAVE_PREFIX);
            }
        }
    }

    fn folder(&self, space: &str) -> Result<PathBuf, String> {
        check_space(space)?;
        Ok(self.base.join(space))
    }

    fn path(&self, space: &str, id: &str) -> Result<PathBuf, String> {
        Ok(self.folder(space)?.join(check_id(id)?))
    }

    /// Where a stored file is, for serving it in ranges (`file_stream.rs`): checked like every other access.
    pub fn path_of(&self, space: &str, id: &str) -> Result<PathBuf, String> {
        self.path(space, id)
    }

    /// Writes `bytes` at `offset`, which must be the file's length: files grow in order only.
    pub fn append(&self, space: &str, id: &str, offset: u64, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() as u64 > MAX_STEP {
            return Err("Too much at once".into());
        }
        let path = self.path(space, id)?;
        private_folder(path.parent().unwrap()).map_err(|e| e.to_string())?;
        let mut options = OpenOptions::new();
        options.create(true).truncate(false).write(true);
        // A received file is the chat's plain bytes: the user's alone, whatever the umask.
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&path).map_err(|e| e.to_string())?;
        let length = file.metadata().map_err(|e| e.to_string())?.len();
        if length != offset {
            return Err("File write out of order".into());
        }
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())
    }

    /// What was written so far survives a crash. Opened for writing: Windows refuses to flush a read-only handle
    /// (`FlushFileBuffers`, "Access is denied").
    pub fn flush(&self, space: &str, id: &str) -> Result<(), String> {
        match OpenOptions::new().write(true).open(self.path(space, id)?) {
            Ok(file) => file.sync_all().map_err(|e| e.to_string()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn size(&self, space: &str, id: &str) -> Result<Option<u64>, String> {
        match fs::metadata(self.path(space, id)?) {
            Ok(meta) => Ok(Some(meta.len())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn truncate(&self, space: &str, id: &str, size: u64) -> Result<(), String> {
        let path = self.path(space, id)?;
        let file = match OpenOptions::new().write(true).open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && size == 0 => return Ok(()),
            Err(e) => return Err(e.to_string()),
        };
        if size < file.metadata().map_err(|e| e.to_string())?.len() {
            file.set_len(size).map_err(|e| e.to_string())?;
        }
        file.sync_all().map_err(|e| e.to_string())
    }

    /// At most `length` bytes from `offset`; fewer only at the end of the file.
    pub fn read(&self, space: &str, id: &str, offset: u64, length: u64) -> Result<Vec<u8>, String> {
        let mut file = File::open(self.path(space, id)?).map_err(|e| e.to_string())?;
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        file.take(length.min(MAX_STEP))
            .read_to_end(&mut out)
            .map_err(|e| e.to_string())?;
        Ok(out)
    }

    /// SHA-256 of the stored file, base64url, read in 1 MiB steps.
    pub fn digest(&self, space: &str, id: &str) -> Result<String, String> {
        let mut file = File::open(self.path(space, id)?).map_err(|e| e.to_string())?;
        Ok(URL_SAFE_NO_PAD.encode(digest_of(&mut file)?))
    }

    pub fn remove(&self, space: &str, id: &str) -> Result<(), String> {
        match fs::remove_file(self.path(space, id)?) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

    /// Every file of the space whose id starts with `prefix` ("" for all of them).
    pub fn remove_where(&self, space: &str, prefix: &str) -> Result<(), String> {
        if !prefix.is_empty() {
            check_id(prefix)?;
        }
        let folder = self.folder(space)?;
        let entries = match fs::read_dir(&folder) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.to_string()),
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name.to_string_lossy().starts_with(prefix) && entry.path().is_file() {
                fs::remove_file(entry.path()).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    /// What the space's folder holds: the bytes of its files, and of the copies staged for a save (`save-…`:
    /// a backup being made, or a file on its way through the save dialog), apart. A folder not made yet holds
    /// nothing.
    pub fn usage(&self, space: &str) -> Result<Usage, String> {
        let folder = self.folder(space)?;
        let entries = match fs::read_dir(&folder) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Usage::default()),
            Err(e) => return Err(e.to_string()),
        };
        let mut usage = Usage::default();
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            if entry
                .file_name()
                .to_string_lossy()
                .starts_with(STAGED_SAVE_PREFIX)
            {
                usage.staged += meta.len();
            } else {
                usage.files += meta.len();
                usage.count += 1;
            }
        }
        Ok(usage)
    }

    /// Free bytes on the disk that holds the files.
    pub fn room(&self) -> Result<u64, String> {
        let mut dir = self.base.as_path();
        // The folder may not exist yet: the first one up that does is on the same disk.
        while !dir.exists() {
            dir = dir.parent().ok_or("No data folder")?;
        }
        fs4::available_space(dir).map_err(|e| e.to_string())
    }

    /// Copies a stored file to `target`, a step at a time, marked as downloaded (`mark_downloaded`).
    pub fn copy_to(&self, space: &str, id: &str, target: &Path) -> Result<(), String> {
        let mut from = File::open(self.path(space, id)?).map_err(|e| e.to_string())?;
        write_whole(target, |to| std::io::copy(&mut from, to).map(|_| ()))?;
        mark_downloaded(target);
        Ok(())
    }
}

/// Writes `target` whole or not at all. The bytes go to a hidden name in the same folder (so the
/// rename stays on one disk) and take the chosen name only once all of them are on the disk. A copy
/// that fails partway (a full disk, a removed drive) leaves no half file under the name the person
/// chose, and does not truncate a file that was there before.
fn write_whole(
    target: &Path,
    write: impl FnOnce(&mut File) -> std::io::Result<()>,
) -> Result<(), String> {
    let partial = partial_path(target)?;
    let result = (|| {
        let mut to = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&partial)?;
        write(&mut to)?;
        to.sync_all()?;
        drop(to);
        fs::rename(&partial, target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result.map_err(|e| e.to_string())
}

/// `.<name>.<random>.part` beside `target`.
fn partial_path(target: &Path) -> Result<PathBuf, String> {
    let name = target
        .file_name()
        .ok_or_else(|| "The chosen place has no file name".to_string())?;
    let mut partial = std::ffi::OsString::from(".");
    partial.push(name);
    partial.push(format!(".{:016x}.part", rand::random::<u64>()));
    Ok(target.with_file_name(partial))
}

/// The system's "downloaded from the internet" mark on a saved copy: a contact sent it, so opening
/// or running it goes through Gatekeeper (macOS) or SmartScreen and Office's Protected View
/// (Windows) first, as it would from a browser. Best effort: a disk that cannot hold the mark (FAT,
/// some network shares) still gets the copy.
fn mark_downloaded(target: &Path) {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStrExt;
        let Ok(path) = std::ffi::CString::new(target.as_os_str().as_bytes()) else {
            return;
        };
        let seconds = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        // Flags 0x0001 (downloaded) and 0x0080, as browsers write them; then time and agent.
        let value = format!("0081;{seconds:08x};Ghostly;");
        // SAFETY: both names are NUL-terminated; the value is passed with its length.
        unsafe {
            libc::setxattr(
                path.as_ptr(),
                c"com.apple.quarantine".as_ptr(),
                value.as_ptr().cast(),
                value.len(),
                0,
                0,
            );
        }
    }
    #[cfg(windows)]
    {
        // The Mark of the Web: an NTFS stream next to the file's data, zone 3 (internet).
        let mut stream = target.as_os_str().to_owned();
        stream.push(":Zone.Identifier");
        let _ = fs::write(PathBuf::from(stream), "[ZoneTransfer]\r\nZoneId=3\r\n");
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    let _ = target;
}

/// The folder and any missing above it, made the user's alone (0700) on Unix.
fn private_folder(path: &Path) -> std::io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(path)
}

fn check_id(id: &str) -> Result<&str, String> {
    if id.is_empty()
        || id.len() > 200
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
    {
        return Err("Invalid file id".into());
    }
    Ok(id)
}

fn digest_of(reader: &mut impl Read) -> Result<[u8; 32], String> {
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = reader.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(hash.finalize().into())
}

/// Characters that hide or reorder text: "invoice\u{202E}fdp.exe" reads as "invoiceexe.pdf".
fn invisible(c: char) -> bool {
    matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{206F}' | '\u{2028}' | '\u{2029}' | '\u{FEFF}')
}

/// The longest name the save dialog is given, in characters (as packages/core `sanitizeFileName`).
const MAX_NAME_CHARS: usize = 200;

/// A suggested name for the save dialog: what the chat shows, without anything that reads as a path.
/// A longer one loses the end of its stem, not its extension (up to 15 characters after the last dot).
fn suggested_name(name: &str) -> String {
    let clean: String = name
        .chars()
        .filter(|c| !c.is_control() && !invisible(*c) && !matches!(c, '/' | '\\' | ':'))
        .collect();
    let clean = clean.trim().trim_start_matches('.');
    if clean.is_empty() {
        return "file".into();
    }
    let chars: Vec<char> = clean.chars().collect();
    if chars.len() <= MAX_NAME_CHARS {
        return clean.to_string();
    }
    let extension: Vec<char> = match chars.iter().rposition(|c| *c == '.') {
        Some(dot)
            if (2..=16).contains(&(chars.len() - dot))
                && !chars[dot + 1..].iter().any(|c| c.is_whitespace()) =>
        {
            chars[dot..].to_vec()
        }
        _ => Vec::new(),
    };
    let stem: String = chars[..MAX_NAME_CHARS - extension.len()].iter().collect();
    stem.trim_end().chars().chain(extension).collect()
}

fn store<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<tauri::State<'_, FileStore>, String> {
    use tauri::Manager;
    app.try_state::<FileStore>()
        .ok_or_else(|| "File storage unavailable".into())
}

fn header<'a>(request: &'a Request<'_>, name: &str) -> Result<&'a str, String> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| format!("Missing {name}"))
}

/// The raw body is the bytes; `x-space`, `x-id` and `x-offset` say where they go.
#[tauri::command]
pub async fn file_bytes_append<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    request: Request<'_>,
) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected raw bytes".into());
    };
    let space = header(&request, "x-space")?.to_string();
    let id = header(&request, "x-id")?.to_string();
    let offset: u64 = header(&request, "x-offset")?
        .parse()
        .map_err(|_| "Invalid offset")?;
    let bytes = bytes.clone();
    let store = store(&app)?;
    let base = store.base.clone();
    tauri::async_runtime::spawn_blocking(move || {
        FileStore::new(base).append(&space, &id, offset, &bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn file_bytes_flush<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    space: String,
    id: String,
) -> Result<(), String> {
    let base = store(&app)?.base.clone();
    tauri::async_runtime::spawn_blocking(move || FileStore::new(base).flush(&space, &id))
        .await
        .map_err(|e| e.to_string())?
}

/// Nothing stays open between calls, so closing is making it durable.
#[tauri::command]
pub async fn file_bytes_close<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    space: String,
    id: String,
) -> Result<(), String> {
    file_bytes_flush(app, space, id).await
}

#[tauri::command]
pub fn file_bytes_size<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    space: String,
    id: String,
) -> Result<Option<u64>, String> {
    store(&app)?.size(&space, &id)
}

#[tauri::command]
pub async fn file_bytes_truncate<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    space: String,
    id: String,
    size: u64,
) -> Result<(), String> {
    let base = store(&app)?.base.clone();
    tauri::async_runtime::spawn_blocking(move || FileStore::new(base).truncate(&space, &id, size))
        .await
        .map_err(|e| e.to_string())?
}

/// Raw bytes back, not JSON: a 1 MiB read stays 1 MiB on the way.
#[tauri::command]
pub async fn file_bytes_read<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    space: String,
    id: String,
    offset: u64,
    length: u64,
) -> Result<Response, String> {
    let base = store(&app)?.base.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        FileStore::new(base).read(&space, &id, offset, length)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn file_bytes_digest<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    space: String,
    id: String,
) -> Result<String, String> {
    let base = store(&app)?.base.clone();
    tauri::async_runtime::spawn_blocking(move || FileStore::new(base).digest(&space, &id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn file_bytes_remove<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    space: String,
    id: String,
) -> Result<(), String> {
    store(&app)?.remove(&space, &id)
}

#[tauri::command]
pub fn file_bytes_remove_where<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    space: String,
    prefix: String,
) -> Result<(), String> {
    use tauri::Manager;
    store(&app)?.remove_where(&space, &prefix)?;
    // A profile's files all gone: so are the tokens that played them.
    if prefix.is_empty() {
        if let Some(grants) = app.try_state::<crate::file_stream::StreamGrants>() {
            grants.close_space(&space);
        }
    }
    Ok(())
}

/// What the profile's files take on disk: `{ files, count, staged }` in bytes ([`FileStore::usage`]).
#[tauri::command]
pub async fn file_bytes_usage<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    space: String,
) -> Result<Usage, String> {
    let store = store(&app)?.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.usage(&space))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn file_bytes_room<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    space: String,
) -> Result<u64, String> {
    let store = store(&app)?;
    store.folder(&space)?;
    store.room()
}

/// Asks where to save a copy (the system's save dialog), then copies the file there. False when
/// the person cancelled.
#[tauri::command]
pub async fn file_bytes_save<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    space: String,
    id: String,
    name: String,
) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;
    let base = store(&app)?.base.clone();
    let files = FileStore::new(base);
    files.path(&space, &id)?;
    let dialog = app.dialog().file().set_file_name(suggested_name(&name));
    let target = tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file())
        .await
        .map_err(|e| e.to_string())?;
    let Some(target) = target else {
        return Ok(false);
    };
    let target = target.into_path().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || files.copy_to(&space, &id, &target))
        .await
        .map_err(|e| e.to_string())??;
    Ok(true)
}

#[cfg(test)]
mod tests {
    // covers: files.storage, files.download
    use super::*;

    fn store() -> (FileStore, PathBuf) {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "ghostly-files-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        (FileStore::new(dir.clone()), dir)
    }

    /// Deterministic bytes, made a step at a time: the test never holds the whole file.
    fn step(index: u64, len: usize) -> Vec<u8> {
        (0..len)
            .map(|i| ((index * 7919 + i as u64 * 31) % 251) as u8)
            .collect()
    }

    #[test]
    fn a_file_written_in_steps_reads_back_in_ranges_and_hashes_like_its_stream() {
        let (files, dir) = store();
        let steps = 48u64;
        let size = 1024 * 1024;
        let mut hash = Sha256::new();
        for index in 0..steps {
            let bytes = step(index, size);
            hash.update(&bytes);
            files
                .append("ghostly", "chat-in-abc", index * size as u64, &bytes)
                .unwrap();
        }
        files.flush("ghostly", "chat-in-abc").unwrap();
        assert_eq!(
            files.size("ghostly", "chat-in-abc").unwrap(),
            Some(steps * size as u64)
        );
        assert_eq!(
            files.digest("ghostly", "chat-in-abc").unwrap(),
            URL_SAFE_NO_PAD.encode(hash.finalize())
        );
        let middle = files
            .read("ghostly", "chat-in-abc", 5 * size as u64 + 10, 100)
            .unwrap();
        assert_eq!(middle, step(5, size)[10..110].to_vec());
        let end = files
            .read("ghostly", "chat-in-abc", steps * size as u64 - 3, 100)
            .unwrap();
        assert_eq!(end.len(), 3);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn usage_counts_a_profiles_files_and_its_staged_copies_apart() {
        // covers: settings.storage-used
        let (files, dir) = store();
        assert_eq!(files.usage("p").unwrap(), Usage::default(), "no folder yet");
        files.append("p", "chat-in-a", 0, &[1; 1000]).unwrap();
        files.append("p", "chat-out-b", 0, &[2; 24]).unwrap();
        files.append("p", "save-backup-1", 0, &[3; 500]).unwrap();
        files.append("p", "save-2", 0, &[4; 12]).unwrap();
        files.append("other", "chat-in-c", 0, &[5; 7000]).unwrap();
        assert_eq!(
            files.usage("p").unwrap(),
            Usage {
                files: 1024,
                count: 2,
                staged: 512
            }
        );
        assert!(files.usage("../p").is_err(), "a space is never a path");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn writes_go_in_order_and_truncate_goes_back_to_a_point() {
        let (files, dir) = store();
        files.append("p", "f1", 0, b"hello").unwrap();
        assert!(files.append("p", "f1", 3, b"x").is_err(), "an overlap");
        assert!(files.append("p", "f1", 9, b"x").is_err(), "a gap");
        files.append("p", "f1", 5, b" world").unwrap();
        files.truncate("p", "f1", 5).unwrap();
        assert_eq!(files.size("p", "f1").unwrap(), Some(5));
        files.append("p", "f1", 5, b"!").unwrap();
        assert_eq!(files.read("p", "f1", 0, 100).unwrap(), b"hello!");
        files.truncate("p", "missing", 0).unwrap();
        assert!(files.truncate("p", "missing", 1).is_err());
        fs::remove_dir_all(dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn stored_files_and_their_folders_are_the_users_alone() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        let (files, dir) = store();
        files.append("space", "chat-in-x", 0, b"bytes").unwrap();
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&dir.join("space")), 0o700);
        assert_eq!(mode(&dir.join("space").join("chat-in-x")), 0o600);
        // A folder an older version left open to others is closed at start.
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        files.keep_private();
        assert_eq!(mode(&dir), 0o700);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn ids_and_spaces_are_names_never_paths() {
        let (files, dir) = store();
        for id in ["../x", "a/b", "", "a.b", "..", &"x".repeat(201)] {
            assert!(files.append("p", id, 0, b"x").is_err(), "{id}");
        }
        for space in ["..", ".hidden", "a/b", ""] {
            assert!(files.append(space, "f", 0, b"x").is_err(), "{space}");
        }
        assert!(files.remove_where("p", "../").is_err());
        assert!(!dir.join("x").exists());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn removing_by_prefix_keeps_other_chats_and_spaces() {
        let (files, dir) = store();
        for (space, id) in [
            ("p", "chatA-in-1"),
            ("p", "chatA-out-2"),
            ("p", "chatB-in-3"),
            ("q", "chatA-in-4"),
        ] {
            files.append(space, id, 0, b"x").unwrap();
        }
        files.remove_where("p", "chatA-").unwrap();
        assert_eq!(files.size("p", "chatA-in-1").unwrap(), None);
        assert_eq!(files.size("p", "chatA-out-2").unwrap(), None);
        assert_eq!(files.size("p", "chatB-in-3").unwrap(), Some(1));
        assert_eq!(files.size("q", "chatA-in-4").unwrap(), Some(1));
        files.remove_where("p", "").unwrap();
        assert_eq!(files.size("p", "chatB-in-3").unwrap(), None);
        files.remove("q", "chatA-in-4").unwrap();
        files.remove("q", "chatA-in-4").unwrap();
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn room_is_the_free_space_of_the_disk_even_before_the_folder_exists() {
        let (files, _dir) = store();
        assert!(files.room().unwrap() > 0);
    }

    #[test]
    fn copies_staged_for_a_save_that_never_finished_are_gone_at_start() {
        let (files, dir) = store();
        // Left by a save whose dialog never answered before the app closed, in two profiles.
        files
            .append("ghostly", "save-1b4e28ba", 0, b"voice")
            .unwrap();
        files
            .append("ghostly", "save-6ba7b810", 0, b"photo")
            .unwrap();
        files
            .append("ghostly_p2", "save-0f0e0d0c", 0, b"mp3")
            .unwrap();
        // The chats' own files stay, even one whose name only starts alike.
        files.append("ghostly", "chat-in-abc", 0, b"kept").unwrap();
        files.append("ghostly", "saved-note", 0, b"kept").unwrap();
        files
            .append("ghostly_p2", "chat-out-xyz", 0, b"kept")
            .unwrap();
        // Not a profile's folder: left alone.
        fs::write(dir.join("save-stray"), b"not a space").unwrap();
        fs::create_dir_all(dir.join(".hidden")).unwrap();
        fs::write(dir.join(".hidden").join("save-x"), b"not a space").unwrap();

        files.remove_staged_saves();

        assert_eq!(files.size("ghostly", "save-1b4e28ba").unwrap(), None);
        assert_eq!(files.size("ghostly", "save-6ba7b810").unwrap(), None);
        assert_eq!(files.size("ghostly_p2", "save-0f0e0d0c").unwrap(), None);
        assert_eq!(files.size("ghostly", "chat-in-abc").unwrap(), Some(4));
        assert_eq!(files.size("ghostly", "saved-note").unwrap(), Some(4));
        assert_eq!(files.size("ghostly_p2", "chat-out-xyz").unwrap(), Some(4));
        assert!(dir.join("save-stray").is_file());
        assert!(dir.join(".hidden").join("save-x").is_file());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn with_no_files_folder_yet_there_is_nothing_to_remove() {
        let (files, dir) = store();
        files.remove_staged_saves();
        assert!(!dir.exists());
    }

    #[test]
    fn a_saved_copy_is_the_same_bytes_under_a_clean_name() {
        let (files, dir) = store();
        files.append("p", "f", 0, &step(1, 300_000)).unwrap();
        let target = dir.join("copy.bin");
        files.copy_to("p", "f", &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), step(1, 300_000));
        assert_eq!(suggested_name("../../etc/passwd"), "etcpasswd");
        assert_eq!(suggested_name(" .bashrc"), "bashrc");
        assert_eq!(suggested_name("invoice\u{202e}fdp.exe"), "invoicefdp.exe");
        assert_eq!(suggested_name(""), "file");
        // A long name is shortened before its extension, so it keeps its type.
        let long = format!("{}.pdf", "r".repeat(230));
        assert_eq!(suggested_name(&long), format!("{}.pdf", "r".repeat(196)));
        assert_eq!(
            suggested_name(&format!("{}    b.txt", "a".repeat(195))),
            format!("{}.txt", "a".repeat(195))
        );
        assert_eq!(
            suggested_name(&format!("{}.{}", "a".repeat(195), "b".repeat(40)))
                .chars()
                .count(),
            200
        );
        assert_eq!(suggested_name(&"x".repeat(500)).chars().count(), 200);
        // A downloaded voice message's name (made by the app) goes through as it is.
        assert_eq!(
            suggested_name("Ghostly voice 2026-09-27 14.01.30.webm"),
            "Ghostly voice 2026-09-27 14.01.30.webm"
        );
        fs::remove_dir_all(dir).ok();
    }

    /// A saved copy came from a contact: it carries the system's "downloaded from the internet"
    /// mark, so opening it goes through Gatekeeper (macOS) or SmartScreen (Windows) first.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_saved_copy_is_quarantined() {
        use std::os::unix::ffi::OsStrExt;
        let (files, dir) = store();
        files.append("p", "f", 0, b"#!/bin/sh\necho boo\n").unwrap();
        let target = dir.join("run me.command");
        files.copy_to("p", "f", &target).unwrap();

        let path = std::ffi::CString::new(target.as_os_str().as_bytes()).unwrap();
        let mut value = [0u8; 256];
        // SAFETY: both strings are NUL-terminated and the buffer is as long as the size given.
        let read = unsafe {
            libc::getxattr(
                path.as_ptr(),
                c"com.apple.quarantine".as_ptr(),
                value.as_mut_ptr().cast(),
                value.len(),
                0,
                0,
            )
        };
        assert!(read > 0, "no quarantine attribute on the saved copy");
        let value = std::str::from_utf8(&value[..read as usize]).unwrap();
        let fields: Vec<&str> = value.split(';').collect();
        assert_eq!(fields[0], "0081", "{value}");
        assert!(u64::from_str_radix(fields[1], 16).unwrap() > 0, "{value}");
        assert_eq!(fields[2], "Ghostly", "{value}");
        fs::remove_dir_all(dir).ok();
    }

    /// The names in a folder, sorted.
    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_saved_copy_takes_its_name_whole_and_leaves_nothing_else() {
        let (files, dir) = store();
        files.append("p", "f", 0, &step(1, 300_000)).unwrap();
        let out = dir.join("out");
        fs::create_dir_all(&out).unwrap();
        let target = out.join("photo.jpg");
        files.copy_to("p", "f", &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), step(1, 300_000));
        assert_eq!(names(&out), vec!["photo.jpg"]);
        // Saved again over it (the dialog asked): replaced.
        files.append("p", "g", 0, b"new").unwrap();
        files.copy_to("p", "g", &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert_eq!(names(&out), vec!["photo.jpg"]);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_copy_that_fails_partway_leaves_no_file_and_keeps_the_one_that_was_there() {
        let (_, dir) = store();
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("report.pdf");
        let failed = write_whole(&target, |to| {
            to.write_all(b"half of it")?;
            Err(std::io::Error::other("disk full"))
        });
        assert_eq!(failed, Err("disk full".to_string()));
        assert!(names(&dir).is_empty(), "{:?}", names(&dir));
        // A file already under that name is not cut short by a failed copy over it.
        fs::write(&target, b"the old report").unwrap();
        let failed = write_whole(&target, |to| {
            to.write_all(b"half")?;
            Err(std::io::Error::other("drive removed"))
        });
        assert!(failed.is_err());
        assert_eq!(fs::read(&target).unwrap(), b"the old report");
        assert_eq!(names(&dir), vec!["report.pdf"]);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn the_partial_copy_is_hidden_beside_the_target() {
        let partial = partial_path(Path::new("/home/me/Downloads/photo.jpg")).unwrap();
        assert_eq!(partial.parent(), Some(Path::new("/home/me/Downloads")));
        let name = partial.file_name().unwrap().to_string_lossy().into_owned();
        assert!(
            name.starts_with(".photo.jpg.") && name.ends_with(".part"),
            "{name}"
        );
        assert!(partial_path(Path::new("/")).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn a_saved_copy_is_quarantined() {
        let (files, dir) = store();
        files.append("p", "f", 0, b"@echo boo\r\n").unwrap();
        let target = dir.join("run me.cmd");
        files.copy_to("p", "f", &target).unwrap();
        let mut stream = target.clone().into_os_string();
        stream.push(":Zone.Identifier");
        assert_eq!(
            fs::read_to_string(PathBuf::from(stream)).unwrap(),
            "[ZoneTransfer]\r\nZoneId=3\r\n"
        );
        assert_eq!(fs::read(&target).unwrap(), b"@echo boo\r\n");
        fs::remove_dir_all(dir).ok();
    }
}
