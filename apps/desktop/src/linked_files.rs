//! Linked files (WISP 1200 · Linked files) on Desktop: files and folders the person picks for an app in the system's
//! own dialog, kept as links (their paths), never copied, per profile and per app, and read in ranges here.
//!
//! - The app's broker (in the Ghostly window) asks; only the Ghostly window may call these commands, and an app window
//!   never names a path: it reads by the ids given here.
//! - A folder brings everything under it except hidden files and folders (a name starting with "."); symbolic links
//!   are not followed. `accept`, when it names extensions, keeps only those.
//! - A link remembers the size and date its file had when picked: a file that changed since reads as `changed`, one
//!   that went as `gone`, until it is picked again.
//! - Links live in `linked/<space>/<app>.json` in the app's data folder (`space` is the page's database name, `<app>`
//!   the SHA-256 of the app's reference in hex), and go with the profile's files (`file_bytes_remove_where`). Each
//!   file is read once and kept in memory, so a read costs the read and not the size of the library.
//! - A forget is one line appended to `<app>.forgotten` beside it (the link's id), not the whole file written again:
//!   with 100,000 links that was 27 MB a forget. The file is written whole again only once the forgotten lines are as
//!   many as the links left (and at least `COMPACT_AFTER`), so forgetting costs a few hundred bytes a link on average.
//!
//! Refusals are `"<code>: words"`, the codes the broker passes to the app (`cancelled`, `changed`, `gone`, `too-large`).

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::UNIX_EPOCH;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::rngs::SysRng;
use rand::TryRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::ipc::Response;

use crate::file_store::check_space;

/// The links one app keeps, at most (`MINI_APP_LIMITS.filesEntries`).
pub const MAX_ENTRIES: usize = 100_000;
/// One read, at most (`MINI_APP_LIMITS.filesReadBytes`).
pub const MAX_READ: u64 = 1024 * 1024;
/// Extensions a pick may name (`MINI_APP_LIMITS.filesAccept`).
const MAX_ACCEPT: usize = 32;
/// Apps whose links are kept in memory, at most: past it, one is let go and read from disk again when asked.
const MAX_BOOKS: usize = 16;
/// Forgotten lines an app's links file takes before it is written whole again without them, at least.
const COMPACT_AFTER: usize = 1_000;
/// A link's id: 16 random bytes in base64url (`random_id`).
const ID_CHARS: usize = 22;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct Link {
    id: String,
    /// What the app sees: relative to what was picked, the picked folder's name first.
    path: String,
    /// Where it is on this device: never told to the app.
    full: PathBuf,
    size: u64,
    /// Milliseconds since 1970.
    modified: u64,
}

/// A link as the app sees it (`MiniAppLinkedFile`).
#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct Entry {
    pub id: String,
    pub path: String,
    pub size: u64,
    pub modified: u64,
    pub available: bool,
}

/// One app's links, in the order they were picked, and where each id is among them. A forgotten link leaves a hole
/// (`None`) until the file is written whole again (`LinkedFiles::compact`); `gone` counts the forgotten lines on disk.
#[derive(Default, Clone)]
struct Book {
    links: Vec<Option<Link>>,
    by_id: HashMap<String, usize>,
    gone: usize,
}

impl Book {
    fn new(links: Vec<Link>) -> Self {
        let by_id = links
            .iter()
            .enumerate()
            .map(|(at, link)| (link.id.clone(), at))
            .collect();
        Self {
            links: links.into_iter().map(Some).collect(),
            by_id,
            gone: 0,
        }
    }

    fn get(&self, id: &str) -> Option<&Link> {
        self.by_id.get(id).and_then(|&at| self.links[at].as_ref())
    }

    fn live(&self) -> impl Iterator<Item = &Link> {
        self.links.iter().flatten()
    }

    /// Takes a link out, leaving its hole. False when there is none with that id.
    fn drop_link(&mut self, id: &str) -> bool {
        let Some(at) = self.by_id.remove(id) else {
            return false;
        };
        self.links[at] = None;
        self.gone += 1;
        true
    }

    /// Whether the forgotten lines are worth writing the file whole again for.
    fn wants_compacting(&self) -> bool {
        self.gone >= COMPACT_AFTER.max(self.by_id.len())
    }
}

