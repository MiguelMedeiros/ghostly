//! Android and iOS: the commands of the Desktop-only modules, each refusing. The command list (`commands!`), the
//! capability and `build.rs` stay one list for every platform, and the page gets an answer it already handles (an
//! error) rather than "command not found". The stubs take no arguments: Tauri ignores the ones the page sends.
//! - `hyperdht`: Desktop runs HyperDHT in a Node program, which a phone cannot start (native HyperDHT on Android is
//!   its own piece of work, through Bare).
//! - `keep_awake`: a phone keeps a call awake with a foreground service and a wake lock instead.
//! - `share`: the macOS share sheet; Android's comes with the Android host.
//! - `viewer`, `app_sandbox`: a contact's app or an installed app in a window of its own. A mobile app has one
//!   window.

const NOT_HERE: &str = "Not available on this platform";

pub mod hyperdht {
    use super::NOT_HERE;
    use serde_json::Value;

    #[tauri::command]
    pub fn paired_hyperdht_start() -> Result<Value, String> {
        Err(NOT_HERE.into())
    }

    #[tauri::command]
    pub fn paired_hyperdht_address() -> Result<Value, String> {
        Err(NOT_HERE.into())
    }

    #[tauri::command]
    pub fn paired_hyperdht_connect() -> Result<u64, String> {
        Err(NOT_HERE.into())
    }

    #[tauri::command]
    pub fn paired_hyperdht_send() -> Result<(), String> {
        Err(NOT_HERE.into())
    }

    #[tauri::command]
    pub fn paired_hyperdht_close() -> Result<(), String> {
        Err(NOT_HERE.into())
    }

    #[tauri::command]
    pub fn paired_hyperdht_stop() {}
}

pub mod keep_awake {
    /// Nothing held: `Ok(false)`, as on a desktop that has no way to hold the screen on.
    #[tauri::command]
    pub fn keep_awake() -> Result<bool, String> {
        Ok(false)
    }
}

pub mod share {
    use super::NOT_HERE;

    #[tauri::command]
    pub fn share_text() -> Result<bool, String> {
        Err(NOT_HERE.into())
    }
}

pub mod viewer {
    use super::NOT_HERE;
    use serde::Deserialize;

    #[derive(Debug, Deserialize)]
    #[allow(dead_code)]
    pub struct ServiceResponse {
        pub status: u16,
        pub headers: Vec<(String, String)>,
        pub body_b64: String,
    }

    pub fn open<R: tauri::Runtime>(
        _app: &tauri::AppHandle<R>,
        _peer: String,
        _service: String,
        _title: String,
    ) -> Result<(), String> {
        Err(NOT_HERE.into())
    }

    pub fn respond<R: tauri::Runtime>(
        _app: &tauri::AppHandle<R>,
        _id: u64,
        _response: ServiceResponse,
    ) {
    }
}

pub mod app_sandbox {
    use super::NOT_HERE;
    use serde_json::Value;

    /// No window is ever an app's here.
    pub fn is_app_label(_label: &str) -> bool {
        false
    }

    #[tauri::command]
    pub fn app_broker() -> Result<Value, String> {
        Err(NOT_HERE.into())
    }
}
