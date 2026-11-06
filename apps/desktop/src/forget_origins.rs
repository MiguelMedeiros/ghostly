//! What a contact's app kept in the webview's storage, forgotten with its chat, its profile's data or its profile.
//!
//! A contact's app runs on an origin of its own (`viewer`), named after the service, the contact and this profile's
//! chat with them, and it shares the Ghostly window's WebKit storage: its localStorage, IndexedDB and Cache Storage
//! land in folders named after that origin, so after the chat went they still held what the app kept, and their names
//! said which contact's app this device opened. The page asks for the origins it noted (`forget_service_origins`).
//!
//! On Linux and macOS each origin is cleared in two steps, as WebKit allows: its website-data API lists nothing for a
//! `ghostly-svc` origin (WebKitGTK's `WebsiteDataManager`, and macOS's `WKWebsiteDataStore`, whose
//! `fetchDataRecordsOfTypes` answered no record at all with a contact's app's storage on the disk), and its network
//! process keeps the origin's files open while the app runs, so removing them erases nothing until the next launch.
//! - Now: a hidden window on the origin, served a cleaning page of the app's own (`serve`): the contact's app is never
//!   asked and none of its code runs there. The page empties every kind of storage the origin has and says so.
//! - At the next launch, before any window: the files still named after the origin are removed (`clean_at_launch`),
//!   and on macOS its row in WebKit's tracking prevention database, which names it too.
//!   Until then the origin is on a list in the app's data folder; it leaves the list once its files are gone, and the
//!   list goes once empty, since it too names contacts.
//!
//! On Windows, WebView2 names the origin `http://ghostly-svc.<service>.<peer>.<tag>`, and a profile's files shared by
//! every origin (its Local Storage log, its quota database, its history, its preferences) keep an origin's records
//! after any clear, through every later launch: LevelDB reuses its log at each one. So each contact's app opens in a
//! WebView2 profile of its own (`app_folder`), and forgetting it removes that folder once its window closed. An app
//! opened before it had one kept its storage in the Ghostly window's profile: when that profile holds the origin, the
//! webview's DevTools protocol clears it there (`Storage.clearDataForOrigin`), the files and folders named after it
//! included.

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

/// Forgets what the apps on `origins` kept: their windows close, then each origin is cleared (Linux, macOS, Windows).
/// Answers, for each, whether it was cleared; one that was not stays on the page's list, for its next clear.
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
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        use tauri::Manager;
        let list = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join(webkit::LIST_FILE);
        let mut cleared = Vec::with_capacity(hosts.len());
        for host in &hosts {
            cleared.push(webkit::clear_in_window(&app, &list, host).await);
        }
        Ok(cleared)
    }
    #[cfg(windows)]
    {
        let mut cleared = Vec::with_capacity(hosts.len());
        for host in &hosts {
            cleared.push(windows::clear(&app, host).await);
        }
        Ok(cleared)
    }
    // Android and iOS open no viewer window (`viewer` is Desktop's): nothing to clear.
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        let _ = app;
        Ok(vec![false; hosts.len()])
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub use webkit::{clean_at_launch, serve, ForgetState};

#[cfg(windows)]
pub use windows::app_folder;

#[cfg(windows)]
mod windows {
    use std::path::PathBuf;
    use std::time::Duration;

    use sha2::{Digest, Sha256};
    use tauri::{AppHandle, Manager, Runtime};
    use tokio::sync::oneshot;
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows_core::HSTRING;

    use crate::viewer::SCHEME;

    /// How long WebView2 may take to clear one origin, or to let go of an app's folder, before the rest goes on
    /// without it.
    const CLEAR_TIMEOUT: Duration = Duration::from_secs(10);
    /// The contacts' apps' profiles, in the app's local data folder beside the Ghostly window's.
    const APPS_FOLDER: &str = "apps";

    /// The WebView2 profile of `host`'s app (`<service>.<peer>.<tag>`): a folder of its own, named by a hash of the
    /// host. Short, since Chromium's own paths inside it take most of Windows' 260 characters (IndexedDB fails to
    /// open past them), and it names no contact.
    pub fn app_folder<R: Runtime>(app: &AppHandle<R>, host: &str) -> Option<PathBuf> {
        let digest = Sha256::digest(host.to_ascii_lowercase().as_bytes());
        let name: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
        Some(
            app.path()
                .app_local_data_dir()
                .ok()?
                .join(APPS_FOLDER)
                .join(name),
        )
    }

