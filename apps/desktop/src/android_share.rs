//! The share another app made on Android, as Rust keeps it until the page takes it (`android.rs` hears it from the
//! Kotlin side). Apart from `android.rs` so its tests run on any host.

use serde::Deserialize;
use std::sync::Mutex;

/// A share from another app, as the Kotlin side copied it: its text, the files it made of the shared streams, in
/// the app's cache, and the names of those it did not copy, too large to bring in (`left_out`) or not read (`unread`).
#[derive(Deserialize, Default, Clone, Debug, PartialEq)]
pub struct Shared {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub files: Vec<SharedFile>,
    #[serde(default, rename = "leftOut")]
    pub left_out: Vec<String>,
    #[serde(default)]
    pub unread: Vec<String>,
}

impl Shared {
    /// Only names of files not brought in: a notice, nothing to send.
    fn is_notice(&self) -> bool {
        self.title.is_empty() && self.text.is_empty() && self.files.is_empty()
    }
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct SharedFile {
    pub path: String,
    pub mime: Option<String>,
}

/// The latest share waiting for the page: one at a time, a newer one replaces it (as the web app's share target). A
/// newer one that is only a notice joins the waiting share instead, as the page does (`receiveShare` in
/// `incomingShare.ts`): the waiting share's files would be lost for a notice.
#[derive(Default)]
pub struct Incoming(Mutex<Option<Shared>>);

impl Incoming {
    pub fn put(&self, shared: Shared) {
        let mut held = self.0.lock().unwrap();
        match held.as_mut() {
            Some(waiting) if shared.is_notice() => {
                waiting.left_out.extend(shared.left_out);
                waiting.unread.extend(shared.unread);
            }
            _ => *held = Some(shared),
        }
    }

    pub fn take(&self) -> Option<Shared> {
        self.0.lock().unwrap().take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn photo() -> Shared {
        Shared {
            files: vec![SharedFile {
                path: "/cache/shared/1/0/IMG_1.jpg".into(),
                mime: Some("image/jpeg".into()),
            }],
            ..Shared::default()
        }
    }

    fn notice(left_out: &[&str], unread: &[&str]) -> Shared {
        Shared {
            left_out: left_out.iter().map(|name| name.to_string()).collect(),
            unread: unread.iter().map(|name| name.to_string()).collect(),
            ..Shared::default()
        }
    }

    #[test]
    fn a_notice_joins_the_waiting_share_instead_of_replacing_it() {
        let incoming = Incoming::default();
        incoming.put(photo());
        incoming.put(notice(&["VID_1.mp4"], &[]));
        incoming.put(notice(&[], &["DOC_1.pdf"]));
        assert_eq!(
            incoming.take(),
            Some(Shared {
                left_out: vec!["VID_1.mp4".into()],
                unread: vec!["DOC_1.pdf".into()],
                ..photo()
            })
        );
        assert_eq!(incoming.take(), None);
    }

    #[test]
    fn a_notice_alone_waits_and_a_share_with_something_replaces_the_waiting_one() {
        let incoming = Incoming::default();
        incoming.put(notice(&["VID_1.mp4"], &[]));
        assert_eq!(incoming.take(), Some(notice(&["VID_1.mp4"], &[])));

        incoming.put(notice(&["VID_1.mp4"], &[]));
        incoming.put(photo());
        assert_eq!(incoming.take(), Some(photo()));

        incoming.put(photo());
        let text = Shared {
            text: "hello".into(),
            ..Shared::default()
        };
        incoming.put(text.clone());
        assert_eq!(incoming.take(), Some(text));
    }
}
