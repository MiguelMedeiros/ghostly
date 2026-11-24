//! A Mac bundle renamed after it was built (a test app made from a release: its `CFBundleIdentifier` set by hand, then
//! signed again) still carries the identifier compiled into the binary, and Tauri names the app's data, cache and log
//! folders after that one. Two apps on one Mac then wrote one log and kept one data folder (devices, files, the DHT
//! node's state), while WebKit kept each one's pages apart under its bundle id. Here the folders follow the running
//! bundle's own id; the first launch of a renamed bundle starts from a copy of what the shared folder held, so its
//! files are still there.

use std::fs;
use std::io;
use std::path::Path;

/// The identifier the app's folders are named after: the running bundle's, when it has one that is a plain file name;
/// else the compiled one (a binary run outside a bundle, or a bundle that kept its id).
pub fn identifier(compiled: &str, bundle: Option<&str>) -> String {
    match bundle {
        Some(id) if !id.is_empty() && id != "." && id != ".." && !id.contains('/') => id.into(),
        _ => compiled.into(),
    }
}

/// The first launch of a bundle whose id is not the compiled one: the data folder named after the compiled id (in
/// `support`) is copied to the bundle's own, once. A copy left half done by a kill is removed and done again; the
/// shared folder is only read.
pub fn adopt(support: &Path, compiled: &str, own: &str) -> io::Result<()> {
    let target = support.join(own);
    let source = support.join(compiled);
    if compiled == own || target.exists() || !source.is_dir() {
        return Ok(());
    }
    let staged = support.join(format!(".{own}.adopting"));
    if staged.exists() {
        fs::remove_dir_all(&staged)?;
    }
    copy_tree(&source, &staged)?;
    fs::rename(&staged, &target)
}

/// A folder and everything in it, links kept as links (never followed). On a Mac's APFS each file is a clone: the
/// copy takes no room until one side changes it.
fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let (from, to) = (entry.path(), to.join(entry.file_name()));
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_tree(&from, &to)?;
        } else if kind.is_symlink() {
            #[cfg(unix)]
            std::os::unix::fs::symlink(fs::read_link(&from)?, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Before the app starts: the identifier in `context` becomes the running bundle's, its data folder copied first. A
/// copy that fails leaves the compiled id, and the shared folders, as before.
#[cfg(target_os = "macos")]
pub fn apply<R: tauri::Runtime>(context: &mut tauri::Context<R>) {
    use objc2_foundation::{NSBundle, NSHomeDirectory};
    let compiled = context.config().identifier.clone();
    let bundle = NSBundle::mainBundle()
        .bundleIdentifier()
        .map(|id| id.to_string());
    let own = identifier(&compiled, bundle.as_deref());
    if own == compiled {
        return;
    }
    let support = Path::new(&NSHomeDirectory().to_string()).join("Library/Application Support");
    match adopt(&support, &compiled, &own) {
        Ok(()) => context.config_mut().identifier = own,
        Err(error) => eprintln!("folders: kept {compiled}'s, {own}'s copy failed: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ghostly-bundle-folders-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_renamed_bundle_names_its_folders_after_its_own_id() {
        assert_eq!(
            identifier("app.ghostly.chat", Some("app.ghostly.chattestb")),
            "app.ghostly.chattestb"
        );
        assert_eq!(
            identifier("app.ghostly.chat", Some("app.ghostly.chat")),
            "app.ghostly.chat"
        );
        // Run outside a bundle, or an id that is no plain file name: the compiled one.
        for bundle in [
            None,
            Some(""),
            Some("."),
            Some(".."),
            Some("../app.ghostly.chat"),
            Some("a/b"),
        ] {
            assert_eq!(identifier("app.ghostly.chat", bundle), "app.ghostly.chat");
        }
    }

    #[test]
    fn the_first_launch_of_a_renamed_bundle_copies_the_shared_folder_once() {
        let support = scratch("first");
        let shared = support.join("app.ghostly.chat");
        fs::create_dir_all(shared.join("files/wallets-b")).unwrap();
        fs::write(shared.join("files/wallets-b/photo.jpg"), b"jpeg").unwrap();
        fs::write(shared.join("local-services.json"), b"{}").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("files/wallets-b", shared.join("link")).unwrap();

        adopt(&support, "app.ghostly.chat", "app.ghostly.chattestb").unwrap();
        let own = support.join("app.ghostly.chattestb");
        assert_eq!(
            fs::read(own.join("files/wallets-b/photo.jpg")).unwrap(),
            b"jpeg"
        );
        assert_eq!(fs::read(own.join("local-services.json")).unwrap(), b"{}");
        #[cfg(unix)]
        assert_eq!(
            fs::read_link(own.join("link")).unwrap(),
            Path::new("files/wallets-b")
        );
        assert!(!support.join(".app.ghostly.chattestb.adopting").exists());

        // From then on each app keeps its own: a later launch copies nothing over what the renamed one wrote.
        fs::write(own.join("local-services.json"), b"{\"b\":1}").unwrap();
        fs::write(shared.join("local-services.json"), b"{\"main\":1}").unwrap();
        adopt(&support, "app.ghostly.chat", "app.ghostly.chattestb").unwrap();
        assert_eq!(
            fs::read(own.join("local-services.json")).unwrap(),
            b"{\"b\":1}"
        );
        assert_eq!(
            fs::read(shared.join("local-services.json")).unwrap(),
            b"{\"main\":1}"
        );
        let _ = fs::remove_dir_all(&support);
    }

    #[test]
    fn a_copy_cut_short_by_a_kill_is_done_again() {
        let support = scratch("killed");
        fs::create_dir_all(support.join("app.ghostly.chat/devices")).unwrap();
        fs::write(support.join("app.ghostly.chat/devices/ghostly"), b"state").unwrap();
        let staged = support.join(".app.ghostly.chattestb.adopting");
        fs::create_dir_all(staged.join("half")).unwrap();

        adopt(&support, "app.ghostly.chat", "app.ghostly.chattestb").unwrap();
        let own = support.join("app.ghostly.chattestb");
        assert_eq!(fs::read(own.join("devices/ghostly")).unwrap(), b"state");
        assert!(!own.join("half").exists());
        assert!(!staged.exists());
        let _ = fs::remove_dir_all(&support);
    }

    #[test]
    fn nothing_is_copied_for_the_compiled_id_or_with_no_shared_folder() {
        let support = scratch("nothing");
        fs::create_dir_all(support.join("app.ghostly.chat")).unwrap();
        adopt(&support, "app.ghostly.chat", "app.ghostly.chat").unwrap();
        // A new bundle on a Mac that never ran Ghostly: its folder is made by the app itself, as for any first run.
        fs::remove_dir_all(support.join("app.ghostly.chat")).unwrap();
        adopt(&support, "app.ghostly.chat", "app.ghostly.chattestb").unwrap();
        assert!(!support.join("app.ghostly.chattestb").exists());
        let _ = fs::remove_dir_all(&support);
    }
}
