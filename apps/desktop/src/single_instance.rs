//! One Ghostly per profile on Linux: launched again on the same profile, the app brings the running window forward
//! and exits, rather than start a second peer with the same keys (its contacts then hold one instance's channel and
//! refuse the other's as crossed, and the chat stops).
//!
//! `tauri-plugin-single-instance` holds a D-Bus name on the session bus. Its default name is the bundle id, one per
//! machine; here it is the bundle id and a hash of the data folder and `GHOSTLY_PROFILE`, so each profile (and each
//! home, as the end-to-end tests give every app) runs once, and two profiles side by side still can.
//! macOS already opens the running app for a second launch from Finder or the Dock; Windows is left as it was.

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use tauri::{Manager, Runtime};

/// The D-Bus id for this data folder and profile: `<bundle id>.p<16 hex>` (the plugin adds `.SingleInstance`).
pub fn dbus_id(identifier: &str, data_dir: &Path, profile: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data_dir.as_os_str().as_encoded_bytes());
    hasher.update([0]);
    hasher.update(profile.as_bytes());
    let hex: String = hasher.finalize()[..8]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    format!("{identifier}.p{hex}")
}

/// Where the app keeps its data, as Tauri finds it on Linux: `$XDG_DATA_HOME`, else `$HOME/.local/share`.
fn data_dir(env: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
    let absolute =
        |value: Option<String>| value.map(PathBuf::from).filter(|path| path.is_absolute());
    absolute(env("XDG_DATA_HOME"))
        .or_else(|| absolute(env("HOME")).map(|home| home.join(".local/share")))
}

/// Whether there is a session bus to hold the name on. Without one (a CI runner, a bare Xvfb) the plugin is left
/// out: it would fail to connect anyway, and the app runs as before.
fn session_bus(env: &dyn Fn(&str) -> Option<String>) -> bool {
    env("DBUS_SESSION_BUS_ADDRESS").is_some_and(|address| !address.is_empty())
        || env("XDG_RUNTIME_DIR").is_some_and(|dir| Path::new(&dir).join("bus").exists())
}

/// The id for this process, or None where the plugin stays out.
fn this_id(identifier: &str, env: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    if !session_bus(env) {
        return None;
    }
    let dir = data_dir(env)?.join(identifier);
    Some(dbus_id(
        identifier,
        &dir,
        &env("GHOSTLY_PROFILE").unwrap_or_default(),
    ))
}

/// The plugin's name and object path for an id, as it builds them (version 2, without its `semver` feature).
fn bus_name(id: &str) -> String {
    format!("{id}.SingleInstance")
}

fn object_path(name: &str) -> String {
    format!("/{}", name.replace('.', "/").replace('-', "_"))
}

/// Calls the running instance of `id` on the bus, as the plugin's second instance does: true once it has answered.
/// With no one holding the name the bus refuses the call at once.
fn call_running(bus: &zbus::blocking::Connection, id: &str, argv: Vec<String>, cwd: &str) -> bool {
    let name = bus_name(id);
    bus.call_method(
        Some(name.as_str()),
        object_path(&name).as_str(),
        Some("org.SingleInstance.DBus"),
        "ExecuteCallback",
        &(argv, cwd),
    )
    .is_ok()
}

/// A second launch on a profile that already runs: the running app is handed this launch's arguments and folder
/// (its window comes forward) and the answer is true, for the app to leave before Tauri starts. The plugin's own
/// second instance exits in its setup, when tao's X11 device thread has started: the destructors `exit` runs under
/// that thread could crash the launch (SIGSEGV, SIGABRT) instead of handing over.
pub fn hand_over(identifier: &str) -> bool {
    let Some(id) = this_id(identifier, &|name| std::env::var(name).ok()) else {
        return false;
    };
    let Ok(bus) = zbus::blocking::Connection::session() else {
        return false;
    };
    let cwd = std::env::current_dir().unwrap_or_default();
    call_running(
        &bus,
        &id,
        std::env::args().collect(),
        cwd.to_str().unwrap_or_default(),
    )
}

/// A launch handed to this app while it was leaving: what it was launched with, and from where.
static HELD: Mutex<Option<(Vec<String>, String)>> = Mutex::new(None);

/// A later launch handed to this app while it leaves (its window closed, the page saying goodbye: `DEPARTING`) has
/// no window to bring forward: it is held, to start once this app has gone (`relaunch`). True when it was held.
fn held(departing: bool, argv: Vec<String>, cwd: String) -> bool {
    if departing {
        *HELD.lock().unwrap_or_else(|e| e.into_inner()) = Some((argv, cwd));
    }
    departing
}

fn take_held() -> Option<(Vec<String>, String)> {
    HELD.lock().unwrap_or_else(|e| e.into_inner()).take()
}

/// Starts `exe` as that launch was: its own arguments, from its own folder.
fn launch(exe: &Path, argv: &[String], cwd: &str) -> std::io::Result<std::process::Child> {
    std::process::Command::new(exe)
        .args(argv.iter().skip(1))
        .current_dir(cwd)
        .spawn()
}

