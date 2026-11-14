//! The Ghostly window when WebKit ends the web content process of its page (macOS). Tauri's own answer is to load the
//! page again at once, every time: a page whose process ends while it opens (a stored record WebKit refuses to read
//! at every start) then leaves a blank window that blinks for good. Here each reload of a run waits longer than the
//! one before (1 s, 2 s, 4 s), and when the process ends again within `CALM` of the last time, past `MAX_RELOADS`
//! reloads, the person is asked instead: try again, or quit. The windows of contacts' and installed apps keep
//! Tauri's immediate reload.

use std::time::{Duration, Instant};

/// Reloads in a row before the person is asked.
pub const MAX_RELOADS: u32 = 3;
/// A process that ends this long after the last one did starts a new run: the page had been working meanwhile.
pub const CALM: Duration = Duration::from_secs(30);
/// The wait before a run's first reload; each next one waits twice as long.
const FIRST_WAIT: Duration = Duration::from_secs(1);

/// What follows a page whose process ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AfterEnd {
    /// Load the page again after this wait.
    Reload(Duration),
    /// Load nothing: ask the person.
    Ask,
}

/// The run of ends of the window's page, each within `CALM` of the one before. The clock is the caller's.
#[derive(Debug, Default)]
pub struct Reloads {
    last: Option<Instant>,
    run: u32,
}

impl Reloads {
    pub const fn new() -> Self {
        Reloads { last: None, run: 0 }
    }

    /// The page's process ended at `now`.
    pub fn ended(&mut self, now: Instant) -> AfterEnd {
        let in_a_row = self
            .last
            .is_some_and(|last| now.saturating_duration_since(last) < CALM);
        self.run = if in_a_row {
            self.run.saturating_add(1)
        } else {
            1
        };
        self.last = Some(now);
        if self.run > MAX_RELOADS {
            AfterEnd::Ask
        } else {
            AfterEnd::Reload(FIRST_WAIT * (1 << (self.run - 1)))
        }
    }

    /// The person said Try again: a new run starts, from the shortest wait.
    pub fn try_again(&mut self) {
        *self = Reloads::new();
    }
}

/// The dialog's words in one language.
pub struct Words {
    pub title: &'static str,
    pub text: &'static str,
    pub try_again: &'static str,
    pub quit: &'static str,
}

const EN: Words = Words {
    title: "Ghostly could not open",
    text: "The Ghostly window stopped several times in a row while it was opening. You can try again, or quit Ghostly and open it later.",
    try_again: "Try again",
    quit: "Quit Ghostly",
};
const PT: Words = Words {
    title: "O Ghostly não conseguiu abrir",
    text: "A janela do Ghostly parou várias vezes seguidas enquanto abria. Você pode tentar de novo ou sair do Ghostly e abrir mais tarde.",
    try_again: "Tentar de novo",
    quit: "Sair do Ghostly",
};
const ES: Words = Words {
    title: "Ghostly no pudo abrirse",
    text: "La ventana de Ghostly se detuvo varias veces seguidas mientras se abría. Puedes volver a intentarlo, o salir de Ghostly y abrirlo más tarde.",
    try_again: "Volver a intentar",
    quit: "Salir de Ghostly",
};
const FR: Words = Words {
    title: "Ghostly n’a pas pu s’ouvrir",
    text: "La fenêtre de Ghostly s’est arrêtée plusieurs fois de suite pendant son ouverture. Vous pouvez réessayer, ou quitter Ghostly et l’ouvrir plus tard.",
    try_again: "Réessayer",
    quit: "Quitter Ghostly",
};
const IT: Words = Words {
    title: "Ghostly non è riuscito ad aprirsi",
    text: "La finestra di Ghostly si è fermata più volte di seguito durante l’apertura. Puoi riprovare, oppure uscire da Ghostly e aprirlo più tardi.",
    try_again: "Riprova",
    quit: "Esci da Ghostly",
};
const ZH: Words = Words {
    title: "Ghostly 无法打开",
    text: "Ghostly 窗口在打开时连续多次停止。你可以重试，或退出 Ghostly 稍后再打开。",
    try_again: "重试",
    quit: "退出 Ghostly",
};
const JA: Words = Words {
    title: "Ghostly を開けませんでした",
    text: "Ghostly のウィンドウが開く途中で続けて何度も停止しました。もう一度試すか、Ghostly を終了して後で開いてください。",
    try_again: "もう一度試す",
    quit: "Ghostly を終了",
};
const AR: Words = Words {
    title: "تعذّر فتح Ghostly",
    text: "توقفت نافذة Ghostly عدة مرات متتالية أثناء فتحها. يمكنك المحاولة مرة أخرى، أو إنهاء Ghostly وفتحه لاحقًا.",
    try_again: "المحاولة مرة أخرى",
    quit: "إنهاء Ghostly",
};

