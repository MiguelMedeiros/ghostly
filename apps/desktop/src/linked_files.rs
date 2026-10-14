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
//!   the SHA-256 of the app's reference in hex), and go with the profile's files (`file_bytes_remove_where`).
//!
//! Refusals are `"<code>: words"`, the codes the broker passes to the app (`cancelled`, `changed`, `gone`, `too-large`).

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
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

/// Where the links are: set once the app knows its data folder.
#[derive(Clone)]
pub struct LinkedFiles {
    base: PathBuf,
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
/// out, at most one more than `MAX_ENTRIES` (so a folder past it is known to be). A folder under it that cannot be read
/// (`lost+found` at a drive's root, one gone while walking) is left out too; only the picked folder itself must be.
pub fn walk(root: &Path, accept: &[String]) -> Result<Vec<(String, PathBuf)>, String> {
    let top = root
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("A folder with no name")?
        .to_string();
    let mut found = Vec::new();
    let mut stack = vec![(top, root.to_path_buf())];
    while let Some((shown, dir)) = stack.pop() {
        let listed = match fs::read_dir(&dir) {
            Ok(listed) => listed,
            Err(e) if dir == root => return Err(e.to_string()),
            Err(_) => continue,
        };
        let mut entries: Vec<_> = listed.filter_map(Result::ok).collect();
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
        Self { base }
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

    fn load(&self, space: &str, app: &str) -> Result<Vec<Link>, String> {
        match fs::read(self.file(space, app)?) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(e.to_string()),
        }
    }

    fn store(&self, space: &str, app: &str, links: &[Link]) -> Result<(), String> {
        let file = self.file(space, app)?;
        if links.is_empty() {
            return match fs::remove_file(&file) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
                _ => Ok(()),
            };
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
        fs::rename(&staged, &file).map_err(|e| e.to_string())
    }

    /// Keeps links to what was picked, and answers them as the app sees them.
    pub fn add(
        &self,
        space: &str,
        app: &str,
        picked: Vec<(String, PathBuf)>,
    ) -> Result<Vec<Entry>, String> {
        let mut links = self.load(space, app)?;
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
        self.store(space, app, &links)?;
        Ok(added)
    }

    /// Every link the app keeps; `available` says whether its file is there as it was.
    pub fn list(&self, space: &str, app: &str) -> Result<Vec<Entry>, String> {
        Ok(self
            .load(space, app)?
            .into_iter()
            .map(|link| {
                let available = fs::metadata(&link.full)
                    .is_ok_and(|meta| stamp(&meta) == (link.size, link.modified));
                Entry {
                    id: link.id,
                    path: link.path,
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
        let link = self
            .load(space, app)?
            .into_iter()
            .find(|l| l.id == id)
            .ok_or("gone: No such file")?;
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

    /// Drops one link, or all of the app's with "all". The file itself is never touched.
    pub fn forget(&self, space: &str, app: &str, id: &str) -> Result<(), String> {
        let links = if id == "all" {
            Vec::new()
        } else {
            let mut links = self.load(space, app)?;
            links.retain(|l| l.id != id);
            links
        };
        self.store(space, app, &links)
    }

    /// A deleted profile's links, all of them.
    pub fn drop_space(&self, space: &str) -> Result<(), String> {
        check_space(space)?;
        match fs::remove_dir_all(self.base.join(space)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }
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
    #[cfg(target_os = "android")]
    {
        let _ = (links, title, folder);
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
            links.add(&space, &app_ref, picked)
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

    #[cfg(unix)]
    #[test]
    fn a_folder_that_cannot_be_read_is_left_out_but_the_picked_one_must_be_read() {
        use std::os::unix::fs::PermissionsExt;
        let root = films();
        let private = root.join("private");
        fs::create_dir_all(&private).unwrap();
        fs::write(private.join("hidden.mp4"), b"x").unwrap();
        fs::set_permissions(&private, fs::Permissions::from_mode(0o000)).unwrap();
        // Root reads every folder: nothing to check there.
        if fs::read_dir(&private).is_err() {
            let found: Vec<String> = walk(&root, &["mp4".to_string()])
                .unwrap()
                .into_iter()
                .map(|(p, _)| p)
                .collect();
            assert_eq!(found, ["Films/Season 1/E01.mp4", "Films/Up.mp4"]);
            assert!(walk(&private, &[]).is_err());
        }
        fs::set_permissions(&private, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn links_are_kept_per_profile_and_app_and_read_in_ranges() {
        let links = LinkedFiles::new(folder());
        let root = films();
        let added = links
            .add("ghostly", APP, walk(&root, &["mp4".to_string()]).unwrap())
            .unwrap();
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
        assert_eq!(links.list("ghostly", APP).unwrap().len(), 2);
    }

    #[test]
    fn a_file_that_changed_or_went_says_so() {
        let links = LinkedFiles::new(folder());
        let root = films();
        let added = links
            .add("ghostly", APP, walk(&root, &["mp4".to_string()]).unwrap())
            .unwrap();
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
        let added = links
            .add("ghostly", APP, walk(&root, &[]).unwrap())
            .unwrap();
        links.forget("ghostly", APP, &added[0].id).unwrap();
        assert_eq!(links.list("ghostly", APP).unwrap().len(), added.len() - 1);
        links.forget("ghostly", APP, "all").unwrap();
        assert!(links.list("ghostly", APP).unwrap().is_empty());
        links
            .add("ghostly", APP, walk(&root, &[]).unwrap())
            .unwrap();
        links.drop_space("ghostly").unwrap();
        assert!(links.list("ghostly", APP).unwrap().is_empty());
        // The files themselves are never touched.
        assert!(root.join("Up.mp4").exists());
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
        assert!(links
            .add("ghostly", APP, many)
            .unwrap_err()
            .starts_with("too-large: "));
    }
}
