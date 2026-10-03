//! "Keep this computer awake" (WISP 06 § User experience, Profile, Devices): while the person keeps the switch on and
//! this Desktop is the active device of a profile with a standby, or while a handoff runs here, the computer does not
//! go to sleep when it is idle, so a phone can take the profile over while the person is out. The display still sleeps.
//!
//! Each system's own way, and nothing that outlives the app:
//! - macOS: `caffeinate -i -w <this process>`, which also ends by itself when the app does;
//! - Linux: `systemd-inhibit --what=idle:sleep` around `tail --pid=<this process>`, which ends with the app too;
//! - Windows: `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` on a thread kept for it, which the system
//!   lets go of when that thread ends.

use std::sync::Mutex;

/// What holds the computer awake now; none while it may sleep.
static HOLD: Mutex<Option<Hold>> = Mutex::new(None);

/// Keeps the computer from sleeping while idle (`on`), or lets it sleep again. Answers whether it is held now: false
/// where this system offers no way (the switch then says nothing it cannot do).
// Off the main thread: starting a helper waits a moment to see it survive.
#[tauri::command(async)]
pub fn keep_awake(on: bool) -> Result<bool, String> {
    let mut hold = HOLD
        .lock()
        .map_err(|_| "The keep-awake state is unavailable".to_string())?;
    if !on {
        // Dropping it lets go.
        *hold = None;
        return Ok(false);
    }
    if let Some(current) = hold.as_mut() {
        if current.alive() {
            return Ok(true);
        }
    }
    *hold = Hold::start();
    Ok(hold.is_some())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
struct Hold(std::process::Child);

/// How long a helper must keep running after it starts to count as holding the computer awake.
#[cfg(any(target_os = "macos", target_os = "linux"))]
const SURVIVES: std::time::Duration = std::time::Duration::from_millis(300);

/// The first of these paths that exists.
#[cfg(target_os = "linux")]
fn first_present(paths: &[&'static str]) -> Option<&'static str> {
    paths
        .iter()
        .copied()
        .find(|path| std::path::Path::new(path).exists())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl Hold {
    fn start() -> Option<Hold> {
        let pid = std::process::id().to_string();
        #[cfg(target_os = "macos")]
        let child = std::process::Command::new("/usr/bin/caffeinate")
            .args(["-i", "-w", &pid])
            .spawn();
        // Both by their full path: a `PATH` the app inherits is not trusted to find them.
        #[cfg(target_os = "linux")]
        let child = {
            let inhibit = first_present(&["/usr/bin/systemd-inhibit", "/bin/systemd-inhibit"])?;
            let tail = first_present(&["/usr/bin/tail", "/bin/tail"])?;
            std::process::Command::new(inhibit)
                .args([
                    "--what=idle:sleep",
                    "--who=Ghostly",
                    "--why=Keeps this computer awake for a handoff",
                    "--mode=block",
                    tail,
                    &format!("--pid={pid}"),
                    "-f",
                    "/dev/null",
                ])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
        };
        Hold::if_it_survives(child.ok()?)
    }

    /// Held only if the helper is still running a moment later: `systemd-inhibit` exits at once when it may not take
    /// the lock (no logind, a session that refuses it), and the switch must not say it holds then.
    fn if_it_survives(child: std::process::Child) -> Option<Hold> {
        let mut hold = Hold(child);
        std::thread::sleep(SURVIVES);
        hold.alive().then_some(hold)
    }

    /// The helper is still running (it may have been killed from outside).
    fn alive(&mut self) -> bool {
        matches!(self.0.try_wait(), Ok(None))
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl Drop for Hold {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[cfg(windows)]
struct Hold(Option<std::sync::mpsc::Sender<()>>);

#[cfg(windows)]
impl Hold {
    fn start() -> Option<Hold> {
        const ES_CONTINUOUS: u32 = 0x8000_0000;
        const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
        extern "system" {
            fn SetThreadExecutionState(flags: u32) -> u32;
        }
        let (stop, stopped) = std::sync::mpsc::channel::<()>();
        let (ready, held) = std::sync::mpsc::channel::<bool>();
        std::thread::Builder::new()
            .name("keep-awake".into())
            .spawn(move || {
                // SAFETY: a plain Win32 call with flags only; it changes this thread's execution state.
                let ok =
                    unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) } != 0;
                let _ = ready.send(ok);
                if ok {
                    let _ = stopped.recv();
                    // SAFETY: as above; back to the default before the thread ends.
                    unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
                }
            })
            .ok()?;
        held.recv().ok().filter(|ok| *ok).map(|_| Hold(Some(stop)))
    }

    fn alive(&mut self) -> bool {
        self.0.is_some()
    }
}

#[cfg(windows)]
impl Drop for Hold {
    fn drop(&mut self) {
        if let Some(stop) = self.0.take() {
            let _ = stop.send(());
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
struct Hold;

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
impl Hold {
    fn start() -> Option<Hold> {
        None
    }
    fn alive(&mut self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn a_helper_that_exits_at_once_holds_nothing() {
        let gone = std::process::Command::new("true").spawn().unwrap();
        assert!(Hold::if_it_survives(gone).is_none());
        let running = std::process::Command::new("sleep")
            .arg("5")
            .spawn()
            .unwrap();
        let held = Hold::if_it_survives(running);
        assert!(held.is_some());
        // Let go: the helper is ended, not left behind.
        drop(held);
    }

    /// One test: the hold is one for the whole app, so two tests at once would let go of each other's.
    #[test]
    fn holds_until_let_go_and_letting_go_twice_is_quiet() {
        assert_eq!(keep_awake(false), Ok(false));
        assert_eq!(keep_awake(false), Ok(false));
        #[cfg(target_os = "macos")]
        held_by_a_helper_on_macos();
    }

    #[cfg(target_os = "macos")]
    fn held_by_a_helper_on_macos() {
        assert_eq!(keep_awake(true), Ok(true));
        // Asked again: the same helper, still running.
        assert_eq!(keep_awake(true), Ok(true));
        let pid = HOLD
            .lock()
            .unwrap()
            .as_ref()
            .map(|hold| hold.0.id())
            .unwrap();
        assert_eq!(keep_awake(false), Ok(false));
        assert!(HOLD.lock().unwrap().is_none());
        // The helper is gone: no process with its id answers a signal 0.
        let status = std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .unwrap();
        assert!(!status.success());
    }
}