/// The words for a language tag ("pt-BR", "zh-Hans-CN"): the language decides, and one the app does not have reads as
/// English. The page that would say its own language is the one that is gone, so the tag is the system's.
pub fn words_for(tag: &str) -> &'static Words {
    let language = tag.split(['-', '_']).next().unwrap_or_default();
    match language.to_ascii_lowercase().as_str() {
        "pt" => &PT,
        "es" => &ES,
        "fr" => &FR,
        "it" => &IT,
        "zh" => &ZH,
        "ja" => &JA,
        "ar" => &AR,
        _ => &EN,
    }
}

#[cfg(target_os = "macos")]
pub use macos::ended;

#[cfg(target_os = "macos")]
mod macos {
    use super::{words_for, AfterEnd, Reloads};
    use std::sync::Mutex;
    use std::time::Instant;
    use tauri::{Manager, Runtime, Webview};

    /// The Ghostly window's run of ends, and whether the person is being asked (one dialog, whatever ends meanwhile).
    static MAIN: Mutex<(Reloads, bool)> = Mutex::new((Reloads::new(), false));

    /// The system's first preferred language (`NSLocale.preferredLanguages`), as a tag.
    fn system_language() -> String {
        objc2_foundation::NSLocale::preferredLanguages()
            .firstObject()
            .map(|tag| tag.to_string())
            .unwrap_or_default()
    }

