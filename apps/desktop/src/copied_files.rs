//! Linux: whether the clipboard's file list was put there by a file manager.
//!
//! The list itself is the clipboard's `text/uri-list` target, and that one is anyone's to write: a web page's `copy`
//! handler sets it with `setData("text/uri-list", "file:///…")`, so the list alone says nothing about who copied. A
//! file manager offers a target of its own beside it, under a name a page cannot give a target (a browser keeps a
//! page's other types inside one target of the browser's). Only a clipboard with such a target is read for files.
//! arboard does not say which targets there are, so they are asked for here, from the clipboard arboard reads.

use std::time::{Duration, Instant};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{AtomEnum, ConnectionExt, CreateWindowAux, WindowClass};
use x11rb::protocol::Event;

/// The targets a file manager offers with the files it copied: Nautilus, Nemo, Thunar, PCManFM and COSMIC Files
/// (`gnome-copied-files`), Caja, Dolphin and the other KDE apps, and GTK 4's file list for sandboxed apps (the
/// portal's two).
const FILE_MANAGER_TARGETS: [&str; 6] = [
    "x-special/gnome-copied-files",
    "x-special/mate-copied-files",
    "application/x-kde-cutselection",
    "application/x-kde4-urilist",
    "application/vnd.portal.filetransfer",
    "application/vnd.portal.files",
];

/// How long the clipboard's owner has to say what it offers.
const ANSWER_WITHIN: Duration = Duration::from_secs(2);

/// Whether these targets are a file manager's.
pub fn by_a_file_manager(targets: &[String]) -> bool {
    targets
        .iter()
        .any(|target| FILE_MANAGER_TARGETS.contains(&target.as_str()))
}

/// Whether the clipboard holds files a file manager copied. A clipboard that does not answer holds none.
pub fn on_the_clipboard() -> bool {
    by_a_file_manager(&targets())
}

/// arboard's own choice of clipboard (`platform/linux/mod.rs`): Wayland's when the compositor has data control, the
/// X11 one otherwise. The same here, or the targets of one clipboard would vouch for the list of the other.
fn on_wayland() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some()
        && wl_clipboard_rs::utils::is_primary_selection_supported().is_ok()
}

fn targets() -> Vec<String> {
    if on_wayland() {
        use wl_clipboard_rs::paste::{get_mime_types, ClipboardType, Seat};
        return get_mime_types(ClipboardType::Regular, Seat::Unspecified)
            .map(|types| types.into_iter().collect())
            .unwrap_or_default();
    }
    x11_targets().unwrap_or_default()
}

/// The X11 clipboard's `TARGETS`, by name (ICCCM 2.6.2).
fn x11_targets() -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let (conn, screen) = x11rb::connect(None)?;
    let root = conn.setup().roots[screen].root;
    let window = conn.generate_id()?;
    conn.create_window(
        x11rb::COPY_DEPTH_FROM_PARENT,
        window,
        root,
        0,
        0,
        1,
        1,
        0,
        WindowClass::COPY_FROM_PARENT,
        x11rb::COPY_FROM_PARENT,
        &CreateWindowAux::new(),
    )?;
    let clipboard = conn.intern_atom(false, b"CLIPBOARD")?.reply()?.atom;
    let targets = conn.intern_atom(false, b"TARGETS")?.reply()?.atom;
    let property = conn.intern_atom(false, b"GHOSTLY_TARGETS")?.reply()?.atom;
    conn.convert_selection(window, clipboard, targets, property, x11rb::CURRENT_TIME)?;
    conn.flush()?;
    let asked = Instant::now();
    loop {
        match conn.poll_for_event()? {
            Some(Event::SelectionNotify(answer)) if answer.requestor == window => {
                // No owner, or one that does not say.
                if answer.property == x11rb::NONE {
                    return Ok(Vec::new());
                }
                break;
            }
            Some(_) => {}
            None if asked.elapsed() > ANSWER_WITHIN => return Err("no answer".into()),
            None => std::thread::sleep(Duration::from_millis(2)),
        }
    }
    let answer = conn
        .get_property(true, window, property, AtomEnum::ATOM, 0, 1024)?
        .reply()?;
    let atoms: Vec<u32> = answer.value32().map(Iterator::collect).unwrap_or_default();
    let mut names = Vec::with_capacity(atoms.len());
    for atom in atoms {
        if let Ok(name) = conn.get_atom_name(atom)?.reply() {
            names.push(String::from_utf8_lossy(&name.name).into_owned());
        }
    }
    Ok(names)
}

