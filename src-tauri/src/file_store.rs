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

/// Where the files are: set once the app knows its data folder.
pub struct FileStore {
    base: PathBuf,
}

impl FileStore {
    pub fn new(base: PathBuf) -> Self {
        Self { base }
    }

    fn folder(&self, space: &str) -> Result<PathBuf, String> {
        if space.is_empty()
            || space.len() > 100
            || space.starts_with('.')
            || !space
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        {
            return Err("Invalid profile space".into());
        }
        Ok(self.base.join(space))
    }

    fn path(&self, space: &str, id: &str) -> Result<PathBuf, String> {
        Ok(self.folder(space)?.join(check_id(id)?))
    }

    /// Writes `bytes` at `offset`, which must be the file's length: files grow in order only.
    pub fn append(&self, space: &str, id: &str, offset: u64, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() as u64 > MAX_STEP {
            return Err("Too much at once".into());
        }
        let path = self.path(space, id)?;
        fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
        let length = file.metadata().map_err(|e| e.to_string())?.len();
        if length != offset {
            return Err("File write out of order".into());
        }
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())
    }

    /// What was written so far survives a crash.
    pub fn flush(&self, space: &str, id: &str) -> Result<(), String> {
        match File::open(self.path(space, id)?) {
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

    /// Free bytes on the disk that holds the files.
    pub fn room(&self) -> Result<u64, String> {
        let mut dir = self.base.as_path();
        // The folder may not exist yet: the first one up that does is on the same disk.
        while !dir.exists() {
            dir = dir.parent().ok_or("No data folder")?;
        }
        fs4::available_space(dir).map_err(|e| e.to_string())
    }

    /// Copies a stored file to `target`, a step at a time.
    pub fn copy_to(&self, space: &str, id: &str, target: &Path) -> Result<(), String> {
        let mut from = File::open(self.path(space, id)?).map_err(|e| e.to_string())?;
        let mut to = File::create(target).map_err(|e| e.to_string())?;
        std::io::copy(&mut from, &mut to).map_err(|e| e.to_string())?;
        to.sync_all().map_err(|e| e.to_string())
    }
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

/// A suggested name for the save dialog: what the chat shows, without anything that reads as a path.
fn suggested_name(name: &str) -> String {
    let clean: String = name
        .chars()
        .filter(|c| !c.is_control() && !invisible(*c) && !matches!(c, '/' | '\\' | ':'))
        .take(200)
        .collect();
    let clean = clean.trim().trim_start_matches('.').to_string();
    if clean.is_empty() {
        "file".into()
    } else {
        clean
    }
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
    store(&app)?.remove_where(&space, &prefix)
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
    // covers: files.storage
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
        fs::remove_dir_all(dir).ok();
    }
}