/// The ids a `.forgotten` file names: one a line; a line that is not a whole id (cut off by a crash) is not one.
fn forgotten_ids(text: &str) -> impl Iterator<Item = &str> {
    text.lines().filter(|line| {
        line.len() == ID_CHARS
            && line
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    })
}

/// Where the links are: set once the app knows its data folder.
#[derive(Clone)]
pub struct LinkedFiles {
    base: PathBuf,
    /// Each app's links as on disk, by their file: read once, then kept in step with every change.
    books: Arc<Mutex<HashMap<PathBuf, Arc<Book>>>>,
    /// Changes go one at a time (read, change, write), so two picks never lose each other's links.
    writing: Arc<Mutex<()>>,
    /// How many times each app's links file and each profile's folder had all its links go (`forget` "all" on an
    /// uninstall, `drop_space` on a deleted profile): a pick reads it before its dialog opens, and keeps nothing if it
    /// moved meanwhile.
    cleared: Arc<Mutex<HashMap<PathBuf, u64>>>,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// An app's reference: a z-base32 key of 52 characters, a slash, a name.
fn check_app(app: &str) -> Result<(), String> {
    let Some((key, name)) = app.split_once('/') else {
        return Err("Invalid app".into());
    };
    let name_ok = name.len() <= 32
        && name.chars().next().is_some_and(|c| c.is_ascii_lowercase())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if key.len() != 52
        || !key
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        || !name_ok
    {
        return Err("Invalid app".into());
    }
    Ok(())
}

/// Extensions as a pick names them: 1 to 16 characters of `a-z` and `0-9`, at most `MAX_ACCEPT`.
fn check_accept(accept: &[String]) -> Result<(), String> {
    if accept.len() > MAX_ACCEPT
        || !accept.iter().all(|e| {
            !e.is_empty()
                && e.len() <= 16
                && e.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        })
    {
        return Err("Invalid extensions".into());
    }
    Ok(())
}

/// A file's size and date (ms), as a link remembers them.
fn stamp(meta: &fs::Metadata) -> (u64, u64) {
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64);
    (meta.len(), modified)
}

fn random_id() -> Result<String, String> {
    let mut raw = [0u8; 16];
    SysRng.try_fill_bytes(&mut raw).map_err(|e| e.to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(raw))
}

fn hidden(name: &str) -> bool {
    name.starts_with('.')
}

fn accepted(name: &str, accept: &[String]) -> bool {
    if accept.is_empty() {
        return true;
    }
    let extension = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    extension.is_some_and(|e| accept.contains(&e))
}

