//! The local apps the person shares, per profile: the only addresses `local_fetch` may reach.
//!
//! The page cannot add one. An address is added only when the person clicks Allow in a native
//! dialog that Rust shows and that names the exact address (`localhost:3400`): when they share an
//! app, or, for an app shared before this list existed, the first time a contact opens it. The page
//! may take an address off the list (removing a service), never put one on it.
//!
//! The profile (`space`) is the page's word, so it keeps one profile's shares apart from another's;
//! it is not a security boundary. The Allow click is.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::future::Future;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::file_store::check_space;
use crate::local_fetch::is_loopback;

pub const NOT_LOCAL: &str = "Only services on this machine can be shared";

/// Why the person is asked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    /// They are sharing an app now (a click in Services).
    Share,
    /// A contact is opening an app the list does not have: one shared before this version.
    FirstUse,
}

/// `http://localhost:3400` for any loopback http(s) URL: scheme, host and port, the port always
/// written, so `http://localhost` and `http://localhost:80/x` are the same address.
pub fn origin_of(url: &url::Url) -> Result<String, String> {
    if !matches!(url.scheme(), "http" | "https") || !is_loopback(url) {
        return Err(NOT_LOCAL.into());
    }
    let (Some(host), Some(port)) = (url.host_str(), url.port_or_known_default()) else {
        return Err(NOT_LOCAL.into());
    };
    Ok(format!("{}://{}:{}", url.scheme(), host, port))
}

/// An origin as the page names it (`http://localhost:3400`): nothing past the port.
pub fn parse_origin(text: &str) -> Result<String, String> {
    let url = url::Url::parse(text).map_err(|_| NOT_LOCAL.to_string())?;
    if !url.username().is_empty()
        || url.password().is_some()
        || !matches!(url.path(), "" | "/")
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Not an origin".into());
    }
    origin_of(&url)
}

/// How the dialog names an address: `localhost:3400`, with the scheme only when it is https.
pub fn label(origin: &str) -> &str {
    origin.strip_prefix("http://").unwrap_or(origin)
}

/// The native dialog's title and text.
#[cfg_attr(feature = "e2e-driver", allow(dead_code))]
pub fn dialog_text(origin: &str, reason: Reason) -> (String, String) {
    let at = label(origin);
    match reason {
        Reason::Share => (
            format!("Share {at}?"),
            format!(
                "Contacts you choose will be able to open the app at {at} through Ghostly.\n\n\
                 Allow only if you are sharing this app in Ghostly now."
            ),
        ),
        Reason::FirstUse => (
            format!("Keep sharing {at}?"),
            format!(
                "A contact is opening the app at {at}, which you shared in Ghostly before. \
                 Ghostly now asks once for each address it may reach.\n\n\
                 Allow only if you shared this app."
            ),
        ),
    }
}

fn not_allowed(origin: &str) -> String {
    format!(
        "{} is not an app you allowed Ghostly to share",
        label(origin)
    )
}

#[derive(Default, Serialize, Deserialize)]
struct Saved {
    spaces: BTreeMap<String, BTreeSet<String>>,
}

#[derive(Default)]
pub struct LocalAccess {
    /// Where the list is kept (`local-services.json` in the app's data folder); none in tests.
    file: Option<PathBuf>,
    approved: Mutex<BTreeMap<String, BTreeSet<String>>>,
    /// Refused since the app started: a contact's next request does not ask again.
    denied: Mutex<HashSet<(String, String)>>,
    /// One dialog at a time; requests for an address being asked about wait for the answer.
    asking: tokio::sync::Mutex<()>,
}

impl LocalAccess {
    /// The list kept in `file`. Unreadable, it starts empty: every address is asked about again.
    pub fn load(file: PathBuf) -> Self {
        let saved: Saved = std::fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self {
            file: Some(file),
            approved: Mutex::new(saved.spaces),
            ..Self::default()
        }
    }

    pub fn is_allowed(&self, space: &str, origin: &str) -> bool {
        self.approved
            .lock()
            .unwrap()
            .get(space)
            .is_some_and(|origins| origins.contains(origin))
    }

