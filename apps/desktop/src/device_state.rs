//! A profile's device state (WISP 06, "Durable device state"), kept a second time outside the WebView:
//! `devices/<profile>.json` in the app's data folder, one file per profile (`profile` is the page's
//! database name). The state decides whether this device may run the profile at all, so a write
//! answers only once the bytes are on disk: written to a temporary file, synced, renamed over the
//! old one, and the folder synced. The page keeps the same record in its own database and, at start,
//! takes the stricter of the two (packages/browser/src/devices/store.ts). Rust only stores the text;
//! it checks that it is a JSON object, never what it says.

use crate::file_store::check_space;
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

/// The most a record may be: the device set, a few packets and the index of files left for later.
pub const MAX_RECORD: usize = 4 * 1024 * 1024;

fn file(dir: &Path, profile: &str) -> Result<PathBuf, String> {
    check_space(profile)?;
    Ok(dir.join(format!("{profile}.json")))
}

/// The folder's own entry on disk: a rename or a removal is durable only once this is.
fn sync_dir(dir: &Path) -> Result<(), String> {
    #[cfg(unix)]
    File::open(dir)
        .and_then(|folder| folder.sync_all())
        .map_err(|error| format!("The device state could not be saved: {error}"))?;
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}

/// The stored record, or `None` when the profile has none.
pub fn read(dir: &Path, profile: &str) -> Result<Option<String>, String> {
    match fs::read_to_string(file(dir, profile)?) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("The device state could not be read: {error}")),
    }
}

/// Stores the record (`None` removes it). Returns once it is on disk.
pub fn write(dir: &Path, profile: &str, record: Option<&str>) -> Result<(), String> {
    let path = file(dir, profile)?;
    let failed = |error: std::io::Error| format!("The device state could not be saved: {error}");
    fs::create_dir_all(dir).map_err(failed)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
    let Some(record) = record else {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(failed(error)),
        }
        return sync_dir(dir);
    };
    if record.len() > MAX_RECORD {
        return Err("The device state is too large".into());
    }
    if !serde_json::from_str::<serde_json::Value>(record).is_ok_and(|value| value.is_object()) {
        return Err("The device state is not a record".into());
    }
    let staged = dir.join(format!("{profile}.json.tmp"));
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut out = options.open(&staged).map_err(failed)?;
    out.write_all(record.as_bytes()).map_err(failed)?;
    out.sync_all().map_err(failed)?;
    drop(out);
    fs::rename(&staged, &path).map_err(failed)?;
    sync_dir(dir)
}

fn folder<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    use tauri::Manager;
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("The app's data folder is unavailable: {error}"))?
        .join("devices"))
}

#[tauri::command]
pub async fn device_state_read<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    profile: String,
) -> Result<Option<String>, String> {
    read(&folder(&app)?, &profile)
}

#[tauri::command]
pub async fn device_state_write<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    profile: String,
    record: Option<String>,
) -> Result<(), String> {
    write(&folder(&app)?, &profile, record.as_deref())
}

#[cfg(test)]
mod tests {
    // covers: devices.gate
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ghostly-device-state-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn a_profile_with_no_record_reads_none_and_a_written_one_reads_back() {
        let dir = scratch("round-trip");
        assert_eq!(read(&dir, "ghostly").unwrap(), None);
        write(&dir, "ghostly", Some(r#"{"state":"standby","saved":1}"#)).unwrap();
        assert_eq!(
            read(&dir, "ghostly").unwrap().as_deref(),
            Some(r#"{"state":"standby","saved":1}"#)
        );
        // One file per profile: another profile still has none.
        assert_eq!(read(&dir, "ghostly_work").unwrap(), None);
        // The staged copy is gone once the write answered.
        assert!(!dir.join("ghostly.json.tmp").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_write_replaces_the_record_whole_and_none_removes_it() {
        let dir = scratch("replace");
        write(
            &dir,
            "ghostly_a",
            Some(r#"{"state":"active","saved":1,"note":"a longer first record"}"#),
        )
        .unwrap();
        write(&dir, "ghostly_a", Some(r#"{"state":"standby","saved":2}"#)).unwrap();
        assert_eq!(
            read(&dir, "ghostly_a").unwrap().as_deref(),
            Some(r#"{"state":"standby","saved":2}"#)
        );
        write(&dir, "ghostly_a", None).unwrap();
        assert_eq!(read(&dir, "ghostly_a").unwrap(), None);
        // Removing what is not there is not an error.
        write(&dir, "ghostly_a", None).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_profile_name_is_never_a_path_and_a_record_is_a_json_object_of_bounded_size() {
        let dir = scratch("refusals");
        for profile in ["", "../ghostly", "a/b", ".hidden", "a b"] {
            assert!(write(&dir, profile, Some("{}")).is_err(), "{profile}");
            assert!(read(&dir, profile).is_err(), "{profile}");
        }
        for record in ["", "standby", "[1]", "{\"state\":"] {
            assert!(write(&dir, "ghostly", Some(record)).is_err(), "{record}");
        }
        let large = format!(r#"{{"pad":"{}"}}"#, "x".repeat(MAX_RECORD));
        assert!(write(&dir, "ghostly", Some(&large)).is_err());
        // A refused write leaves what was stored.
        write(&dir, "ghostly", Some(r#"{"state":"standby"}"#)).unwrap();
        assert!(write(&dir, "ghostly", Some("not json")).is_err());
        assert_eq!(
            read(&dir, "ghostly").unwrap().as_deref(),
            Some(r#"{"state":"standby"}"#)
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn the_folder_and_the_file_are_the_users_alone() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("modes");
        write(&dir, "ghostly", Some("{}")).unwrap();
        assert_eq!(
            fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(dir.join("ghostly.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