/// A clipboard owner for the tests that read the real clipboard: under a display of their own only.
#[cfg(test)]
pub mod testing {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc};
    use x11rb::protocol::xproto::{EventMask, PropMode, SelectionNotifyEvent};
    use x11rb::wrapper::ConnectionExt as _;

    /// Holds the clipboard until dropped.
    pub struct Owner {
        gone: Arc<AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl Drop for Owner {
        fn drop(&mut self) {
            self.gone.store(true, Ordering::SeqCst);
            if let Some(thread) = self.thread.take() {
                thread.join().unwrap();
            }
        }
    }

    /// Takes the clipboard and offers exactly these targets, as an app that copied would.
    pub fn own(offered: Vec<(&'static str, Vec<u8>)>) -> Owner {
        let gone = Arc::new(AtomicBool::new(false));
        if on_wayland() {
            use wl_clipboard_rs::copy::{MimeSource, MimeType, Options, Source};
            let sources = offered
                .into_iter()
                .map(|(target, data)| MimeSource {
                    source: Source::Bytes(data.into()),
                    mime_type: MimeType::Specific(target.into()),
                })
                .collect();
            // Served from a thread of wl-clipboard-rs until something else is copied.
            Options::new().copy_multi(sources).expect("wayland copy");
            return Owner { gone, thread: None };
        }
        let (owns, owned) = mpsc::channel();
        let stop = gone.clone();
        let thread = std::thread::spawn(move || serve_x11(offered, owns, stop));
        owned
            .recv_timeout(Duration::from_secs(5))
            .expect("the X11 clipboard was taken");
        Owner {
            gone,
            thread: Some(thread),
        }
    }

    fn serve_x11(
        offered: Vec<(&'static str, Vec<u8>)>,
        owns: mpsc::Sender<()>,
        gone: Arc<AtomicBool>,
    ) {
        let (conn, screen) = x11rb::connect(None).expect("an X display");
        let root = conn.setup().roots[screen].root;
        let window = conn.generate_id().unwrap();
        conn.create_window(
            x11rb::COPY_DEPTH_FROM_PARENT,
            window,
            root,
            0,
            0,
            1,
            1,
            0,
            WindowClass::COPY_FROM_PARENT,
            x11rb::COPY_FROM_PARENT,
            &CreateWindowAux::new(),
        )
        .unwrap();
        let atom = |name: &str| {
            conn.intern_atom(false, name.as_bytes())
                .unwrap()
                .reply()
                .unwrap()
                .atom
        };
        let (clipboard, targets) = (atom("CLIPBOARD"), atom("TARGETS"));
        let offered: Vec<(u32, Vec<u8>)> = offered
            .into_iter()
            .map(|(target, data)| (atom(target), data))
            .collect();
        conn.set_selection_owner(window, clipboard, x11rb::CURRENT_TIME)
            .unwrap();
        let owner = conn
            .get_selection_owner(clipboard)
            .unwrap()
            .reply()
            .unwrap();
        assert_eq!(owner.owner, window);
        owns.send(()).unwrap();
        while !gone.load(Ordering::SeqCst) {
            let Some(event) = conn.poll_for_event().unwrap() else {
                std::thread::sleep(Duration::from_millis(2));
                continue;
            };
            let Event::SelectionRequest(request) = event else {
                continue;
            };
            let mut property = request.property;
            if request.target == targets {
                let mut atoms = vec![targets];
                atoms.extend(offered.iter().map(|(target, _)| *target));
                conn.change_property32(
                    PropMode::REPLACE,
                    request.requestor,
                    property,
                    AtomEnum::ATOM,
                    &atoms,
                )
                .unwrap();
            } else if let Some((target, data)) = offered.iter().find(|(t, _)| *t == request.target)
            {
                conn.change_property8(
                    PropMode::REPLACE,
                    request.requestor,
                    property,
                    *target,
                    data,
                )
                .unwrap();
            } else {
                property = x11rb::NONE;
            }
            let answer = SelectionNotifyEvent {
                response_type: x11rb::protocol::xproto::SELECTION_NOTIFY_EVENT,
                sequence: 0,
                time: request.time,
                requestor: request.requestor,
                selection: request.selection,
                target: request.target,
                property,
            };
            conn.send_event(false, request.requestor, EventMask::NO_EVENT, answer)
                .unwrap();
            conn.flush().unwrap();
        }
    }
}

#[cfg(test)]
mod tests {
    // covers: app.composer.paste-files
    use super::*;

    fn targets(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    #[test]
    fn a_file_list_alone_is_not_a_file_managers() {
        assert!(!by_a_file_manager(&[]));
        assert!(!by_a_file_manager(&targets(&["TARGETS", "text/uri-list"])));
        // What WebKitGTK, Chromium and Firefox put beside a page's own types.
        for browsers in [
            "org.webkitgtk.WebKit.custom-pasteboard-data",
            "chromium/x-web-custom-data",
            "application/x-moz-custom-clipdata",
            "text/x-moz-url",
        ] {
            let offered = targets(&["text/uri-list", "text/plain", "text/html", browsers]);
            assert!(!by_a_file_manager(&offered), "{browsers}");
        }
        // A name that only looks like a file manager's.
        assert!(!by_a_file_manager(&targets(&[
            "text/uri-list",
            "X-SPECIAL/GNOME-COPIED-FILES",
            "x-special/gnome-copied-files ",
            "web x-special/gnome-copied-files",
        ])));
    }

    #[test]
    fn a_file_managers_own_target_beside_the_list_is() {
        // Nautilus (GTK 4), Thunar, Dolphin.
        for offered in [
            &[
                "text/uri-list",
                "x-special/gnome-copied-files",
                "application/vnd.portal.filetransfer",
                "text/plain;charset=utf-8",
            ][..],
            &[
                "x-special/gnome-copied-files",
                "text/uri-list",
                "UTF8_STRING",
            ],
            &[
                "text/uri-list",
                "application/x-kde-cutselection",
                "text/plain",
            ],
        ] {
            assert!(by_a_file_manager(&targets(offered)), "{offered:?}");
        }
        for target in FILE_MANAGER_TARGETS {
            assert!(by_a_file_manager(&targets(&["text/uri-list", target])));
        }
    }
}