    /// The page's word that a profile no longer shares `origin`. Only ever takes away.
    pub fn forget(&self, space: &str, origin: &str) -> Result<(), String> {
        check_space(space)?;
        let mut approved = self.approved.lock().unwrap();
        let removed = approved
            .get_mut(space)
            .is_some_and(|origins| origins.remove(origin));
        if approved.get(space).is_some_and(BTreeSet::is_empty) {
            approved.remove(space);
        }
        if removed {
            self.save(&approved)?;
        }
        Ok(())
    }

    /// Ok once `origin` is on the profile's list, asking the person (`ask`) when it is not. A
    /// contact's request (`FirstUse`) the person refused since the app started is refused without
    /// asking; sharing (`Share`) always asks.
    pub async fn ensure<F, Fut>(
        &self,
        space: &str,
        origin: &str,
        reason: Reason,
        ask: F,
    ) -> Result<(), String>
    where
        F: FnOnce(String, Reason) -> Fut,
        Fut: Future<Output = bool>,
    {
        check_space(space)?;
        if self.is_allowed(space, origin) {
            return Ok(());
        }
        let _turn = self.asking.lock().await;
        // A burst of requests for one address waits on one dialog, then goes through.
        if self.is_allowed(space, origin) {
            return Ok(());
        }
        let key = (space.to_string(), origin.to_string());
        if reason == Reason::FirstUse && self.denied.lock().unwrap().contains(&key) {
            return Err(not_allowed(origin));
        }
        if !ask(origin.to_string(), reason).await {
            self.denied.lock().unwrap().insert(key);
            return Err(not_allowed(origin));
        }
        self.denied.lock().unwrap().remove(&key);
        let mut approved = self.approved.lock().unwrap();
        approved
            .entry(space.to_string())
            .or_default()
            .insert(origin.to_string());
        self.save(&approved)
    }