/// The launch held while this app left, started now that it has gone (`RunEvent::Exit`: the plugin has let go of the
/// profile's name, so it starts on its own instead of handing over again). From the AppImage, not its mount, which
/// goes with this app.
pub fn relaunch<R: Runtime>(app: &tauri::AppHandle<R>) {
    let Some((argv, cwd)) = take_held() else {
        return;
    };
    match tauri::process::current_binary(&app.env()) {
        Ok(exe) => {
            if let Err(error) = launch(&exe, &argv, &cwd) {
                eprintln!("single instance: the launch held while leaving did not start: {error}");
            }
        }
        Err(error) => eprintln!("single instance: no binary to start the held launch: {error}"),
    }
}

/// Adds the plugin first, as it asks: it holds the profile's name for the first instance and answers the next
/// launches' `hand_over`. Two launches at the very same moment still meet in its setup, where the second exits.
pub fn register<R: Runtime>(builder: tauri::Builder<R>, identifier: &str) -> tauri::Builder<R> {
    let Some(id) = this_id(identifier, &|name| std::env::var(name).ok()) else {
        return builder;
    };
    builder.plugin(
        tauri_plugin_single_instance::Builder::new()
            .dbus_id(id)
            .callback(|app, argv, cwd| {
                if held(crate::DEPARTING.load(Ordering::SeqCst), argv, cwd) {
                    return;
                }
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            })
            .build(),
    )
}