    /// Tauri's hook for a webview whose web content process ended (`Builder::on_web_content_process_terminate`).
    pub fn ended<R: Runtime>(webview: &Webview<R>) {
        if webview.label() != "main" {
            // A contact's or an installed app's window: as Tauri would, at once.
            let _ = webview.reload();
            return;
        }
        let after = {
            let mut state = MAIN.lock().unwrap_or_else(|e| e.into_inner());
            if state.1 {
                return;
            }
            let after = state.0.ended(Instant::now());
            state.1 = after == AfterEnd::Ask;
            after
        };
        crate::diagnostics::log(&format!("web process: the window's page ended; {after:?}"));
        match after {
            AfterEnd::Reload(wait) => {
                let webview = webview.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(wait);
                    let _ = webview.reload();
                });
            }
            AfterEnd::Ask => ask(webview),
        }
    }

    /// Asks the person, in the system's language: Try again loads the page once more, from a new run; Quit ends the app.
    fn ask<R: Runtime>(webview: &Webview<R>) {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
        let words = words_for(&system_language());
        let app = webview.app_handle().clone();
        let mut dialog = app
            .dialog()
            .message(words.text)
            .title(words.title)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                words.try_again.into(),
                words.quit.into(),
            ));
        if let Some(main) = app.get_webview_window("main") {
            dialog = dialog.parent(&main);
        }
        let webview = webview.clone();
        dialog.show(move |again| {
            {
                let mut state = MAIN.lock().unwrap_or_else(|e| e.into_inner());
                state.1 = false;
                if again {
                    state.0.try_again();
                }
            }
            if again {
                crate::diagnostics::log("web process: try again");
                let _ = webview.reload();
            } else {
                crate::diagnostics::log("web process: quit");
                webview.app_handle().exit(0);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: Duration = Duration::from_secs(1);

    #[test]
    fn a_run_of_ends_reloads_three_times_waiting_longer_each_time_then_asks() {
        let mut reloads = Reloads::new();
        let start = Instant::now();
        assert_eq!(reloads.ended(start), AfterEnd::Reload(S));
        assert_eq!(reloads.ended(start + 5 * S), AfterEnd::Reload(2 * S));
        assert_eq!(reloads.ended(start + 12 * S), AfterEnd::Reload(4 * S));
        assert_eq!(reloads.ended(start + 20 * S), AfterEnd::Ask);
        // Asked again while still in the run, never a reload.
        assert_eq!(reloads.ended(start + 21 * S), AfterEnd::Ask);
    }

    #[test]
    fn a_slow_page_that_ends_each_time_is_still_a_run() {
        // 25 s to open and end, each time: a fixed window of 30 s would never hold four ends, and would reload forever.
        let mut reloads = Reloads::new();
        let start = Instant::now();
        let after: Vec<_> = (0..4).map(|i| reloads.ended(start + i * 25 * S)).collect();
        assert_eq!(
            after,
            [
                AfterEnd::Reload(S),
                AfterEnd::Reload(2 * S),
                AfterEnd::Reload(4 * S),
                AfterEnd::Ask
            ]
        );
    }

    #[test]
    fn an_end_after_a_calm_while_starts_a_new_run() {
        let mut reloads = Reloads::new();
        let start = Instant::now();
        reloads.ended(start);
        reloads.ended(start + 2 * S);
        assert_eq!(
            reloads.ended(start + 2 * S + CALM),
            AfterEnd::Reload(S),
            "the page worked for 30 s meanwhile"
        );
        // Ends a day apart are each the first of their run.
        let mut later = start + 2 * S + CALM;
        for _ in 0..10 {
            later += Duration::from_secs(86_400);
            assert_eq!(reloads.ended(later), AfterEnd::Reload(S));
        }
    }

    #[test]
    fn try_again_starts_a_new_run_from_the_shortest_wait() {
        let mut reloads = Reloads::new();
        let start = Instant::now();
        for i in 0..=MAX_RELOADS {
            reloads.ended(start + i * S);
        }
        assert_eq!(reloads.ended(start + 5 * S), AfterEnd::Ask);
        reloads.try_again();
        assert_eq!(reloads.ended(start + 6 * S), AfterEnd::Reload(S));
        assert_eq!(reloads.ended(start + 7 * S), AfterEnd::Reload(2 * S));
    }

    #[test]
    fn a_clock_that_goes_back_counts_as_in_a_row() {
        let mut reloads = Reloads::new();
        let start = Instant::now() + 60 * S;
        reloads.ended(start);
        assert_eq!(reloads.ended(start - 10 * S), AfterEnd::Reload(2 * S));
    }

    #[test]
    fn the_dialog_speaks_the_system_language_and_english_otherwise() {
        assert_eq!(words_for("pt-BR").try_again, "Tentar de novo");
        assert_eq!(words_for("zh-Hans-CN").quit, "退出 Ghostly");
        assert_eq!(words_for("ja_JP").title, "Ghostly を開けませんでした");
        assert_eq!(words_for("de-DE").title, EN.title);
        assert_eq!(words_for("").title, EN.title);
        for tag in ["en", "pt", "es", "fr", "it", "zh", "ja", "ar"] {
            let words = words_for(tag);
            assert!(
                [words.title, words.text, words.try_again, words.quit]
                    .iter()
                    .all(|w| !w.is_empty()),
                "{tag}"
            );
        }
    }
}