    /// Forgets what `host`'s app kept: its own profile, and what it kept in the Ghostly window's before it had one.
    pub async fn clear<R: Runtime>(app: &AppHandle<R>, host: &str) -> bool {
        let shared = !held_in_shared(app, host) || clear_shared(app, host).await;
        remove_folder(app, host).await && shared
    }

    /// Whether the Ghostly window's profile holds anything of `host`'s origin: a file or folder named after it, or
    /// a record in its Local Storage. Clearing an origin it never held would write its name there all the same
    /// (LevelDB notes each key it deletes). Always with WEBVIEW2_USER_DATA_FOLDER, which puts every webview in one
    /// profile.
    fn held_in_shared<R: Runtime>(app: &AppHandle<R>, host: &str) -> bool {
        if std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_some() {
            return true;
        }
        let Ok(local) = app.path().app_local_data_dir() else {
            return true;
        };
        let needle = host.to_ascii_lowercase();
        let mut folders = vec![local.join("EBWebView")];
        while let Some(folder) = folders.pop() {
            for path in std::fs::read_dir(&folder)
                .into_iter()
                .flatten()
                .flatten()
                .map(|entry| entry.path())
            {
                let named = path
                    .file_name()
                    .is_some_and(|n| n.to_string_lossy().to_ascii_lowercase().contains(&needle));
                if named {
                    return true;
                }
                if path.is_dir() {
                    folders.push(path);
                    continue;
                }
                let recorded = path.components().any(|c| c.as_os_str() == "Local Storage")
                    && std::fs::read(&path).is_ok_and(|bytes| {
                        bytes
                            .windows(needle.len())
                            .any(|w| w.eq_ignore_ascii_case(needle.as_bytes()))
                    });
                if recorded {
                    return true;
                }
            }
        }
        false
    }

    /// Removes `host`'s app's profile. WebView2's processes for it hold its files a moment after its window closed.
    /// True once it is gone, or was never there.
    async fn remove_folder<R: Runtime>(app: &AppHandle<R>, host: &str) -> bool {
        let Some(folder) = app_folder(app, host) else {
            return false;
        };
        let deadline = tokio::time::Instant::now() + CLEAR_TIMEOUT;
        loop {
            if std::fs::remove_dir_all(&folder).is_ok() || !folder.exists() {
                return true;
            }
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    /// Clears every kind of storage `host`'s origin has in the Ghostly window's profile, through its webview: the
    /// call reaches the origin with no window of its own. True once WebView2 said it cleared.
    async fn clear_shared<R: Runtime>(app: &AppHandle<R>, host: &str) -> bool {
        let Some(window) = app.get_webview_window("main") else {
            return false;
        };
        let params = serde_json::json!({
            "origin": format!("http://{SCHEME}.{host}"),
            "storageTypes": "all",
        })
        .to_string();
        let (sender, answered) = oneshot::channel();
        let asked = window.with_webview(move |webview| unsafe {
            let Ok(core) = webview.controller().CoreWebView2() else {
                return;
            };
            // Dropped unanswered when the call fails: `answered` then says not cleared.
            let handler =
                CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, _| {
                    let _ = sender.send(result.is_ok());
                    Ok(())
                }));
            let _ = core.CallDevToolsProtocolMethod(
                &HSTRING::from("Storage.clearDataForOrigin"),
                &HSTRING::from(params),
                &handler,
            );
        });
        asked.is_ok()
            && matches!(
                tokio::time::timeout(CLEAR_TIMEOUT, answered).await,
                Ok(Ok(true))
            )
    }
}