/// Everything under a folder that `accept` names, its name first in each path: hidden entries and symbolic links left
/// out, at most one more than `MAX_ENTRIES` (so a folder past it is known to be).
pub fn walk(root: &Path, accept: &[String]) -> Result<Vec<(String, PathBuf)>, String> {
    let top = root
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("A folder with no name")?
        .to_string();
    let mut found = Vec::new();
    let mut stack = vec![(top, root.to_path_buf())];
    while let Some((shown, dir)) = stack.pop() {
        let mut entries: Vec<_> = fs::read_dir(&dir)
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if hidden(&name) {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let at = format!("{shown}/{name}");
            if kind.is_dir() {
                stack.push((at, entry.path()));
            } else if kind.is_file() && accepted(&name, accept) {
                found.push((at, entry.path()));
                if found.len() > MAX_ENTRIES {
                    return Ok(found);
                }
            }
        }
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(found)
}

/// Files picked one by one: their names, the hidden ones and what `accept` does not name left out.
pub fn picked_files(files: Vec<PathBuf>, accept: &[String]) -> Vec<(String, PathBuf)> {
    files
        .into_iter()
        .filter_map(|path| {
            let name = path.file_name()?.to_str()?.to_string();
            (!hidden(&name) && accepted(&name, accept)).then_some((name, path))
        })
        .collect()
}

impl LinkedFiles {
    pub fn new(base: PathBuf) -> Self {
        Self {
            base,
            books: Arc::default(),
            writing: Arc::default(),
            cleared: Arc::default(),
        }
    }

    fn file(&self, space: &str, app: &str) -> Result<PathBuf, String> {
        check_space(space)?;
        check_app(app)?;
        let name: String = Sha256::digest(app.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        Ok(self.base.join(space).join(format!("{name}.json")))
    }

    /// The app's links: from memory, or from disk the first time (the links file, less what its `.forgotten` names).
    /// Read while the books are held, so a change written meanwhile is never overtaken by what was on disk before it.
    fn load(&self, space: &str, app: &str) -> Result<Arc<Book>, String> {
        let file = self.file(space, app)?;
        let mut books = locked(&self.books);
        if let Some(book) = books.get(&file) {
            return Ok(book.clone());
        }
        let links = match fs::read(&file) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string())?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.to_string()),
        };
        let mut book = Book::new(links);
        match fs::read_to_string(forgotten_file(&file)) {
            Ok(text) => {
                for id in forgotten_ids(&text) {
                    book.drop_link(id);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
        let book = Arc::new(book);
        keep(&mut books, file, book.clone());
        Ok(book)
    }

    /// Writes the app's links whole, with nothing forgotten beside them, then keeps them in memory. Called with
    /// `writing` held.
    fn store(&self, space: &str, app: &str, links: Vec<Link>) -> Result<(), String> {
        let file = self.file(space, app)?;
        self.write(&file, &links)?;
        keep(&mut locked(&self.books), file, Arc::new(Book::new(links)));
        Ok(())
    }

    fn write(&self, file: &Path, links: &[Link]) -> Result<(), String> {
        // After the links file is in place: a crash between the two leaves forgotten lines that name nothing in it.
        let forgotten = || match fs::remove_file(forgotten_file(file)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        };
        if links.is_empty() {
            match fs::remove_file(file) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
                _ => {}
            }
            return forgotten();
        }
        let folder = file.parent().ok_or("No folder")?;
        fs::create_dir_all(folder).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&self.base, fs::Permissions::from_mode(0o700));
        }
        let staged = file.with_extension("json.part");
        fs::write(
            &staged,
            serde_json::to_vec(links).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        fs::rename(&staged, file).map_err(|e| e.to_string())?;
        forgotten()
    }

    /// Read when a pick begins, before its dialog opens, and given back to `add`.
    pub fn begin(&self, space: &str, app: &str) -> Result<u64, String> {
        let file = self.file(space, app)?;
        let folder = file.parent().ok_or("No folder")?;
        let cleared = locked(&self.cleared);
        let times = |at: &Path| cleared.get(at).copied().unwrap_or(0);
        Ok(times(&file) + times(folder))
    }

    /// Counted with `writing` held, so a pick's `add` sees it or comes before it.
    fn clear(&self, at: PathBuf) {
        *locked(&self.cleared).entry(at).or_default() += 1;
    }

    /// Keeps links to what was picked, and answers them as the app sees them: nothing if the app's links all went or
    /// its profile did since the pick began (`begin`), so an app uninstalled while its dialog was open keeps none.
    pub fn add(
        &self,
        space: &str,
        app: &str,
        begun: u64,
        picked: Vec<(String, PathBuf)>,
    ) -> Result<Vec<Entry>, String> {
        let _writing = locked(&self.writing);
        if self.begin(space, app)? != begun {
            return Err("cancelled: The app's files were let go while it picked".into());
        }
        let mut links: Vec<Link> = self.load(space, app)?.live().cloned().collect();
        if links.len() + picked.len() > MAX_ENTRIES {
            return Err("too-large: Too many files for one app".into());
        }
        let mut added = Vec::with_capacity(picked.len());
        for (path, full) in picked {
            let Ok(meta) = fs::metadata(&full) else {
                continue;
            };
            let (size, modified) = stamp(&meta);
            let link = Link {
                id: random_id()?,
                path,
                full,
                size,
                modified,
            };
            added.push(Entry {
                id: link.id.clone(),
                path: link.path.clone(),
                size,
                modified,
                available: true,
            });
            links.push(link);
        }
        self.store(space, app, links)?;
        Ok(added)
    }

    /// Every link the app keeps; `available` says whether its file is there as it was.
    pub fn list(&self, space: &str, app: &str) -> Result<Vec<Entry>, String> {
        Ok(self
            .load(space, app)?
            .live()
            .map(|link| {
                let available = fs::metadata(&link.full)
                    .is_ok_and(|meta| stamp(&meta) == (link.size, link.modified));
                Entry {
                    id: link.id.clone(),
                    path: link.path.clone(),
                    size: link.size,
                    modified: link.modified,
                    available,
                }
            })
            .collect())
    }

    /// At most `length` bytes (and `MAX_READ`) from `offset`: fewer at the end of the file.
    pub fn read(
        &self,
        space: &str,
        app: &str,
        id: &str,
        offset: u64,
        length: u64,
    ) -> Result<Vec<u8>, String> {
        let book = self.load(space, app)?;
        let link = book.get(id).ok_or("gone: No such file")?;
        let meta = fs::metadata(&link.full).map_err(|_| "gone: The file is no longer there")?;
        if stamp(&meta) != (link.size, link.modified) {
            return Err("changed: The file changed since it was picked".into());
        }
        if offset >= link.size {
            return Ok(Vec::new());
        }
        let length = length.min(MAX_READ).min(link.size - offset);
        let mut file = fs::File::open(&link.full).map_err(|_| "gone: The file cannot be read")?;
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        let mut bytes = Vec::with_capacity(length as usize);
        file.take(length)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        Ok(bytes)
    }

    /// Drops one link, or all of the app's with "all". The file itself is never touched. One link costs a line
    /// appended to the app's `.forgotten`, whatever the size of its library (`COMPACT_AFTER`).
    pub fn forget(&self, space: &str, app: &str, id: &str) -> Result<(), String> {
        let _writing = locked(&self.writing);
        if id == "all" {
            self.clear(self.file(space, app)?);
            return self.store(space, app, Vec::new());
        }
        if self.load(space, app)?.get(id).is_none() {
            return Ok(());
        }
        let file = self.file(space, app)?;
        {
            use std::io::Write;
            let mut journal = fs::OpenOptions::new()
                .create(true)
                .read(true)
                .append(true)
                .open(forgotten_file(&file))
                .map_err(|e| e.to_string())?;
            // A line cut off by a crash leaves the file without its line feed: this one starts a line of its own, or it
            // would be glued onto that one and name nothing after the next start.
            let mut last = *b"\n";
            if journal.seek(SeekFrom::End(0)).map_err(|e| e.to_string())? > 0 {
                journal.seek(SeekFrom::End(-1)).map_err(|e| e.to_string())?;
                journal.read_exact(&mut last).map_err(|e| e.to_string())?;
            }
            let line = if last[0] == b'\n' {
                format!("{id}\n")
            } else {
                format!("\n{id}\n")
            };
            journal
                .write_all(line.as_bytes())
                .map_err(|e| e.to_string())?;
        }
        let mut books = locked(&self.books);
        let Some(book) = books.get_mut(&file) else {
            // Let go meanwhile (another app's links came in): the next load reads the line just written.
            return Ok(());
        };
        // In place, unless a list holds the links right now: then it keeps its copy.
        let book = Arc::make_mut(book);
        book.drop_link(id);
        if !book.wants_compacting() {
            return Ok(());
        }
        let links: Vec<Link> = book.live().cloned().collect();
        drop(books);
        self.store(space, app, links)
    }

    /// A deleted profile's links, all of them.
    pub fn drop_space(&self, space: &str) -> Result<(), String> {
        check_space(space)?;
        let _writing = locked(&self.writing);
        let folder = self.base.join(space);
        self.clear(folder.clone());
        let removed = fs::remove_dir_all(&folder);
        // After the files went: a read meanwhile finds them gone, not kept in memory.
        locked(&self.books).retain(|file, _| !file.starts_with(&folder));
        match removed {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }
}

/// The ids forgotten since an app's links file was last written whole: `<app>.forgotten` beside `<app>.json`.
fn forgotten_file(file: &Path) -> PathBuf {
    file.with_extension("forgotten")
}

/// Keeps an app's links in memory, letting another app's go past `MAX_BOOKS`.
fn keep(books: &mut HashMap<PathBuf, Arc<Book>>, file: PathBuf, book: Arc<Book>) {
    if books.len() >= MAX_BOOKS && !books.contains_key(&file) {
        if let Some(other) = books.keys().next().cloned() {
            books.remove(&other);
        }
    }
    books.insert(file, book);
}

fn state<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<LinkedFiles, String> {
    use tauri::Manager;
    app.try_state::<LinkedFiles>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| "Linked files unavailable".into())
}

