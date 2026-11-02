//! What a contact's app kept in the webview's storage, forgotten with its chat, its profile's data or its profile.
//!
//! A contact's app runs on an origin of its own (`viewer`), named after the service, the contact and this profile's
//! chat with them, and it shares the Ghostly window's WebKit storage: its localStorage, IndexedDB and Cache Storage
//! land in folders named after that origin, so after the chat went they still held what the app kept, and their names
//! said which contact's app this device opened. The page asks for the origins it noted (`forget_service_origins`).
//!
//! On Linux each origin is cleared in two steps, as WebKitGTK allows: its website-data API lists nothing for a
//! `ghostly-svc` origin, and its network process keeps the origin's files open while the app runs, so removing them
//! erases nothing until the next launch.
//! - Now: a hidden window on the origin, served a cleaning page of the app's own (`serve`): the contact's app is never
//!   asked and none of its code runs there. The page empties every kind of storage the origin has and says so.
//! - At the next launch, before any window: the files still named after the origin are removed (`clean_at_launch`).
//!   Until then the origin is on a list in the app's data folder; it leaves the list once its files are gone, and the
//!   list goes once empty, since it too names contacts.
//!
//! macOS (`WKWebsiteDataStore`) and Windows (WebView2) clear nothing yet: every origin is answered as not cleared,
//! so the page keeps it on its list for when they do.

use serde::Deserialize;
use tauri::{AppHandle, Runtime};

use crate::viewer::{self, is_label_safe, is_tag};

/// One origin to forget, as the page noted it when it opened the app (`viewer::open` takes the same three).
#[derive(Debug, Deserialize)]
pub struct ServiceOrigin {
    service: String,
    peer: String,
    tag: String,
}

impl ServiceOrigin {
    /// The origin's host, `<service>.<peer>.<tag>`; none for an origin `viewer::open` would never have opened.
    fn host(&self) -> Option<String> {
        (is_label_safe(&self.service) && is_label_safe(&self.peer) && is_tag(&self.tag))
            .then(|| format!("{}.{}.{}", self.service, self.peer, self.tag))
    }
}

/// Forgets what the apps on `origins` kept: their windows close, then each origin is cleared (Linux). Answers, for
/// each, whether it was cleared; one that was not stays on the page's list, for its next clear.
#[tauri::command]
pub async fn forget_service_origins<R: Runtime>(
    app: AppHandle<R>,
    origins: Vec<ServiceOrigin>,
) -> Result<Vec<bool>, String> {
    let hosts = origins
        .iter()
        .map(ServiceOrigin::host)
        .collect::<Option<Vec<_>>>()
        .ok_or("Invalid service")?;
    // A window still showing the app would go on writing there.
    viewer::close_showing(&app, &hosts);
    #[cfg(target_os = "linux")]
    {
        use tauri::Manager;
        let list = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join(linux::LIST_FILE);
        let mut cleared = Vec::with_capacity(hosts.len());
        for host in &hosts {
            cleared.push(linux::clear_in_window(&app, &list, host).await);
        }
        Ok(cleared)
    }
    // Follow-ups: macOS removes the origin's records from `WKWebsiteDataStore`, Windows through WebView2. Until then
    // nothing is cleared, and the page keeps each origin for later.
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        Ok(vec![false; hosts.len()])
    }
}

#[cfg(target_os = "linux")]
pub use linux::{clean_at_launch, serve, ForgetState};

#[cfg(target_os = "linux")]
mod linux {
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Mutex;
    use std::time::Duration;

    use serde::{Deserialize, Serialize};
    use tauri::http::{Request, Response, StatusCode};
    use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
    use tokio::sync::oneshot;

    use crate::viewer::SCHEME;

    /// The origins whose files wait for the next launch, in the app's data folder.
    pub const LIST_FILE: &str = "forgotten-origins.json";
    /// The hidden windows' labels: never `svc-*`, so no request of theirs reaches a contact.
    const LABEL_PREFIX: &str = "forget-";
    /// How long one origin's window may take to load and clear it before the rest goes on without it.
    const CLEAR_TIMEOUT: Duration = Duration::from_secs(10);
    /// The path the cleaning page reports to once it cleared.
    const CLEARED_PATH: &str = "/cleared";