    fn save(&self, approved: &BTreeMap<String, BTreeSet<String>>) -> Result<(), String> {
        let Some(file) = &self.file else {
            return Ok(());
        };
        let bytes = serde_json::to_vec_pretty(&Saved {
            spaces: approved.clone(),
        })
        .map_err(|e| e.to_string())?;
        if let Some(folder) = file.parent() {
            std::fs::create_dir_all(folder).map_err(|e| e.to_string())?;
        }
        let temporary = file.with_extension("json.tmp");
        let mut options = std::fs::OpenOptions::new();
        options.create(true).truncate(true).write(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut out = options.open(&temporary).map_err(|e| e.to_string())?;
        std::io::Write::write_all(&mut out, &bytes).map_err(|e| e.to_string())?;
        out.sync_all().map_err(|e| e.to_string())?;
        std::fs::rename(&temporary, file).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    // covers: desktop.local-fetch
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn temp_file() -> PathBuf {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        std::env::temp_dir()
            .join(format!(
                "ghostly-local-access-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            ))
            .join("local-services.json")
    }

    #[test]
    fn an_origin_is_a_loopback_scheme_host_and_port() {
        for (text, origin) in [
            ("http://localhost:3400", "http://localhost:3400"),
            ("http://localhost:3400/", "http://localhost:3400"),
            ("http://LOCALHOST:3400", "http://localhost:3400"),
            ("http://localhost", "http://localhost:80"),
            ("https://127.0.0.1", "https://127.0.0.1:443"),
            ("http://[::1]:8080", "http://[::1]:8080"),
        ] {
            assert_eq!(parse_origin(text).unwrap(), origin, "{text}");
        }
        for text in [
            "http://example.com:3400",
            "http://10.0.0.1:3400",
            "http://0.0.0.0:3400",
            "http://[::ffff:127.0.0.1]:3400",
            "http://localhost.evil.example:3400",
            "ftp://127.0.0.1:21",
            "http://localhost:3400/app",
            "http://localhost:3400/?a=1",
            "http://user@localhost:3400",
            "localhost:3400",
            "",
        ] {
            assert!(parse_origin(text).is_err(), "{text}");
        }
        let url = url::Url::parse("http://localhost:3400/api/x?y=1").unwrap();
        assert_eq!(origin_of(&url).unwrap(), "http://localhost:3400");
    }

    #[test]
    fn the_dialog_names_the_exact_address() {
        for reason in [Reason::Share, Reason::FirstUse] {
            let (title, text) = dialog_text("http://localhost:3400", reason);
            assert!(title.contains("localhost:3400"), "{title}");
            assert!(text.contains("localhost:3400"), "{text}");
            assert!(!format!("{title}{text}").contains('\u{2014}'), "no em dash");
        }
        assert!(dialog_text("https://127.0.0.1:443", Reason::Share)
            .0
            .contains("https://127.0.0.1:443"));
    }

    #[tokio::test]
    async fn an_address_is_added_only_by_a_yes_and_kept_per_profile() {
        let access = LocalAccess::default();
        let origin = "http://localhost:3400";
        assert!(!access.is_allowed("ghostly_a", origin));
        let refused = access
            .ensure("ghostly_a", origin, Reason::Share, |_, _| async { false })
            .await;
        assert!(refused.unwrap_err().contains("localhost:3400"));
        assert!(!access.is_allowed("ghostly_a", origin));

        access
            .ensure(
                "ghostly_a",
                origin,
                Reason::Share,
                |asked, reason| async move {
                    assert_eq!((asked.as_str(), reason), (origin, Reason::Share));
                    true
                },
            )
            .await
            .unwrap();
        assert!(access.is_allowed("ghostly_a", origin));
        assert!(!access.is_allowed("ghostly_b", origin), "another profile");
        assert!(!access.is_allowed("ghostly_a", "http://localhost:5432"));

        // Allowed: nobody is asked again.
        access
            .ensure("ghostly_a", origin, Reason::FirstUse, |_, _| async {
                panic!("asked again")
            })
            .await
            .unwrap();

        access.forget("ghostly_a", origin).unwrap();
        assert!(!access.is_allowed("ghostly_a", origin));
        assert!(access
            .ensure("../x", origin, Reason::Share, |_, _| async { true })
            .await
            .is_err());
    }

    #[tokio::test]
    async fn a_refusal_holds_for_contacts_until_the_app_restarts_but_sharing_asks_again() {
        let access = LocalAccess::default();
        let origin = "http://127.0.0.1:5432";
        let asked = AtomicUsize::new(0);
        let ask = |answer: bool| {
            let asked = &asked;
            move |_: String, _: Reason| {
                asked.fetch_add(1, Ordering::SeqCst);
                async move { answer }
            }
        };
        assert!(access
            .ensure("p", origin, Reason::FirstUse, ask(false))
            .await
            .is_err());
        assert!(access
            .ensure("p", origin, Reason::FirstUse, ask(true))
            .await
            .is_err());
        assert_eq!(asked.load(Ordering::SeqCst), 1, "a contact asks once");
        access
            .ensure("p", origin, Reason::Share, ask(true))
            .await
            .unwrap();
        assert_eq!(asked.load(Ordering::SeqCst), 2);
        assert!(access.is_allowed("p", origin));
    }

    #[tokio::test]
    async fn requests_arriving_together_wait_on_one_dialog() {
        let access = Arc::new(LocalAccess::default());
        let asked = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for _ in 0..8 {
            let (access, asked) = (access.clone(), asked.clone());
            tasks.push(tokio::spawn(async move {
                access
                    .ensure(
                        "p",
                        "http://localhost:3400",
                        Reason::FirstUse,
                        |_, _| async move {
                            asked.fetch_add(1, Ordering::SeqCst);
                            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                            true
                        },
                    )
                    .await
            }));
        }
        for task in tasks {
            task.await.unwrap().unwrap();
        }
        assert_eq!(asked.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn the_list_survives_a_restart_and_the_file_is_private() {
        let file = temp_file();
        let access = LocalAccess::load(file.clone());
        for origin in ["http://localhost:3400", "http://localhost:8080"] {
            access
                .ensure("ghostly_a", origin, Reason::Share, |_, _| async { true })
                .await
                .unwrap();
        }
        access.forget("ghostly_a", "http://localhost:8080").unwrap();

        let again = LocalAccess::load(file.clone());
        assert!(again.is_allowed("ghostly_a", "http://localhost:3400"));
        assert!(!again.is_allowed("ghostly_a", "http://localhost:8080"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&file).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }

        // A file that is not the list: nothing is allowed.
        std::fs::write(&file, b"{ not json").unwrap();
        assert!(!LocalAccess::load(file.clone()).is_allowed("ghostly_a", "http://localhost:3400"));
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }
}