/// Asks the person in the system's dialog, titled by the client ("Cinema asks to read a folder"), and keeps links to
/// what was picked.
#[tauri::command]
pub async fn linked_files_pick<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    space: String,
    app_ref: String,
    title: String,
    folder: bool,
    accept: Vec<String>,
) -> Result<Vec<Entry>, String> {
    let links = state(&app)?;
    check_space(&space)?;
    check_app(&app_ref)?;
    check_accept(&accept)?;
    let begun = links.begin(&space, &app_ref)?;
    #[cfg(target_os = "android")]
    {
        let _ = (links, begun, title, folder);
        Err("Apps cannot pick files on Android".into())
    }
    #[cfg(not(target_os = "android"))]
    {
        use tauri_plugin_dialog::DialogExt;
        let mut dialog = app
            .dialog()
            .file()
            .set_title(title.chars().take(200).collect::<String>());
        if !folder && !accept.is_empty() {
            let extensions: Vec<&str> = accept.iter().map(String::as_str).collect();
            dialog = dialog.add_filter("", &extensions);
        }
        let chosen = tauri::async_runtime::spawn_blocking(move || {
            if folder {
                dialog.blocking_pick_folder().map(|path| vec![path])
            } else {
                dialog.blocking_pick_files()
            }
        })
        .await
        .map_err(|e| e.to_string())?;
        let Some(chosen) = chosen else {
            return Err("cancelled: Nothing was picked".into());
        };
        let paths = chosen
            .into_iter()
            .map(|p| p.into_path().map_err(|e| e.to_string()))
            .collect::<Result<Vec<_>, _>>()?;
        tauri::async_runtime::spawn_blocking(move || {
            let picked = if folder {
                let root = paths.first().ok_or("cancelled: Nothing was picked")?;
                walk(root, &accept)?
            } else {
                picked_files(paths, &accept)
            };
            links.add(&space, &app_ref, begun, picked)
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

#[tauri::command]
pub async fn linked_files_list<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    space: String,
    app_ref: String,
) -> Result<Vec<Entry>, String> {
    let links = state(&app)?;
    tauri::async_runtime::spawn_blocking(move || links.list(&space, &app_ref))
        .await
        .map_err(|e| e.to_string())?
}

/// The bytes as they are: no JSON, no base64 on the way to the Ghostly window.
#[tauri::command]
pub async fn linked_files_read<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    space: String,
    app_ref: String,
    id: String,
    offset: u64,
    length: u64,
) -> Result<Response, String> {
    let links = state(&app)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        links.read(&space, &app_ref, &id, offset, length)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn linked_files_forget<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    space: String,
    app_ref: String,
    id: String,
) -> Result<(), String> {
    let links = state(&app)?;
    tauri::async_runtime::spawn_blocking(move || links.forget(&space, &app_ref, &id))
        .await
        .map_err(|e| e.to_string())?
}

/// What a deleted profile's files take with them (`file_bytes_remove_where`).
pub fn drop_space<R: tauri::Runtime>(app: &tauri::AppHandle<R>, space: &str) {
    if let Ok(links) = state(app) {
        let _ = links.drop_space(space);
    }
}

#[cfg(test)]
mod tests {
    // covers: apps.linked-files
    use super::*;

    const APP: &str = "ybndrfg8ejkmcpqxot1uwisza345h769ybndrfg8ejkmcpqxot1u/cinema";

    fn folder() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "ghostly-linked-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A pick begun and landed at once.
    fn pick(links: &LinkedFiles, picked: Vec<(String, PathBuf)>) -> Result<Vec<Entry>, String> {
        links.add("ghostly", APP, links.begin("ghostly", APP)?, picked)
    }

    fn films() -> PathBuf {
        let root = folder().join("Films");
        fs::create_dir_all(root.join("Season 1")).unwrap();
        fs::create_dir_all(root.join(".trash")).unwrap();
        fs::write(root.join("Up.mp4"), b"0123456789").unwrap();
        fs::write(root.join("Up.srt"), b"1").unwrap();
        fs::write(root.join("notes.txt"), b"x").unwrap();
        fs::write(root.join(".DS_Store"), b"x").unwrap();
        fs::write(root.join(".trash").join("old.mp4"), b"x").unwrap();
        fs::write(root.join("Season 1").join("E01.mp4"), b"abc").unwrap();
        root
    }

    #[test]
    fn a_folder_brings_what_it_holds_but_hidden_entries_and_what_accept_leaves_out() {
        let root = films();
        let accept = vec!["mp4".to_string(), "srt".to_string()];
        let found: Vec<String> = walk(&root, &accept)
            .unwrap()
            .into_iter()
            .map(|(p, _)| p)
            .collect();
        assert_eq!(
            found,
            ["Films/Season 1/E01.mp4", "Films/Up.mp4", "Films/Up.srt"]
        );
        assert_eq!(walk(&root, &[]).unwrap().len(), 4);
        let files = picked_files(
            vec![
                root.join("Up.mp4"),
                root.join(".DS_Store"),
                root.join("notes.txt"),
            ],
            &["mp4".to_string()],
        );
        assert_eq!(
            files.iter().map(|(p, _)| p.as_str()).collect::<Vec<_>>(),
            ["Up.mp4"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn symbolic_links_are_not_followed() {
        let root = films();
        let outside = folder();
        fs::write(outside.join("secret.mp4"), b"x").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("elsewhere")).unwrap();
        std::os::unix::fs::symlink(outside.join("secret.mp4"), root.join("link.mp4")).unwrap();
        assert!(walk(&root, &[])
            .unwrap()
            .iter()
            .all(|(p, _)| !p.contains("elsewhere") && !p.contains("link.mp4")));
    }

    #[test]
    fn links_are_kept_per_profile_and_app_and_read_in_ranges() {
        let links = LinkedFiles::new(folder());
        let root = films();
        let added = pick(&links, walk(&root, &["mp4".to_string()]).unwrap()).unwrap();
        assert_eq!(added.len(), 2);
        assert!(added.iter().all(|e| e.id.len() == 22 && e.available));
        let up = added.iter().find(|e| e.path == "Films/Up.mp4").unwrap();
        assert_eq!(links.read("ghostly", APP, &up.id, 2, 3).unwrap(), b"234");
        assert_eq!(links.read("ghostly", APP, &up.id, 8, 100).unwrap(), b"89");
        assert!(links
            .read("ghostly", APP, &up.id, 10, 5)
            .unwrap()
            .is_empty());
        // Another profile, another app: nothing.
        assert!(links.list("ghostly_other", APP).unwrap().is_empty());
        let other = APP.replace("/cinema", "/chess");
        assert!(links.list("ghostly", &other).unwrap().is_empty());
        assert!(links
            .read("ghostly", &other, &up.id, 0, 1)
            .unwrap_err()
            .starts_with("gone: "));
        // Kept on disk: a new start reads them.
        let base = links.base.clone();
        assert_eq!(
            LinkedFiles::new(base).list("ghostly", APP).unwrap().len(),
            2
        );
    }

    #[test]
    fn the_links_file_is_read_once_not_on_every_read() {
        let links = LinkedFiles::new(folder());
        let root = films();
        let added = pick(&links, walk(&root, &["mp4".to_string()]).unwrap()).unwrap();
        let file = links.file("ghostly", APP).unwrap();
        assert!(file.exists());
        // What is on disk is not read again: reads, the list and a forget go by what is kept in memory.
        fs::write(&file, b"not json").unwrap();
        assert_eq!(
            links.read("ghostly", APP, &added[1].id, 0, 2).unwrap(),
            b"01"
        );
        assert_eq!(links.list("ghostly", APP).unwrap().len(), 2);
        links.forget("ghostly", APP, &added[0].id).unwrap();
        assert_eq!(links.list("ghostly", APP).unwrap().len(), 1);
        // A forget does not write the links file again: it is still what was put there.
        assert_eq!(fs::read(&file).unwrap(), b"not json");
    }

    /// `n` links, all to one small file: what a library of `n` files costs here, without making them.
    fn library(links: &LinkedFiles, n: usize) -> Vec<Entry> {
        let file = folder().join("film.mp4");
        fs::write(&file, b"0123456789").unwrap();
        let picked = (0..n)
            .map(|i| (format!("Films/{i:06}.mp4"), file.clone()))
            .collect();
        pick(links, picked).unwrap()
    }

    // A forget wrote the app's whole links file again: 27 MB and 47 ms a forget with 100,000 links (agents#1033).
    #[test]
    fn a_forget_appends_one_line_whatever_the_size_of_the_library() {
        let links = LinkedFiles::new(folder());
        let added = library(&links, 3_000);
        let file = links.file("ghostly", APP).unwrap();
        let journal = forgotten_file(&file);
        let before = fs::read(&file).unwrap();
        links.forget("ghostly", APP, &added[7].id).unwrap();
        links.forget("ghostly", APP, &added[7].id).unwrap();
        links
            .forget("ghostly", APP, "AAAAAAAAAAAAAAAAAAAAAA")
            .unwrap();
        assert_eq!(
            fs::read(&file).unwrap(),
            before,
            "the links file is not written again"
        );
        assert_eq!(
            fs::read_to_string(&journal).unwrap(),
            format!("{}\n", added[7].id),
            "one line, once"
        );
        assert_eq!(links.list("ghostly", APP).unwrap().len(), 2_999);
        assert!(links
            .read("ghostly", APP, &added[7].id, 0, 1)
            .unwrap_err()
            .starts_with("gone: "));
        // A new start reads the links less what was forgotten.
        let again = LinkedFiles::new(links.base.clone());
        let listed = again.list("ghostly", APP).unwrap();
        assert_eq!(listed.len(), 2_999);
        assert!(listed.iter().all(|e| e.id != added[7].id));
        assert_eq!(
            again.read("ghostly", APP, &added[8].id, 0, 2).unwrap(),
            b"01"
        );
    }

    #[test]
    fn once_as_many_are_forgotten_as_are_left_the_links_file_is_written_whole_again() {
        let links = LinkedFiles::new(folder());
        let added = library(&links, 3_000);
        let file = links.file("ghostly", APP).unwrap();
        let journal = forgotten_file(&file);
        for entry in &added[..1_499] {
            links.forget("ghostly", APP, &entry.id).unwrap();
        }
        assert_eq!(fs::read_to_string(&journal).unwrap().lines().count(), 1_499);
        links.forget("ghostly", APP, &added[1_499].id).unwrap();
        assert!(
            !journal.exists(),
            "written whole: nothing forgotten beside it"
        );
        let kept: Vec<Link> = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        assert_eq!(kept.len(), 1_500);
        assert_eq!(kept[0].id, added[1_500].id);
        let again = LinkedFiles::new(links.base.clone());
        assert_eq!(again.list("ghostly", APP).unwrap().len(), 1_500);
        // A pick writes the file whole too, the forgotten ones left out.
        links.forget("ghostly", APP, &added[1_500].id).unwrap();
        assert!(journal.exists());
        library(&links, 1);
        assert!(!journal.exists());
        assert_eq!(
            LinkedFiles::new(links.base.clone())
                .list("ghostly", APP)
                .unwrap()
                .len(),
            1_500
        );
        // Forgetting all removes both.
        links.forget("ghostly", APP, &added[1_501].id).unwrap();
        links.forget("ghostly", APP, "all").unwrap();
        assert!(!file.exists() && !journal.exists());
    }

    #[test]
    fn a_forgotten_line_cut_off_by_a_crash_names_nothing() {
        let links = LinkedFiles::new(folder());
        let added = library(&links, 3);
        links.forget("ghostly", APP, &added[0].id).unwrap();
        let journal = forgotten_file(&links.file("ghostly", APP).unwrap());
        let mut text = fs::read_to_string(&journal).unwrap();
        text.push_str(&added[1].id[..10]);
        fs::write(&journal, text).unwrap();
        let again = LinkedFiles::new(links.base.clone());
        let ids: Vec<String> = again
            .list("ghostly", APP)
            .unwrap()
            .into_iter()
            .map(|e| e.id)
            .collect();
        assert_eq!(ids, [added[1].id.clone(), added[2].id.clone()]);
        // The next forget is not glued onto the cut line: it holds after another start.
        again.forget("ghostly", APP, &added[2].id).unwrap();
        let ids: Vec<String> = LinkedFiles::new(links.base.clone())
            .list("ghostly", APP)
            .unwrap()
            .into_iter()
            .map(|e| e.id)
            .collect();
        assert_eq!(ids, [added[1].id.clone()]);
    }

    #[test]
    fn picks_at_the_same_time_keep_each_other_s_links() {
        let links = LinkedFiles::new(folder());
        let root = films();
        let picks: Vec<_> = (0..8)
            .map(|_| {
                let (links, root) = (links.clone(), root.clone());
                std::thread::spawn(move || pick(&links, walk(&root, &[]).unwrap()).unwrap())
            })
            .collect();
        let added: usize = picks.into_iter().map(|p| p.join().unwrap().len()).sum();
        assert_eq!(added, 8 * 4);
        let again = LinkedFiles::new(links.base.clone());
        assert_eq!(again.list("ghostly", APP).unwrap().len(), added);
    }

    #[test]
    fn a_file_that_changed_or_went_says_so() {
        let links = LinkedFiles::new(folder());
        let root = films();
        let added = pick(&links, walk(&root, &["mp4".to_string()]).unwrap()).unwrap();
        let (up, e01) = (&added[1], &added[0]);
        fs::write(root.join("Up.mp4"), b"01234567890").unwrap();
        assert!(links
            .read("ghostly", APP, &up.id, 0, 1)
            .unwrap_err()
            .starts_with("changed: "));
        fs::remove_file(root.join("Season 1").join("E01.mp4")).unwrap();
        assert!(links
            .read("ghostly", APP, &e01.id, 0, 1)
            .unwrap_err()
            .starts_with("gone: "));
        assert!(links
            .list("ghostly", APP)
            .unwrap()
            .iter()
            .all(|e| !e.available));
    }

    #[test]
    fn forget_drops_one_link_or_all_and_a_deleted_profile_drops_its_links() {
        let links = LinkedFiles::new(folder());
        let root = films();
        let added = pick(&links, walk(&root, &[]).unwrap()).unwrap();
        links.forget("ghostly", APP, &added[0].id).unwrap();
        assert_eq!(links.list("ghostly", APP).unwrap().len(), added.len() - 1);
        links.forget("ghostly", APP, "all").unwrap();
        assert!(links.list("ghostly", APP).unwrap().is_empty());
        pick(&links, walk(&root, &[]).unwrap()).unwrap();
        links.drop_space("ghostly").unwrap();
        assert!(links.list("ghostly", APP).unwrap().is_empty());
        // The files themselves are never touched.
        assert!(root.join("Up.mp4").exists());
    }

    // A pick left open while the app was uninstalled or its profile deleted kept its links on disk.
    #[test]
    fn a_pick_that_began_before_an_uninstall_or_a_deleted_profile_keeps_nothing() {
        let links = LinkedFiles::new(folder());
        let root = films();
        let other = APP.replace("/cinema", "/chess");
        pick(&links, walk(&root, &[]).unwrap()).unwrap();
        // The dialog is open, and the app is uninstalled: its links all go.
        let begun = links.begin("ghostly", APP).unwrap();
        let other_begun = links.begin("ghostly", &other).unwrap();
        links.forget("ghostly", APP, "all").unwrap();
        assert!(links
            .add("ghostly", APP, begun, walk(&root, &[]).unwrap())
            .unwrap_err()
            .starts_with("cancelled: "));
        assert!(links.list("ghostly", APP).unwrap().is_empty());
        assert!(LinkedFiles::new(links.base.clone())
            .list("ghostly", APP)
            .unwrap()
            .is_empty());
        // Another app's pick keeps its links, and so does a pick begun after (a reinstall picking again).
        assert_eq!(
            links
                .add("ghostly", &other, other_begun, walk(&root, &[]).unwrap())
                .unwrap()
                .len(),
            4
        );
        assert_eq!(pick(&links, walk(&root, &[]).unwrap()).unwrap().len(), 4);
        // The profile is deleted while a dialog is open: its folder is not made again.
        let begun = links.begin("ghostly", APP).unwrap();
        links.drop_space("ghostly").unwrap();
        assert!(links
            .add("ghostly", APP, begun, walk(&root, &[]).unwrap())
            .unwrap_err()
            .starts_with("cancelled: "));
        assert!(!links.base.join("ghostly").exists());
    }

    #[test]
    fn names_that_are_not_an_app_or_a_space_are_refused() {
        let links = LinkedFiles::new(folder());
        for app in [
            "../x",
            "cinema",
            "KEY/cinema",
            &format!("{}/Cinema", &APP[..52]),
            &format!("{}/../x", &APP[..52]),
        ] {
            assert!(links.list("ghostly", app).is_err(), "{app}");
        }
        assert!(links.list("../etc", APP).is_err());
        assert!(check_accept(&["mp4".into()]).is_ok());
        assert!(check_accept(&[".mp4".into()]).is_err());
        assert!(check_accept(&vec!["a".to_string(); MAX_ACCEPT + 1]).is_err());
    }

    #[test]
    fn past_the_limit_a_pick_is_refused() {
        let links = LinkedFiles::new(folder());
        let many: Vec<(String, PathBuf)> = (0..=MAX_ENTRIES)
            .map(|i| (format!("{i}.mp4"), PathBuf::from("/nowhere")))
            .collect();
        assert!(pick(&links, many).unwrap_err().starts_with("too-large: "));
    }
}
