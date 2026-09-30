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

/// Adds the plugin first, as it asks: a second launch exits in its setup, before any window or peer starts.
pub fn register<R: Runtime>(builder: tauri::Builder<R>, identifier: &str) -> tauri::Builder<R> {
    let Some(id) = this_id(identifier, &|name| std::env::var(name).ok()) else {
        return builder;
    };
    builder.plugin(
        tauri_plugin_single_instance::Builder::new()
            .dbus_id(id)
            .callback(|app, _argv, _cwd| {
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