    /// The page a hidden window gets on the origin to forget, from the app and never from the contact: every kind of
    /// storage the origin may hold, each on its own (one WebKit refuses keeps none of the others), then the report.
    /// An IndexedDB database a page of the app still holds goes once that page closes (its window was just closed).
    const CLEANING_PAGE: &str = r#"<!doctype html><meta charset=utf-8><title></title><script>
(async () => {
  const steps = [
    () => localStorage.clear(),
    () => sessionStorage.clear(),
    async () => {
      for (const { name } of await indexedDB.databases()) {
        if (name) await new Promise((done) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = done; });
      }
    },
    async () => { for (const key of await caches.keys()) await caches.delete(key); },
    async () => { const root = await navigator.storage.getDirectory(); for await (const name of root.keys()) await root.removeEntry(name, { recursive: true }); },
    () => {
      for (const pair of document.cookie.split(";")) {
        const name = pair.split("=")[0].trim();
        if (name) document.cookie = name + "=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/";
      }
    },
  ];
  for (const step of steps) { try { await step(); } catch {} }
  await fetch("/cleared", { method: "POST" });
})();
</script>"#;

    #[derive(Default)]
    pub struct ForgetState {
        /// Hidden window label → the origin it clears.
        cleaning: Mutex<HashMap<String, Cleaning>>,
        next_id: AtomicU64,
        /// One change to the list at a time.
        list: Mutex<()>,
    }

    struct Cleaning {
        host: String,
        /// Told once the page reported.
        done: Option<oneshot::Sender<()>>,
    }

    /// The answer to a request of a hidden window (none for any other window): the cleaning page on its origin, its
    /// report, and nothing else. The contact's app is never asked.
    pub fn serve<R: Runtime>(
        app: &AppHandle<R>,
        label: &str,
        request: &Request<Vec<u8>>,
    ) -> Option<Response<Vec<u8>>> {
        if !label.starts_with(LABEL_PREFIX) {
            return None;
        }
        let empty = |status| Response::builder().status(status).body(Vec::new());
        let state = app.try_state::<ForgetState>()?;
        let mut cleaning = state.cleaning.lock().ok()?;
        let Some(origin) = cleaning.get_mut(label) else {
            return empty(StatusCode::FORBIDDEN).ok();
        };
        let own = request
            .uri()
            .host()
            .is_some_and(|host| host.eq_ignore_ascii_case(&origin.host));
        match (own, request.uri().path()) {
            (true, "/") => Response::builder()
                .header("content-type", "text/html; charset=utf-8")
                .header("cache-control", "no-store")
                .body(CLEANING_PAGE.as_bytes().to_vec())
                .ok(),
            (true, CLEARED_PATH) => {
                if let Some(done) = origin.done.take() {
                    let _ = done.send(());
                }
                empty(StatusCode::NO_CONTENT).ok()
            }
            (true, _) => empty(StatusCode::NOT_FOUND).ok(),
            (false, _) => empty(StatusCode::FORBIDDEN).ok(),
        }
    }

    /// Opens a hidden window on `host`'s origin, notes the origin for the next launch, and waits for the cleaning
    /// page's report. True once it reported.
    pub async fn clear_in_window<R: Runtime>(app: &AppHandle<R>, list: &Path, host: &str) -> bool {
        let state = app.state::<ForgetState>();
        let label = format!(
            "{LABEL_PREFIX}{}",
            state.next_id.fetch_add(1, Ordering::Relaxed)
        );
        let (done, reported) = oneshot::channel();
        if let Ok(mut cleaning) = state.cleaning.lock() {
            cleaning.insert(
                label.clone(),
                Cleaning {
                    host: host.to_string(),
                    done: Some(done),
                },
            );
        }
        let cleared = match open_hidden(app, &label, host) {
            Ok(window) => {
                // Where this webview keeps each kind: WebKitGTK names them, the app sets none of its own.
                let (sender, folders) = oneshot::channel();
                let _ = window.with_webview(move |webview| {
                    let _ = sender.send(folders_of(&webview.inner()));
                });
                if let Ok(Ok(folders)) = tokio::time::timeout(CLEAR_TIMEOUT, folders).await {
                    if let Ok(_one) = state.list.lock() {
                        note(list, folders, host);
                    }
                }
                tokio::time::timeout(CLEAR_TIMEOUT, reported)
                    .await
                    .is_ok_and(|said| said.is_ok())
            }
            Err(_) => false,
        };
        if let Ok(mut cleaning) = state.cleaning.lock() {
            cleaning.remove(&label);
        }
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.destroy();
        }
        cleared
    }

    fn open_hidden<R: Runtime>(
        app: &AppHandle<R>,
        label: &str,
        host: &str,
    ) -> Result<WebviewWindow<R>, String> {
        let url = format!("{SCHEME}://{host}/")
            .parse()
            .map_err(|e| format!("URL: {e}"))?;
        let own = host.to_string();
        WebviewWindowBuilder::new(app, label, WebviewUrl::CustomProtocol(url))
            .visible(false)
            .focused(false)
            .skip_taskbar(true)
            // The cleaning page alone: no other page of the origin, no other site, no window, no file.
            .on_navigation(move |to| {
                to.scheme() == SCHEME
                    && to.host_str().is_some_and(|h| h.eq_ignore_ascii_case(&own))
                    && to.path() == "/"
            })
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .on_download(|_, _| false)
            .build()
            .map_err(|e| format!("Window: {e}"))
    }

    /// Where the webview keeps each kind of storage, as WebKitGTK said when the origins were forgotten.
    #[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
    pub struct Folders {
        local_storage: Option<PathBuf>,
        indexeddb: Option<PathBuf>,
        cache_storage: Option<PathBuf>,
        /// Beside `localstorage`: one folder per origin, its `origin` file naming it.
        storage: Option<PathBuf>,
    }

    /// The webview's own folders. Its base folders read back as none when the app set none (WebKitGTK's defaults,
    /// named after the program): each kind's folder is asked for.
    #[allow(deprecated)]
    fn folders_of(webview: &webkit2gtk::WebView) -> Folders {
        use webkit2gtk::{WebViewExt, WebsiteDataManagerExt};
        let Some(manager) = webview.website_data_manager() else {
            return Folders::default();
        };
        let path = |dir: Option<webkit2gtk::glib::GString>| dir.map(|d| PathBuf::from(d.as_str()));
        let local_storage = path(manager.local_storage_directory());
        Folders {
            storage: local_storage
                .as_deref()
                .and_then(Path::parent)
                .map(|base| base.join("storage")),
            local_storage,
            indexeddb: path(manager.indexeddb_directory()),
            cache_storage: path(manager.dom_cache_directory()),
        }
    }

    /// The list of origins whose files wait for the next launch.
    #[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
    struct Forgotten {
        folders: Folders,
        /// `<service>.<peer>.<tag>`.
        hosts: Vec<String>,
    }

    fn read(list: &Path) -> Option<Forgotten> {
        let text = std::fs::read(list).ok()?;
        match serde_json::from_slice(&text) {
            Ok(forgotten) => Some(forgotten),
            // Not a list: it names contacts all the same.
            Err(_) => {
                let _ = std::fs::remove_file(list);
                None
            }
        }
    }

    /// Writes the list, or removes it once it names no origin.
    fn write(list: &Path, forgotten: &Forgotten) {
        if forgotten.hosts.is_empty() {
            let _ = std::fs::remove_file(list);
            return;
        }
        let Ok(text) = serde_json::to_vec(forgotten) else {
            return;
        };
        let staged = list.with_extension("json.tmp");
        if let Some(dir) = list.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if std::fs::write(&staged, text).is_ok() {
            let _ = std::fs::rename(&staged, list);
        }
    }

    fn note(list: &Path, folders: Folders, host: &str) {
        let mut forgotten = read(list).unwrap_or_default();
        forgotten.folders = folders;
        if !forgotten.hosts.iter().any(|h| h.eq_ignore_ascii_case(host)) {
            forgotten.hosts.push(host.to_string());
        }
        write(list, &forgotten);
    }

    /// At launch, before any window: the files of every origin on the list go, and each origin whose files are all
    /// gone leaves it. Nothing holds them open yet.
    pub fn clean_at_launch<R: Runtime>(app: &AppHandle<R>) {
        if let Ok(dir) = app.path().app_data_dir() {
            clean_list(&dir.join(LIST_FILE));
        }
    }

    pub(super) fn clean_list(list: &Path) {
        let Some(mut forgotten) = read(list) else {
            return;
        };
        let folders = forgotten.folders.clone();
        forgotten
            .hosts
            .retain(|host| !remove_files_of(&folders, host));
        write(list, &forgotten);
    }

    /// How WebKit writes an origin in an `origin` file: the scheme, then the host, each as its length (4 bytes,
    /// little-endian), 1 (8-bit characters) and the characters. The length keeps `xatlas.<…>` from passing for
    /// `atlas.<…>`.
    fn names_origin(bytes: &[u8], host: &str) -> bool {
        let mut written = Vec::new();
        for part in [SCHEME, host] {
            written.extend_from_slice(&(part.len() as u32).to_le_bytes());
            written.push(1);
            written.extend_from_slice(part.as_bytes());
        }
        bytes
            .windows(written.len())
            .any(|window| window.eq_ignore_ascii_case(&written))
    }

    fn entries(dir: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(dir)
            .map(|entries| entries.flatten().map(|entry| entry.path()).collect())
            .unwrap_or_default()
    }

    fn name_of(path: &Path) -> String {
        path.file_name()
            .map(|name| name.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default()
    }

    /// True once `path` is gone.
    fn remove(path: &Path) -> bool {
        let removed = if path.is_dir() {
            std::fs::remove_dir_all(path)
        } else {
            std::fs::remove_file(path)
        };
        removed.is_ok() || !path.exists()
    }

    fn holds_origin(dir: &Path, host: &str) -> bool {
        dir.is_dir()
            && std::fs::read(dir.join("origin")).is_ok_and(|bytes| names_origin(&bytes, host))
    }

    /// Removes every file and folder of `host`'s origin: its localStorage file (and its journal), its IndexedDB
    /// folder, its Cache Storage folder and its storage folder. True once none is left.
    fn remove_files_of(folders: &Folders, host: &str) -> bool {
        let named = format!("{SCHEME}_{host}_0").to_ascii_lowercase();
        let mut gone = true;
        if let Some(dir) = &folders.local_storage {
            for file in entries(dir) {
                if name_of(&file).starts_with(&format!("{named}.localstorage")) {
                    gone &= remove(&file);
                }
            }
        }
        if let Some(dir) = &folders.indexeddb {
            for version in entries(dir).into_iter().filter(|v| v.is_dir()) {
                for database in entries(&version) {
                    if name_of(&database) == named {
                        gone &= remove(&database);
                    }
                }
            }
        }
        if let Some(dir) = &folders.cache_storage {
            for origin in entries(dir) {
                if holds_origin(&origin, host) {
                    gone &= remove(&origin);
                }
            }
        }
        if let Some(dir) = &folders.storage {
            // `storage/<top origin>/<origin>`: the top folder goes with its last origin.
            for top in entries(dir).into_iter().filter(|t| t.is_dir()) {
                for origin in entries(&top) {
                    if holds_origin(&origin, host) {
                        gone &= remove(&origin);
                    }
                }
                if entries(&top).is_empty() {
                    let _ = std::fs::remove_dir(&top);
                }
            }
        }
        gone
    }

    #[cfg(test)]
    pub(super) mod tests {
        use super::*;

        pub const PEER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        pub const TAG: &str = "ybndrfg8ejkmcpqx";

        /// An `origin` file as WebKitGTK 2.52 wrote it for `ghostly-svc://keeper.<PEER>.<TAG>` (the probe's bytes):
        /// the top origin, then the origin, each with no port.
        pub fn origin_file(host: &str) -> Vec<u8> {
            let mut bytes = Vec::new();
            for _ in 0..2 {
                for part in [SCHEME, host] {
                    bytes.extend_from_slice(&(part.len() as u32).to_le_bytes());
                    bytes.push(1);
                    bytes.extend_from_slice(part.as_bytes());
                }
                bytes.push(0);
            }
            bytes
        }

        /// What one origin left in a webview's folders, as the probes saw it on WebKitGTK 2.52 (data and cache
        /// apart, as with WebKitGTK's defaults).
        pub fn lay_out(data: &Path, cache: &Path, host: &str, hash: &str) {
            let local = data.join("localstorage");
            std::fs::create_dir_all(&local).unwrap();
            for suffix in ["", "-wal", "-shm"] {
                std::fs::write(
                    local.join(format!("{SCHEME}_{host}_0.localstorage{suffix}")),
                    b"x",
                )
                .unwrap();
            }
            let database = data.join(format!("databases/indexeddb/v1/{SCHEME}_{host}_0/{hash}"));
            std::fs::create_dir_all(&database).unwrap();
            std::fs::write(database.join("IndexedDB.sqlite3"), b"x").unwrap();
            let cached = cache.join("CacheStorage").join(hash);
            std::fs::create_dir_all(&cached).unwrap();
            std::fs::write(cached.join("cacheslist"), b"x").unwrap();
            std::fs::write(cached.join("origin"), origin_file(host)).unwrap();
            let stored = data.join("storage").join(hash).join(hash);
            std::fs::create_dir_all(&stored).unwrap();
            std::fs::write(stored.join("origin"), origin_file(host)).unwrap();
        }

        fn folders(data: &Path, cache: &Path) -> Folders {
            Folders {
                local_storage: Some(data.join("localstorage")),
                indexeddb: Some(data.join("databases/indexeddb")),
                cache_storage: Some(cache.join("CacheStorage")),
                storage: Some(data.join("storage")),
            }
        }

        /// Every file under `dir`, by its path from there.
        pub fn files(dir: &Path) -> Vec<String> {
            let mut found = Vec::new();
            let mut folders = vec![dir.to_path_buf()];
            while let Some(folder) = folders.pop() {
                for path in entries(&folder) {
                    if path.is_dir() {
                        folders.push(path);
                    } else {
                        found.push(
                            path.strip_prefix(dir)
                                .unwrap()
                                .to_string_lossy()
                                .into_owned(),
                        );
                    }
                }
            }
            found.sort();
            found
        }

        /// Whether a file under `dir` names `host`'s origin, by its path or by its bytes.
        pub fn named_anywhere(dir: &Path, host: &str) -> Vec<String> {
            files(dir)
                .into_iter()
                .filter(|file| {
                    file.to_ascii_lowercase()
                        .contains(&host.to_ascii_lowercase())
                        || std::fs::read(dir.join(file)).is_ok_and(|bytes| {
                            bytes
                                .windows(host.len())
                                .any(|w| w.eq_ignore_ascii_case(host.as_bytes()))
                        })
                })
                .collect()
        }

        fn scratch(name: &str) -> PathBuf {
            let dir =
                std::env::temp_dir().join(format!("ghostly-forget-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            dir
        }

        #[test]
        fn an_origin_file_names_its_origin_and_no_other() {
            let host = format!("keeper.{PEER}.{TAG}");
            let bytes = origin_file(&host);
            assert!(names_origin(&bytes, &host));
            assert!(names_origin(&bytes, &host.to_ascii_uppercase()));
            // The same contact and chat, another app whose name ends in this one's, or begins with it.
            assert!(!names_origin(
                &origin_file(&format!("xkeeper.{PEER}.{TAG}")),
                &host
            ));
            assert!(!names_origin(&bytes, &format!("eeper.{PEER}.{TAG}")));
            // The same app of the same contact in another profile's chat.
            assert!(!names_origin(
                &origin_file(&format!("keeper.{PEER}.ot1uwisza345h769")),
                &host
            ));
            // An http origin with the same name.
            let http = String::from_utf8_lossy(&bytes).replace(SCHEME, "https-name!");
            assert!(!names_origin(http.as_bytes(), &host));
        }

        #[test]
        fn the_launch_removes_every_file_of_the_origins_on_the_list_and_then_the_list() {
            // covers: services.desktop-viewer
            let dir = scratch("launch");
            let (data, cache) = (dir.join("data"), dir.join("cache"));
            let gone = format!("keeper.{PEER}.{TAG}");
            let kept = format!("notes.{PEER}.ot1uwisza345h769");
            lay_out(
                &data,
                &cache,
                &gone,
                "B6869B96CDD2DC4321154F7A1B6074DE2D0D6F44",
            );
            lay_out(
                &data,
                &cache,
                &kept,
                "0W6U6R600qSv1a5k_4wFd0BJVQliCyO-jOwpM5okN8U",
            );
            // Three localStorage files, the database, and the two `origin` files.
            let kept_files = named_anywhere(&dir, &kept);
            assert_eq!(kept_files.len(), 6, "{kept_files:?}");
            assert_eq!(named_anywhere(&dir, &gone).len(), 6);

            let list = dir.join(LIST_FILE);
            note(&list, folders(&data, &cache), &gone);
            note(&list, folders(&data, &cache), &gone.to_ascii_uppercase());
            assert_eq!(read(&list).unwrap().hosts, [gone.as_str()], "noted once");

            clean_list(&list);
            assert_eq!(named_anywhere(&dir, &gone), Vec::<String>::new());
            // Another origin's files stay, and so do the folders' own (none of an origin's left empty behind).
            assert_eq!(named_anywhere(&dir, &kept), kept_files);
            assert!(!data
                .join("storage/B6869B96CDD2DC4321154F7A1B6074DE2D0D6F44")
                .exists());
            assert!(
                !list.exists(),
                "the list goes once empty: it names contacts"
            );
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn an_origin_whose_files_could_not_go_stays_on_the_list() {
            let dir = scratch("stays");
            let (data, cache) = (dir.join("data"), dir.join("cache"));
            let host = format!("keeper.{PEER}.{TAG}");
            let other = format!("notes.{PEER}.{TAG}");
            lay_out(&data, &cache, &host, "H1");
            let list = dir.join(LIST_FILE);
            note(&list, folders(&data, &cache), &host);
            note(&list, folders(&data, &cache), &other);
            // A folder that refuses: its files cannot be removed.
            use std::os::unix::fs::PermissionsExt;
            let local = data.join("localstorage");
            std::fs::set_permissions(&local, std::fs::Permissions::from_mode(0o500)).unwrap();
            clean_list(&list);
            std::fs::set_permissions(&local, std::fs::Permissions::from_mode(0o700)).unwrap();
            assert_eq!(
                read(&list).unwrap().hosts,
                [host.as_str()],
                "the other had nothing left"
            );
            clean_list(&list);
            assert!(!list.exists());
            assert_eq!(named_anywhere(&dir, &host), Vec::<String>::new());
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn a_list_that_is_not_one_goes() {
            let dir = scratch("broken");
            let list = dir.join(LIST_FILE);
            std::fs::write(&list, format!("{{\"hosts\": [\"keeper.{PEER}.{TAG}\"")).unwrap();
            clean_list(&list);
            assert!(!list.exists());
            // No list at all: nothing to do.
            clean_list(&list);
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}

#[cfg(test)]
mod tests {
    // covers: services.desktop-viewer
    use super::*;

    const PEER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const TAG: &str = "ybndrfg8ejkmcpqx";

    fn origin(service: &str, peer: &str, tag: &str) -> ServiceOrigin {
        ServiceOrigin {
            service: service.into(),
            peer: peer.into(),
            tag: tag.into(),
        }
    }

    #[test]
    fn only_an_origin_a_viewer_could_have_opened_is_taken() {
        assert_eq!(
            origin("keeper", PEER, TAG).host().as_deref(),
            Some(format!("keeper.{PEER}.{TAG}").as_str())
        );
        let long = "a".repeat(65);
        for (service, peer, tag) in [
            ("", PEER, TAG),
            ("keeper", "", TAG),
            ("keeper.x", PEER, TAG),
            ("keeper", "peer/../..", TAG),
            ("keeper", long.as_str(), TAG),
            ("kee per", PEER, TAG),
            ("keeper", PEER, ""),
            ("keeper", PEER, "ybndrfg8ejkmcpq"),
            ("keeper", PEER, "ybndrfg8ejkmcpq2"),
            ("keeper", PEER, "ybndrfg8.jkmcpqx"),
        ] {
            assert_eq!(
                origin(service, peer, tag).host(),
                None,
                "{service} {peer} {tag}"
            );
        }
    }

    #[test]
    fn a_list_with_one_origin_that_is_not_one_forgets_none() {
        let app = tauri::test::mock_builder()
            .manage(viewer::ViewerState::default())
            .build(tauri::generate_context!(test = true))
            .expect("app");
        let answer = tauri::async_runtime::block_on(forget_service_origins(
            app.handle().clone(),
            vec![origin("keeper", PEER, TAG), origin("keeper", PEER, "nope")],
        ));
        assert_eq!(answer.unwrap_err(), "Invalid service");
    }
}

/// The real windows on WebKitGTK: what a contact's app kept, read back after it was forgotten, and its files after the
/// next launch's cleanup.
#[cfg(all(test, target_os = "linux"))]
mod display_tests {
    use super::linux::tests::{files, named_anywhere, PEER, TAG};
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::{Listener, Manager};

    /// The contact's app: it keeps something in each kind of storage, or reads back what it kept.
    const WRITE: &str = r#"<!doctype html><script>
localStorage.setItem('probe-k', '1');
const r = indexedDB.open('probe-db', 1);
r.onupgradeneeded = () => r.result.createObjectStore('s');
r.onsuccess = () => {
  const tx = r.result.transaction('s', 'readwrite'); tx.objectStore('s').put('v', 'k');
  tx.oncomplete = async () => { r.result.close(); await caches.open('probe-cache'); fetch('/written'); };
};
</script>"#;
    const READ: &str = r#"<!doctype html><script>
(async () => {
  const dbs = (await indexedDB.databases()).map((d) => d.name).join(',');
  const cs = (await caches.keys()).join(',');
  fetch('/read?' + new URLSearchParams({ ls: String(localStorage.getItem('probe-k')), idb: dbs, caches: cs }));
})();
</script>"#;

    /// Exits the app when dropped, a panic's unwinding included.
    struct Exit(tauri::AppHandle);
    impl Drop for Exit {
        fn drop(&mut self) {
            self.0.exit(0);
        }
    }

    #[test]
    #[ignore = "needs a display and a process of its own (GTK)"]
    fn what_a_contacts_app_kept_is_gone_at_once_and_its_files_at_the_next_launch() {
        // covers: services.desktop-viewer
        let home =
            std::env::temp_dir().join(format!("ghostly-forget-display-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("HOME", &home);
        for (name, folder) in [
            ("XDG_CONFIG_HOME", ".config"),
            ("XDG_DATA_HOME", ".local/share"),
            ("XDG_CACHE_HOME", ".cache"),
        ] {
            std::env::set_var(name, home.join(folder));
        }
        let host = format!("keeper.{PEER}.{TAG}");

        let app = tauri::Builder::default()
            .any_thread()
            .manage(viewer::ViewerState::default())
            .manage(ForgetState::default())
            .register_asynchronous_uri_scheme_protocol(viewer::SCHEME, |ctx, request, responder| {
                let app = ctx.app_handle().clone();
                let label = ctx.webview_label().to_string();
                tauri::async_runtime::spawn(async move {
                    responder.respond(viewer::handle(app, label, request).await);
                });
            })
            .build(tauri::generate_context!(test = true))
            .expect("app");

        // The main window's part: the contact's app is the page above, and what it says comes back here.
        let (said, heard) = mpsc::channel::<String>();
        let page = std::sync::Arc::new(std::sync::Mutex::new(WRITE));
        let serving = page.clone();
        let handle = app.handle().clone();
        app.listen_any(viewer::REQUEST_EVENT, move |event| {
            let request: serde_json::Value = serde_json::from_str(event.payload()).unwrap();
            let path = request["path"].as_str().unwrap().to_string();
            let body = if path == "/" {
                serving.lock().unwrap().to_string()
            } else {
                String::new()
            };
            if path.starts_with("/written") || path.starts_with("/read") {
                let _ = said.send(path);
            }
            use base64::Engine;
            viewer::respond(
                &handle,
                request["id"].as_u64().unwrap(),
                viewer::ServiceResponse {
                    status: 200,
                    headers: vec![("content-type".into(), "text/html; charset=utf-8".into())],
                    body_b64: base64::engine::general_purpose::STANDARD.encode(body),
                },
            );
        });

        let handle = app.handle().clone();
        let steps = std::thread::spawn(move || {
            // Whatever a step finds, the app exits, and the failure comes out of `join` below.
            let _exit = Exit(handle.clone());
            let wait = |what: &str| {
                let path = heard
                    .recv_timeout(Duration::from_secs(60))
                    .unwrap_or_else(|_| panic!("no {what}"));
                assert!(path.starts_with(what), "{path}");
                path
            };
            let open = || {
                viewer::open(
                    &handle,
                    PEER.into(),
                    "keeper".into(),
                    TAG.into(),
                    "Keeper".into(),
                    None,
                )
                .unwrap()
            };
            open();
            wait("/written");
            let windows = |prefix: &str| {
                handle
                    .webview_windows()
                    .keys()
                    .filter(|l| l.starts_with(prefix))
                    .count()
            };
            assert_eq!(windows("svc-"), 1);

            let cleared = tauri::async_runtime::block_on(forget_service_origins(
                handle.clone(),
                vec![ServiceOrigin {
                    service: "keeper".into(),
                    peer: PEER.into(),
                    tag: TAG.into(),
                }],
            ))
            .unwrap();
            assert_eq!(cleared, [true]);
            std::thread::sleep(Duration::from_millis(500));
            assert_eq!(windows("svc-"), 0, "the app's window closed");
            assert_eq!(windows("forget-"), 0, "the hidden window closed");

            // The app opened again finds nothing of what it kept.
            *page.lock().unwrap() = READ;
            open();
            let read = wait("/read");
            assert_eq!(read, "/read?ls=null&idb=&caches=");
            std::thread::sleep(Duration::from_millis(500));
        });
        let list = app
            .path()
            .app_data_dir()
            .unwrap()
            .join(super::linux::LIST_FILE);
        app.run_return(|_, _| {});
        steps.join().unwrap();

        // The files still named after the origin, until the next launch: at least its folders' `origin` files.
        let before = named_anywhere(&home, &host);
        assert!(
            before.iter().any(|f| f.ends_with("/origin")),
            "{:?}",
            files(&home)
        );
        assert!(list.exists(), "{:?}", files(&home));

        super::linux::clean_list(&list);
        assert_eq!(
            named_anywhere(&home, &host),
            Vec::<String>::new(),
            "before: {before:?}"
        );
        assert!(!list.exists());
        let _ = std::fs::remove_dir_all(&home);
    }
}