/// WebKitGTK's and WKWebView's own: the hidden window, the list, and the files each keeps per origin.
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod webkit {
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
                if let Some(folders) = folders(&window).await {
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

    /// Where the webview keeps each kind of storage, as WebKit said (or, on macOS, as it names them) when the origins
    /// were forgotten.
    #[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
    pub struct Folders {
        local_storage: Option<PathBuf>,
        indexeddb: Option<PathBuf>,
        cache_storage: Option<PathBuf>,
        /// `<top origin>/<origin>` folders, each with an `origin` file naming it: on Linux beside `localstorage`, on
        /// macOS every kind of an origin's storage inside.
        storage: Option<PathBuf>,
        /// macOS: WebKit's tracking prevention notes every site a window showed, by name, in this database
        /// (`ObservedDomains`), the contact's app's host among them.
        #[serde(default)]
        observed: Option<PathBuf>,
    }

    /// Where this webview keeps each kind: WebKitGTK names them, the app sets none of its own.
    #[cfg(target_os = "linux")]
    async fn folders<R: Runtime>(window: &WebviewWindow<R>) -> Option<Folders> {
        let (sender, folders) = oneshot::channel();
        let _ = window.with_webview(move |webview| {
            let _ = sender.send(folders_of(&webview.inner()));
        });
        tokio::time::timeout(CLEAR_TIMEOUT, folders)
            .await
            .ok()?
            .ok()
    }

    /// WKWebView's default store, the one every window of the app shares, has no public call that names its folder:
    /// WebKit puts it under the app's bundle id (the process's name without one), with each origin's localStorage,
    /// IndexedDB and Cache Storage in a folder of its own (`WebsiteData/Default/<top origin>/<origin>`, both salted
    /// hashes), its `origin` file naming it.
    #[cfg(target_os = "macos")]
    async fn folders<R: Runtime>(_window: &WebviewWindow<R>) -> Option<Folders> {
        use objc2_foundation::{NSBundle, NSHomeDirectory, NSProcessInfo};
        let id = NSBundle::mainBundle()
            .bundleIdentifier()
            .unwrap_or_else(|| NSProcessInfo::processInfo().processName())
            .to_string();
        mac_folders(Path::new(&NSHomeDirectory().to_string()), &id)
    }

    /// Where WKWebView's default store keeps each origin's folder, for an app with bundle id `id`.
    #[cfg(any(target_os = "macos", test))]
    pub(super) fn mac_folders(home: &Path, id: &str) -> Option<Folders> {
        // Never a folder above the app's own (an id is a file name).
        let id = (!id.is_empty() && id != "." && id != ".." && !id.contains('/')).then_some(id)?;
        let data = home.join("Library/WebKit").join(id).join("WebsiteData");
        Some(Folders {
            storage: Some(data.join("Default")),
            observed: Some(data.join("ResourceLoadStatistics/observations.db")),
            ..Folders::default()
        })
    }

    /// The webview's own folders. Its base folders read back as none when the app set none (WebKitGTK's defaults,
    /// named after the program): each kind's folder is asked for.
    #[cfg(target_os = "linux")]
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
            observed: None,
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
    /// folder, its Cache Storage folder and its storage folder, and on macOS its tracking prevention row. True once
    /// none is left.
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
        #[cfg(target_os = "macos")]
        if let Some(db) = &folders.observed {
            gone &= observed::forget(db, host);
        }
        gone
    }

    /// WebKit's tracking prevention database on macOS (`ResourceLoadStatistics/observations.db`, SQLite): one row per
    /// site a window showed, named by its host, so the contact's app's too. Its row goes at launch, with the rows of
    /// other tables that point at it (`ON DELETE CASCADE`), its bytes overwritten (`secure_delete`), before WebKit opens
    /// the database. Through the system's SQLite: no copy of it is linked in.
    #[cfg(target_os = "macos")]
    pub(super) mod observed {
        use std::ffi::{c_char, c_int, c_void, CString};
        use std::path::Path;

        #[repr(C)]
        struct Sqlite3 {
            _private: [u8; 0],
        }

        type Callback = Option<
            unsafe extern "C" fn(*mut c_void, c_int, *mut *mut c_char, *mut *mut c_char) -> c_int,
        >;

        #[link(name = "sqlite3")]
        extern "C" {
            fn sqlite3_open_v2(
                name: *const c_char,
                db: *mut *mut Sqlite3,
                flags: c_int,
                vfs: *const c_char,
            ) -> c_int;
            fn sqlite3_busy_timeout(db: *mut Sqlite3, ms: c_int) -> c_int;
            fn sqlite3_exec(
                db: *mut Sqlite3,
                sql: *const c_char,
                callback: Callback,
                arg: *mut c_void,
                error: *mut *mut c_char,
            ) -> c_int;
            fn sqlite3_close(db: *mut Sqlite3) -> c_int;
        }

        const SQLITE_OK: c_int = 0;
        const SQLITE_OPEN_READWRITE: c_int = 0x2;

        /// One more row in the count `arg` points at.
        unsafe extern "C" fn count(
            arg: *mut c_void,
            _: c_int,
            _: *mut *mut c_char,
            _: *mut *mut c_char,
        ) -> c_int {
            *(arg as *mut usize) += 1;
            0
        }

        /// Runs `sql` on the database at `path`, which must exist: the rows it answered, once it ran whole.
        pub(in super::super) fn exec(path: &Path, sql: &str) -> Option<usize> {
            let name = CString::new(path.to_str()?).ok()?;
            let sql = CString::new(sql).ok()?;
            let mut db = std::ptr::null_mut();
            let mut rows = 0usize;
            // SAFETY: both strings end in NUL and outlive the calls, `rows` too; `db` is closed whatever the answer.
            unsafe {
                let ran = sqlite3_open_v2(
                    name.as_ptr(),
                    &mut db,
                    SQLITE_OPEN_READWRITE,
                    std::ptr::null(),
                ) == SQLITE_OK
                    && sqlite3_busy_timeout(db, 2_000) == SQLITE_OK
                    && sqlite3_exec(
                        db,
                        sql.as_ptr(),
                        Some(count),
                        (&mut rows as *mut usize).cast(),
                        std::ptr::null_mut(),
                    ) == SQLITE_OK;
                sqlite3_close(db);
                ran.then_some(rows)
            }
        }

        /// Takes `host` out of the database at `path`. True once it is not there: removed, or no database (or no
        /// such table) at all.
        pub fn forget(path: &Path, host: &str) -> bool {
            // A host `ServiceOrigin::host` made: letters, digits, `-` and `.`, nothing to quote.
            if host.is_empty()
                || !host
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
            {
                return false;
            }
            if !path.exists() {
                return true;
            }
            match exec(
                path,
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ObservedDomains'",
            ) {
                Some(0) => true,
                Some(_) => exec(
                    path,
                    &format!(
                        "PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON; \
                         DELETE FROM ObservedDomains WHERE registrableDomain = '{host}' COLLATE NOCASE;"
                    ),
                )
                .is_some(),
                None => false,
            }
        }
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
                observed: None,
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

        /// What one origin left in WKWebView's default store, as the e2e run on macOS 15 saw it: a folder of its own
        /// under `WebsiteData/Default`, named by salted hashes, its `origin` file naming it.
        fn mac_lay_out(default: &Path, host: &str, hash: &str) -> PathBuf {
            let origin = default.join(hash).join(hash);
            for (file, bytes) in [
                ("LocalStorage/localstorage.sqlite3", &b"x"[..]),
                ("LocalStorage/localstorage.sqlite3-wal", b"x"),
                ("LocalStorage/localstorage.sqlite3-shm", b"x"),
                ("IndexedDB/661432C2E1374E598DB4FF0D1C1574111A5E368FA07A90DB28E294A94A5FB6AA/IndexedDB.sqlite3", b"x"),
                ("CacheStorage/cacheslist", b"x"),
                ("CacheStorage/salt", b"x"),
                ("CacheStorage/Version 16/salt", b"x"),
            ] {
                let path = origin.join(file);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, bytes).unwrap();
            }
            std::fs::write(origin.join("origin"), origin_file(host)).unwrap();
            origin
        }

        #[test]
        fn on_macos_the_folders_are_the_apps_own_under_its_bundle_id() {
            let home = Path::new("/Users/someone");
            let folders = mac_folders(home, "tools.ghostly.e2e.forget").unwrap();
            let data = home.join("Library/WebKit/tools.ghostly.e2e.forget/WebsiteData");
            assert_eq!(folders.storage, Some(data.join("Default")));
            assert_eq!(
                folders.observed,
                Some(data.join("ResourceLoadStatistics/observations.db"))
            );
            assert_eq!(
                (
                    &folders.local_storage,
                    &folders.indexeddb,
                    &folders.cache_storage
                ),
                (&None, &None, &None),
                "every kind is inside the origin's folder"
            );
            for id in ["", ".", "..", "../app.ghostly.chat", "a/b"] {
                assert_eq!(mac_folders(home, id), None, "{id:?}");
            }
        }

        #[test]
        fn on_macos_the_launch_removes_the_folder_of_each_origin_on_the_list_and_no_other() {
            // covers: services.desktop-viewer
            let dir = scratch("mac");
            let folders = mac_folders(&dir, "tools.ghostly.e2e.forget").unwrap();
            let default = folders.storage.clone().unwrap();
            let gone = format!("keeper.{PEER}.{TAG}");
            let kept = format!("notes.{PEER}.ot1uwisza345h769");
            let gone_folder = mac_lay_out(
                &default,
                &gone,
                "LZs_mZY_vIF7PUi52K28pgxwNPx_pWne9lI9SiGkt8o",
            );
            let kept_folder = mac_lay_out(
                &default,
                &kept,
                "BLyTQTjtc-2kYU9gOlf9szqwtMNLncmbk4vjK6cViDg",
            );
            std::fs::write(default.join("salt"), b"s").unwrap();
            let kept_files = files(&kept_folder);
            assert_eq!(named_anywhere(&dir, &gone).len(), 1, "its `origin` file");

            let list = dir.join(LIST_FILE);
            note(&list, folders, &gone);
            clean_list(&list);
            assert_eq!(named_anywhere(&dir, &gone), Vec::<String>::new());
            assert!(
                !gone_folder.parent().unwrap().exists(),
                "its top folder went with it"
            );
            assert_eq!(
                files(&kept_folder),
                kept_files,
                "another origin's folder stays whole"
            );
            assert!(default.join("salt").exists(), "the store's own files stay");
            assert!(!list.exists());
            let _ = std::fs::remove_dir_all(&dir);
        }

        /// WebKit's tracking prevention tables, as macOS 15's `observations.db` has them (the part that names sites).
        #[cfg(target_os = "macos")]
        const OBSERVED_SCHEMA: &str = "PRAGMA journal_mode = WAL;
            CREATE TABLE ObservedDomains (domainID INTEGER PRIMARY KEY, registrableDomain TEXT NOT NULL UNIQUE ON CONFLICT FAIL, lastSeen REAL NOT NULL);
            CREATE TABLE TopLevelDomains (topLevelDomainID INTEGER PRIMARY KEY, CONSTRAINT fkDomainID FOREIGN KEY(topLevelDomainID) REFERENCES ObservedDomains(domainID) ON DELETE CASCADE);
            CREATE TABLE SubresourceUnderTopFrameDomains (subresourceDomainID INTEGER NOT NULL, lastUpdated REAL NOT NULL, topFrameDomainID INTEGER NOT NULL, FOREIGN KEY(subresourceDomainID) REFERENCES ObservedDomains(domainID) ON DELETE CASCADE, FOREIGN KEY(topFrameDomainID) REFERENCES ObservedDomains(domainID) ON DELETE CASCADE);";

        #[cfg(target_os = "macos")]
        #[test]
        fn on_macos_tracking_prevention_forgets_the_origins_site_and_no_other() {
            let dir = scratch("observed");
            let db = dir.join("observations.db");
            let host = format!("keeper.{PEER}.{TAG}");
            std::fs::write(&db, b"").unwrap();
            assert!(observed::exec(&db, OBSERVED_SCHEMA).is_some());
            assert!(observed::exec(
                &db,
                &format!(
                    "INSERT INTO ObservedDomains VALUES (1, 'localhost', 1.0), (2, '{host}', 0.0), (3, 'notes.{PEER}.{TAG}', 0.0);
                     INSERT INTO TopLevelDomains VALUES (1), (2);
                     INSERT INTO SubresourceUnderTopFrameDomains VALUES (1, 1.0, 2), (3, 1.0, 1);"
                )
            )
            .is_some());
            let count = |sql: &str| observed::exec(&db, sql).unwrap();

            assert!(observed::forget(&db, &host.to_ascii_uppercase()));
            assert_eq!(count("SELECT registrableDomain FROM ObservedDomains"), 2);
            assert_eq!(
                count(&format!(
                    "SELECT 1 FROM ObservedDomains WHERE registrableDomain = '{host}'"
                )),
                0
            );
            assert_eq!(
                count("SELECT 1 FROM TopLevelDomains"),
                1,
                "its rows elsewhere went with it"
            );
            assert_eq!(count("SELECT 1 FROM SubresourceUnderTopFrameDomains"), 1);
            // Closed, the database holds its name nowhere, not even in a freed page or the journal.
            assert_eq!(named_anywhere(&dir, &host), Vec::<String>::new());

            // Nothing to do: no such host, a database without the table, no database.
            assert!(observed::forget(&db, &host));
            let bare = dir.join("bare.db");
            std::fs::write(&bare, b"").unwrap();
            assert!(observed::forget(&bare, &host));
            assert!(observed::forget(&dir.join("none.db"), &host));
            // Never a name that would need quoting.
            assert!(!observed::forget(&db, "x' OR '1'='1"));
            assert!(!observed::forget(&db, ""));
            assert_eq!(count("SELECT 1 FROM ObservedDomains"), 2);
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

/// The real windows on WebKitGTK and WebView2: what a contact's app kept, read back after it was forgotten, and the
/// files left named after its origin (on Linux, until the next launch's cleanup).
#[cfg(all(test, any(target_os = "linux", windows)))]
mod display_tests {
    #[cfg(target_os = "linux")]
    use super::webkit::tests::{files, named_anywhere};
    use super::*;
    #[cfg(windows)]
    use std::path::Path;
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::{Listener, Manager};

    /// The contact's app: it keeps something in each kind of storage, or reads back what it kept. Cache Storage only
    /// on a secure origin (WebView2's `http://ghostly-svc.…` is not one); it says whether it had it.
    const WRITE: &str = r#"<!doctype html><script>
localStorage.setItem('probe-k', '1');
const r = indexedDB.open('probe-db', 1);
r.onupgradeneeded = () => r.result.createObjectStore('s');
r.onsuccess = () => {
  const tx = r.result.transaction('s', 'readwrite'); tx.objectStore('s').put('v', 'k');
  tx.oncomplete = async () => {
    r.result.close();
    if (self.caches) await caches.open('probe-cache');
    fetch('/written?caches=' + Boolean(self.caches));
  };
};
</script>"#;
    const READ: &str = r#"<!doctype html><script>
(async () => {
  const dbs = (await indexedDB.databases()).map((d) => d.name).join(',');
  const cs = self.caches ? (await caches.keys()).join(',') : '';
  fetch('/read?' + new URLSearchParams({ ls: String(localStorage.getItem('probe-k')), idb: dbs, caches: cs }));
})();
</script>"#;

    const PEER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const TAG: &str = "ybndrfg8ejkmcpqx";

    /// Every file under `dir`, by its path from there.
    #[cfg(windows)]
    fn files(dir: &Path) -> Vec<String> {
        let mut found = Vec::new();
        let mut folders = vec![dir.to_path_buf()];
        while let Some(folder) = folders.pop() {
            for path in std::fs::read_dir(&folder)
                .into_iter()
                .flatten()
                .flatten()
                .map(|e| e.path())
            {
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

    /// The files under `dir` whose path names `host`, and those whose bytes do (UTF-8 or UTF-16, as Chromium writes
    /// either).
    #[cfg(windows)]
    fn named_anywhere(dir: &Path, host: &str) -> (Vec<String>, Vec<String>) {
        let host = host.to_ascii_lowercase();
        let wide: Vec<u8> = host.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let (mut by_name, mut by_bytes) = (Vec::new(), Vec::new());
        for file in files(dir) {
            if file.to_ascii_lowercase().contains(&host) {
                by_name.push(file);
            } else if std::fs::read(dir.join(&file)).is_ok_and(|bytes| {
                [host.as_bytes(), &wide[..]]
                    .iter()
                    .any(|n| bytes.windows(n.len()).any(|w| w.eq_ignore_ascii_case(n)))
            }) {
                by_bytes.push(file);
            }
        }
        (by_name, by_bytes)
    }

    /// Exits the app when dropped, a panic's unwinding included.
    struct Exit(tauri::AppHandle);
    impl Drop for Exit {
        fn drop(&mut self) {
            self.0.exit(0);
        }
    }

    #[test]
    #[ignore = "needs a display and a process of its own (GTK, WebView2)"]
    fn what_a_contacts_app_kept_is_gone_and_no_file_names_it() {
        // covers: services.desktop-viewer
        #[cfg(target_os = "linux")]
        let home = {
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
            home
        };
        // The app's own local data folder, where WebView2 keeps the Ghostly window's profile and each contact's
        // app's, under an id of the test's own. Not WEBVIEW2_USER_DATA_FOLDER: it puts every webview in one profile.
        #[allow(unused_mut)]
        let mut context = tauri::generate_context!(test = true);
        #[cfg(windows)]
        let home = {
            const ID: &str = "tools.ghostly.test.forget";
            context.config_mut().identifier = ID.into();
            let home = std::path::PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap()).join(ID);
            let _ = std::fs::remove_dir_all(&home);
            home
        };
        let host = format!("keeper.{PEER}.{TAG}");

        let builder = tauri::Builder::default()
            .any_thread()
            .manage(viewer::ViewerState::default());
        #[cfg(target_os = "linux")]
        let builder = builder.manage(ForgetState::default());
        let app = builder
            .register_asynchronous_uri_scheme_protocol(viewer::SCHEME, |ctx, request, responder| {
                let app = ctx.app_handle().clone();
                let label = ctx.webview_label().to_string();
                tauri::async_runtime::spawn(async move {
                    responder.respond(viewer::handle(app, label, request).await);
                });
            })
            .build(context)
            .expect("app");
        #[cfg(windows)]
        assert_eq!(app.path().app_local_data_dir().unwrap(), home);

        // The main window's part: the contact's app is the page above, and what it says comes back here.
        let (said, heard) = mpsc::channel::<String>();
        let page = std::sync::Arc::new(std::sync::Mutex::new(WRITE));
        let serving = page.clone();
        let handle = app.handle().clone();
        app.listen_any(viewer::REQUEST_EVENT, move |event| {
            let request: serde_json::Value = serde_json::from_str(event.payload()).unwrap();
            let path = request["path"].as_str().unwrap().to_string();
            eprintln!("the app asked for {path}");
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

        // The Ghostly window (`main`, the WebView2 clears through) comes from the app's configuration, as in the app.
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
                    None,
                )
                .unwrap()
            };
            open();
            eprintln!("{}", wait("/written"));
            let windows = |prefix: &str| {
                handle
                    .webview_windows()
                    .keys()
                    .filter(|l| l.starts_with(prefix))
                    .count()
            };
            assert_eq!(windows("svc-"), 1);

            let forget = || {
                tauri::async_runtime::block_on(forget_service_origins(
                    handle.clone(),
                    vec![ServiceOrigin {
                        service: "keeper".into(),
                        peer: PEER.into(),
                        tag: TAG.into(),
                    }],
                ))
                .unwrap()
            };
            assert_eq!(forget(), [true]);
            std::thread::sleep(Duration::from_millis(500));
            assert_eq!(windows("svc-"), 0, "the app's window closed");
            #[cfg(target_os = "linux")]
            assert_eq!(windows("forget-"), 0, "the hidden window closed");

            // The app opened again finds nothing of what it kept.
            *page.lock().unwrap() = READ;
            open();
            let read = wait("/read");
            assert_eq!(read, "/read?ls=null&idb=&caches=");
            std::thread::sleep(Duration::from_millis(500));
            // Its visit to read is forgotten too: then nothing on the disk may name it.
            #[cfg(windows)]
            assert_eq!(forget(), [true]);
        });
        #[cfg(target_os = "linux")]
        let list = app
            .path()
            .app_data_dir()
            .unwrap()
            .join(super::webkit::LIST_FILE);
        app.run_return(|_, _| {});
        steps.join().unwrap();

        // WebView2's processes let go of the folder once they are gone. No file of the app's folder names the
        // origin or holds what the app kept, the Ghostly window's profile included: the files WebView2 shares
        // between a profile's origins (its Local Storage log, its quota database, its history, its preferences)
        // keep an origin's records after any clear, through every later launch.
        #[cfg(windows)]
        {
            std::thread::sleep(Duration::from_secs(3));
            let (by_name, by_bytes) = named_anywhere(&home, &host);
            let (_, kept) = named_anywhere(&home, "probe-");
            eprintln!("files: {:#?}", files(&home));
            let _ = std::fs::remove_dir_all(&home);
            assert_eq!(
                by_name,
                Vec::<String>::new(),
                "no file or folder is named after the origin"
            );
            assert_eq!(by_bytes, Vec::<String>::new(), "no file holds its name");
            assert_eq!(kept, Vec::<String>::new(), "no file holds what it kept");
        }

        // The files still named after the origin, until the next launch: at least its folders' `origin` files.
        #[cfg(target_os = "linux")]
        {
            let before = named_anywhere(&home, &host);
            assert!(
                before.iter().any(|f| f.ends_with("/origin")),
                "{:?}",
                files(&home)
            );
            assert!(list.exists(), "{:?}", files(&home));

            super::webkit::clean_list(&list);
            assert_eq!(
                named_anywhere(&home, &host),
                Vec::<String>::new(),
                "before: {before:?}"
            );
            assert!(!list.exists());
            let _ = std::fs::remove_dir_all(&home);
        }
    }
}