#[cfg(test)]
mod tests {
    // covers: desktop.single-instance
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |name| map.get(name).cloned()
    }

    /// A well-known D-Bus name: dot-separated elements of [A-Za-z0-9_-], none starting with a digit, at most 255.
    fn valid_bus_name(name: &str) -> bool {
        name.len() <= 255
            && name.split('.').count() >= 2
            && name.split('.').all(|element| {
                !element.is_empty()
                    && !element.starts_with(|c: char| c.is_ascii_digit())
                    && element
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            })
    }

    #[test]
    fn the_same_profile_in_the_same_home_is_one_instance() {
        let a = env(&[
            ("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus"),
            ("HOME", "/home/ana"),
        ]);
        assert_eq!(
            this_id("app.ghostly.chat", &a),
            this_id("app.ghostly.chat", &a)
        );
        let id = this_id("app.ghostly.chat", &a).unwrap();
        assert!(id.starts_with("app.ghostly.chat.p"), "{id}");
        assert!(valid_bus_name(&format!("{id}.SingleInstance")), "{id}");
    }

    #[test]
    fn another_profile_or_another_home_runs_side_by_side() {
        let bus = ("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus");
        let ana = this_id("app.ghostly.chat", &env(&[bus, ("HOME", "/home/ana")]));
        let work = this_id(
            "app.ghostly.chat",
            &env(&[bus, ("HOME", "/home/ana"), ("GHOSTLY_PROFILE", "work")]),
        );
        let bia = this_id("app.ghostly.chat", &env(&[bus, ("HOME", "/home/bia")]));
        let data = this_id(
            "app.ghostly.chat",
            &env(&[bus, ("HOME", "/home/ana"), ("XDG_DATA_HOME", "/data/ana")]),
        );
        let ids = [ana, work, bia, data];
        for (i, a) in ids.iter().enumerate() {
            for b in &ids[i + 1..] {
                assert_ne!(a, b);
            }
        }
    }

    #[test]
    fn the_default_data_folder_is_the_one_tauri_uses() {
        let bus = ("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus");
        let implicit = this_id("app.ghostly.chat", &env(&[bus, ("HOME", "/home/ana")]));
        let explicit = this_id(
            "app.ghostly.chat",
            &env(&[
                bus,
                ("HOME", "/elsewhere"),
                ("XDG_DATA_HOME", "/home/ana/.local/share"),
            ]),
        );
        assert_eq!(implicit, explicit);
        // A relative XDG_DATA_HOME is ignored, as the XDG spec says.
        let relative = this_id(
            "app.ghostly.chat",
            &env(&[bus, ("HOME", "/home/ana"), ("XDG_DATA_HOME", "data")]),
        );
        assert_eq!(relative, implicit);
    }

    /// A session bus of the test's own, gone with it.
    struct Bus(std::process::Child, String);

    impl Bus {
        fn start() -> Self {
            use std::io::{BufRead, BufReader};
            let mut daemon = std::process::Command::new("dbus-daemon")
                .args(["--session", "--nofork", "--print-address"])
                .stdout(std::process::Stdio::piped())
                .spawn()
                .expect("dbus-daemon");
            let mut address = String::new();
            BufReader::new(daemon.stdout.take().unwrap())
                .read_line(&mut address)
                .unwrap();
            Bus(daemon, address.trim().to_string())
        }

        fn connect(&self) -> zbus::blocking::connection::Builder<'_> {
            zbus::blocking::connection::Builder::address(self.1.as_str()).unwrap()
        }
    }

    impl Drop for Bus {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    /// The running instance, as the plugin serves it: what each later launch handed it.
    struct Running(std::sync::mpsc::Sender<(Vec<String>, String)>);

    #[zbus::interface(name = "org.SingleInstance.DBus")]
    impl Running {
        fn execute_callback(&self, argv: Vec<String>, cwd: String) {
            let _ = self.0.send((argv, cwd));
        }
    }

    #[test]
    fn the_name_and_path_are_the_plugins() {
        let name = bus_name("app.ghostly.chat.p0123456789abcdef");
        assert_eq!(name, "app.ghostly.chat.p0123456789abcdef.SingleInstance");
        assert_eq!(
            object_path(&name),
            "/app/ghostly/chat/p0123456789abcdef/SingleInstance"
        );
        assert_eq!(object_path("a-b.c.SingleInstance"), "/a_b/c/SingleInstance");
    }

    /// The issue: the plugin's second instance exited from its setup while tao's X11 thread was opening the
    /// display, and could crash. The launch now asks the bus first, before Tauri starts: handed over only when the
    /// profile's running instance answers, with this launch's arguments and folder, as the plugin passes them.
    #[test]
    fn a_second_launch_hands_over_only_to_its_own_profiles_running_instance() {
        let bus = Bus::start();
        let launch = bus.connect().build().unwrap();
        let ana = dbus_id(
            "app.ghostly.chat",
            Path::new("/home/ana/.local/share/app.ghostly.chat"),
            "",
        );
        let work = dbus_id(
            "app.ghostly.chat",
            Path::new("/home/ana/.local/share/app.ghostly.chat"),
            "work",
        );
        let argv = vec!["ghostly".to_string(), "--flag".to_string()];

        // No one runs: the launch starts.
        assert!(!call_running(&launch, &ana, argv.clone(), "/home/ana"));

        let (handed, heard) = std::sync::mpsc::channel();
        let name = bus_name(&ana);
        let _first = bus
            .connect()
            .name(name.as_str())
            .unwrap()
            .serve_at(object_path(&name).as_str(), Running(handed))
            .unwrap()
            .build()
            .unwrap();

        assert!(call_running(&launch, &ana, argv.clone(), "/home/ana"));
        assert_eq!(
            heard.try_recv(),
            Ok((argv.clone(), "/home/ana".to_string()))
        );
        // Another profile is not that instance: it starts.
        assert!(!call_running(&launch, &work, argv, "/home/ana"));
        assert!(heard.try_recv().is_err());
    }

    /// The issue: a launch within DEPART_MS of the window's close was handed to this app, whose window was going,
    /// and no window was left. Now it is held while this app leaves, and started once it has gone.
    #[test]
    fn a_launch_while_this_app_leaves_is_started_once_it_has_gone() {
        let argv = |words: &[&str]| words.iter().map(|w| w.to_string()).collect::<Vec<_>>();
        assert!(!held(false, argv(&["ghostly"]), "/home/ana".into()));
        assert_eq!(take_held(), None);
        assert!(held(true, argv(&["ghostly", "--flag"]), "/home/ana".into()));
        assert_eq!(
            take_held(),
            Some((argv(&["ghostly", "--flag"]), "/home/ana".to_string()))
        );
        assert_eq!(take_held(), None);

        // Started as launched: its own arguments, from its own folder.
        let dir = std::env::temp_dir().join(format!("ghostly-relaunch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut child = launch(
            Path::new("/bin/sh"),
            &argv(&["ghostly", "-c", "pwd > started"]),
            dir.to_str().unwrap(),
        )
        .unwrap();
        assert!(child.wait().unwrap().success());
        assert_eq!(
            std::fs::read_to_string(dir.join("started")).unwrap().trim(),
            dir.canonicalize().unwrap().to_str().unwrap()
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn no_session_bus_no_plugin() {
        assert_eq!(
            this_id("app.ghostly.chat", &env(&[("HOME", "/home/ana")])),
            None
        );
        assert_eq!(
            this_id(
                "app.ghostly.chat",
                &env(&[("HOME", "/home/ana"), ("DBUS_SESSION_BUS_ADDRESS", "")])
            ),
            None
        );
        let runtime =
            std::env::temp_dir().join(format!("ghostly-single-instance-{}", std::process::id()));
        std::fs::create_dir_all(&runtime).unwrap();
        let dir = runtime.to_str().unwrap();
        assert_eq!(
            this_id(
                "app.ghostly.chat",
                &env(&[("HOME", "/home/ana"), ("XDG_RUNTIME_DIR", dir)])
            ),
            None
        );
        std::fs::write(runtime.join("bus"), b"").unwrap();
        assert!(this_id(
            "app.ghostly.chat",
            &env(&[("HOME", "/home/ana"), ("XDG_RUNTIME_DIR", dir)])
        )
        .is_some());
        std::fs::remove_dir_all(&runtime).unwrap();
    }
}
