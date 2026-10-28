//! Texts translated on this computer (docs/AUTO-TRANSLATE.md), by the translation runtime the person downloads with
//! their first language model: `bare runtime.mjs <models folder>` (native/translation), spoken to over private pipes,
//! one JSON line per request. This bridge starts nothing else and fetches nothing: no runtime unpacked is "not
//! installed".
//!
//! One runtime serves the whole app. It starts with the first request, takes them one at a time, and is asked to
//! leave once nobody has asked for anything for a while (its models hold about 245 MB each); the next request starts
//! it again. It leaves with the app too: it ends when its input closes.
//!
//! A message's text goes to the runtime and back to the page, and nowhere else: not in an error, not in the log.
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
};

/// The runtime this app runs (`native/translation/package.json`'s version). Its archive is unpacked into
/// `translation-runtime/<version>/` under the app's data folder, `bare` and `runtime.mjs` at the top; an app that needs
/// another version looks in another folder.
pub const RUNTIME_VERSION: &str = "0.1.0";
const RUNTIME_DIR: &str = "translation-runtime";
/// Beside the runtime, shared by every profile on this computer: `translation-models/<from>-<to>/`.
const MODELS_DIR: &str = "translation-models";

pub const NOT_INSTALLED: &str = "Translation is not installed";
/// The runtime's own words for a pair whose model is not on disk.
pub const NO_MODEL: &str = "Translation model not downloaded";
pub const UNKNOWN_PAIR: &str = "Unknown language pair";
pub const TOO_MUCH: &str = "Too much text at once";
pub const FAILED: &str = "Translation failed";

/// The most texts, and the longest request line, the runtime reads (`protocol.mjs`'s `MAX_TEXTS` and `MAX_LINE`).
const MAX_TEXTS: usize = 64;
const MAX_LINE: usize = 1024 * 1024;
/// The longest answer read: a translation may be longer than its text.
const MAX_ANSWER: u64 = 4 * MAX_LINE as u64;

/// How the runtime starts: the program, the script it runs and the models folder it is given.
struct Program {
    executable: PathBuf,
    script: PathBuf,
    models: PathBuf,
}

/// The runtime unpacked under the app's data folder, or `NOT_INSTALLED`.
fn installed(data: &Path) -> Result<Program, String> {
    let root = data.join(RUNTIME_DIR).join(RUNTIME_VERSION);
    let executable = root.join(if cfg!(windows) { "bare.exe" } else { "bare" });
    let script = root.join("runtime.mjs");
    if !executable.is_file() || !script.is_file() {
        return Err(NOT_INSTALLED.into());
    }
    Ok(Program {
        executable,
        script,
        models: data.join(MODELS_DIR),
    })
}

/// A pair as the runtime takes it: `<from>-<to>`, two different codes of 2 or 3 lowercase letters. Anything else
/// would only be refused there, after starting it.
fn valid_pair(pair: &str) -> bool {
    let code =
        |code: &str| (2..=3).contains(&code.len()) && code.bytes().all(|b| b.is_ascii_lowercase());
    matches!(pair.split_once('-'), Some((from, to)) if code(from) && code(to) && from != to)
}

/// The runtime as it runs.
struct Runtime {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

/// Asked to leave (its input closed: it unloads its models and exits), then made to.
async fn stop(mut runtime: Runtime) {
    drop(runtime.input);
    if tokio::time::timeout(Duration::from_secs(5), runtime.child.wait())
        .await
        .is_err()
    {
        let _ = runtime.child.kill().await;
    }
}

/// One request's answer: the line with its id. Anything else (the runtime gone, a line too long or not JSON, an answer
/// to another request) means it is out of step.
async fn ask(runtime: &mut Runtime, id: u64, line: String) -> Result<Value, ()> {
    runtime
        .input
        .write_all((line + "\n").as_bytes())
        .await
        .map_err(drop)?;
    runtime.input.flush().await.map_err(drop)?;
    let mut answer = Vec::new();
    (&mut runtime.output)
        .take(MAX_ANSWER + 1)
        .read_until(b'\n', &mut answer)
        .await
        .map_err(drop)?;
    if answer.last() != Some(&b'\n') {
        return Err(());
    }
    let value: Value = serde_json::from_slice(&answer).map_err(drop)?;
    if value["id"] != json!(id) {
        return Err(());
    }
    Ok(value)
}

/// The texts of an answer, as many as were asked; or the runtime's error, when it is one the page knows. Nothing else
/// it says reaches the page.
fn answer(value: Value, count: usize) -> Result<Vec<String>, String> {
    if let Some(texts) = value["texts"].as_array() {
        return texts
            .iter()
            .map(|text| text.as_str().map(str::to_string))
            .collect::<Option<Vec<_>>>()
            .filter(|texts| texts.len() == count)
            .ok_or_else(|| FAILED.into());
    }
    match value["error"].as_str() {
        Some(error @ (NO_MODEL | UNKNOWN_PAIR)) => Err(error.into()),
        _ => Err(FAILED.into()),
    }
}

#[derive(Clone)]
pub struct TranslateState {
    runtime: Arc<tokio::sync::Mutex<Option<Runtime>>>,
    /// Requests so far, each one's id: an idle stop goes ahead only if no request came after the one that set it.
    asked: Arc<AtomicU64>,
    spawned: Arc<AtomicU64>,
    /// How long the runtime stays without a request (the design's 5 minutes), and how long one request may take.
    idle: Duration,
    patience: Duration,
    /// The app's data folder, when a test brings its own.
    data: Option<PathBuf>,
}

impl Default for TranslateState {
    fn default() -> Self {
        Self {
            runtime: Default::default(),
            asked: Default::default(),
            spawned: Default::default(),
            idle: Duration::from_secs(5 * 60),
            patience: Duration::from_secs(60),
            data: None,
        }
    }
}

impl TranslateState {
    fn spawn(&self, program: &Program) -> Result<Runtime, String> {
        let mut command = Command::new(&program.executable);
        command
            .arg(&program.script)
            .arg(&program.models)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            // What the engine's libraries say goes nowhere: never into the app's log.
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        // No console window for it.
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        // A runtime that cannot start is one to download again.
        let mut child = command.spawn().map_err(|_| NOT_INSTALLED)?;
        let input = child.stdin.take().ok_or(FAILED)?;
        let output = BufReader::new(child.stdout.take().ok_or(FAILED)?);
        self.spawned.fetch_add(1, Ordering::SeqCst);
        Ok(Runtime {
            child,
            input,
            output,
        })
    }

    async fn translate(
        &self,
        data: &Path,
        pair: &str,
        texts: Vec<String>,
    ) -> Result<Vec<String>, String> {
        if !valid_pair(pair) {
            return Err(UNKNOWN_PAIR.into());
        }
        if texts.len() > MAX_TEXTS {
            return Err(TOO_MUCH.into());
        }
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        // One request at a time, as the runtime answers them: each waits for the one before it.
        let mut slot = self.runtime.lock().await;
        let id = self.asked.fetch_add(1, Ordering::SeqCst) + 1;
        let result = self.run(&mut slot, data, id, pair, texts).await;
        drop(slot);
        self.stop_when_idle(id);
        result
    }

    async fn run(
        &self,
        slot: &mut Option<Runtime>,
        data: &Path,
        id: u64,
        pair: &str,
        texts: Vec<String>,
    ) -> Result<Vec<String>, String> {
        let count = texts.len();
        let line = json!({"id": id, "op": "translate", "pair": pair, "texts": texts}).to_string();
        if line.len() > MAX_LINE {
            return Err(TOO_MUCH.into());
        }
        // One that ended since the last request (killed, crashed) is started again.
        if slot
            .as_mut()
            .is_some_and(|runtime| !matches!(runtime.child.try_wait(), Ok(None)))
        {
            *slot = None;
        }
        if slot.is_none() {
            *slot = Some(self.spawn(&installed(data)?)?);
        }
        let runtime = slot.as_mut().expect("runtime");
        match tokio::time::timeout(self.patience, ask(runtime, id, line)).await {
            Ok(Ok(value)) => answer(value, count),
            // Out of step, or stuck: stopped at once. The next request starts another.
            _ => {
                if let Some(mut runtime) = slot.take() {
                    let _ = runtime.child.start_kill();
                }
                Err(FAILED.into())
            }
        }
    }

    /// Stops the runtime once `idle` has gone by with no request after request `id`.
    fn stop_when_idle(&self, id: u64) {
        let state = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(state.idle).await;
            let mut slot = state.runtime.lock().await;
            if state.asked.load(Ordering::SeqCst) == id {
                if let Some(runtime) = slot.take() {
                    drop(slot);
                    stop(runtime).await;
                }
            }
        });
    }
}

/// `texts` from `<from>-<to>` (ISO 639 codes), in the order given; at most 64 at once. Errors are the runtime's own
/// words, never a text: `NOT_INSTALLED`, `NO_MODEL`, `UNKNOWN_PAIR`, `TOO_MUCH` or `FAILED`.
#[tauri::command]
pub async fn translate_texts<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, TranslateState>,
    pair: String,
    texts: Vec<String>,
) -> Result<Vec<String>, String> {
    let data = match &state.data {
        Some(data) => data.clone(),
        None => app.path().app_data_dir().map_err(|_| NOT_INSTALLED)?,
    };
    state.translate(&data, &pair, texts).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_runtime_version_is_the_one_native_translation_builds() {
        let package: Value =
            serde_json::from_str(include_str!("../../../native/translation/package.json")).unwrap();
        assert_eq!(package["version"], RUNTIME_VERSION);
    }

    /// Only the runtime's own words reach the page, and only the ones it knows; an answer of the wrong shape is a
    /// failure, whatever it carries.
    #[test]
    fn an_answer_is_the_texts_or_a_known_error_and_never_carries_anything_else() {
        assert_eq!(
            answer(json!({"id": 1, "texts": ["a", "b"]}), 2),
            Ok(vec!["a".to_string(), "b".to_string()])
        );
        for (value, error) in [
            (json!({"id": 1, "error": NO_MODEL}), NO_MODEL),
            (json!({"id": 1, "error": UNKNOWN_PAIR}), UNKNOWN_PAIR),
            (
                json!({"id": 1, "error": "could not translate my secret"}),
                FAILED,
            ),
            (json!({"id": 1, "error": 7}), FAILED),
            (json!({"id": 1, "texts": ["a"]}), FAILED),
            (json!({"id": 1, "texts": ["a", 2]}), FAILED),
            (json!({"id": 1, "texts": "a b"}), FAILED),
            (json!({"id": 1}), FAILED),
        ] {
            assert_eq!(answer(value.clone(), 2), Err(error.to_string()), "{value}");
        }
    }
}

/// The real lookup, start, idle stop and restart, with `protocol.mjs` (the runtime's own protocol) over an engine that
/// only tags each text with its pair, run by Node behind a `bare` that is a shell script.
#[cfg(all(test, unix))]
mod runtime_tests {
    use super::*;
    use tauri::test::{mock_builder, MockRuntime};

    /// An engine that tags each text with its pair; `crash` makes the runtime exit, `hang` never answers.
    const FAKE_RUNTIME: &str = r#"
import fs from 'node:fs'
import path from 'node:path'
import { createRuntime, lineReader } from './protocol.mjs'
const open = async ({ from, to }) => ({
  async translate(texts) {
    if (texts.includes('crash')) process.exit(3)
    if (texts.includes('hang')) return new Promise(() => {})
    if (texts.includes('fail')) throw new Error(`could not translate ${texts}`)
    return texts.map(text => `[${from}>${to}] ${text}`)
  },
  async close() {},
})
const exists = file => { try { return fs.statSync(file).isFile() } catch { return false } }
const runtime = createRuntime({ root: process.argv[2], open, exists, join: path.join })
const write = answer => { process.stdout.write(JSON.stringify(answer) + '\n') }
process.stdin.on('data', lineReader(line => { runtime.handle(line).then(write) }, () => { runtime.tooLong().then(write) }))
process.stdin.on('end', () => { runtime.close().finally(() => process.exit(0)) })
"#;

    /// An app data folder of its own, with the runtime unpacked where the app looks and the pt-en model's files.
    fn data(name: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let data =
            std::env::temp_dir().join(format!("ghostly-translate-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        let runtime = data.join(RUNTIME_DIR).join(RUNTIME_VERSION);
        std::fs::create_dir_all(&runtime).unwrap();
        let node = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|dir| dir.join("node"))
            .find(|path| path.is_file())
            .expect("node on PATH");
        let bare = runtime.join("bare");
        std::fs::write(
            &bare,
            format!("#!/bin/sh\nexec '{}' \"$@\"\n", node.display()),
        )
        .unwrap();
        std::fs::set_permissions(&bare, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(runtime.join("runtime.mjs"), FAKE_RUNTIME).unwrap();
        std::fs::copy(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../native/translation/protocol.mjs"),
            runtime.join("protocol.mjs"),
        )
        .unwrap();
        let model = data.join(MODELS_DIR).join("pt-en");
        std::fs::create_dir_all(&model).unwrap();
        for file in ["model.pten.intgemm.alphas.bin", "vocab.pten.spm"] {
            std::fs::write(model.join(file), b"model").unwrap();
        }
        data
    }

    fn app(data: PathBuf, idle: Duration, patience: Duration) -> tauri::App<MockRuntime> {
        mock_builder()
            .manage(TranslateState {
                data: Some(data),
                idle,
                patience,
                ..TranslateState::default()
            })
            .build(tauri::generate_context!(test = true))
            .expect("app")
    }

    async fn translate(
        app: &tauri::App<MockRuntime>,
        pair: &str,
        texts: &[&str],
    ) -> Result<Vec<String>, String> {
        translate_texts(
            app.handle().clone(),
            app.state(),
            pair.into(),
            texts.iter().map(|text| text.to_string()).collect(),
        )
        .await
    }

    async fn pid(app: &tauri::App<MockRuntime>) -> Option<u32> {
        app.state::<TranslateState>()
            .runtime
            .lock()
            .await
            .as_ref()
            .and_then(|r| r.child.id())
    }

    fn spawned(app: &tauri::App<MockRuntime>) -> u64 {
        app.state::<TranslateState>().spawned.load(Ordering::SeqCst)
    }

    /// A process that exited but was not waited for yet is a zombie, which `kill -0` still finds. Node's main thread
    /// shows as one while its other threads are still exiting, and cannot be waited for until they are gone.
    fn alive(pid: u32) -> bool {
        let Ok(status) = std::fs::read_to_string(format!("/proc/{pid}/status")) else {
            return false;
        };
        let field = |name: &str| {
            status
                .lines()
                .find_map(|line| line.strip_prefix(name))
                .map(str::trim)
                .unwrap_or("")
                .to_string()
        };
        !(field("State:").starts_with('Z') && field("Threads:") == "1")
    }

    async fn until(what: &str, mut done: impl FnMut() -> bool) {
        for _ in 0..200 {
            if done() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("{what} did not happen in 10 s");
    }

    const LONG: Duration = Duration::from_secs(60);

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn translates_batches_in_order_through_one_runtime_started_on_first_use() {
        let app = app(data("batches"), LONG, LONG);
        assert_eq!(spawned(&app), 0, "nothing starts with the app");
        assert_eq!(
            translate(&app, "pt-en", &["Olá", "tudo bem?", "🙂 ok"]).await,
            Ok(vec![
                "[pt>en] Olá".to_string(),
                "[pt>en] tudo bem?".into(),
                "[pt>en] 🙂 ok".into()
            ])
        );
        let first = pid(&app).await.expect("running");
        // Requests at once take their turn on the same runtime, each answered with its own texts.
        let (a, b) = tokio::join!(
            translate(&app, "pt-en", &["um"]),
            translate(&app, "pt-en", &["dois", "três"])
        );
        assert_eq!(a, Ok(vec!["[pt>en] um".to_string()]));
        assert_eq!(
            b,
            Ok(vec!["[pt>en] dois".to_string(), "[pt>en] três".into()])
        );
        assert_eq!(pid(&app).await, Some(first));
        assert_eq!(spawned(&app), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn without_the_runtime_unpacked_it_is_not_installed_and_nothing_starts() {
        let data = data("missing");
        let runtime = data.join(RUNTIME_DIR).join(RUNTIME_VERSION);
        let app = app(data.clone(), LONG, LONG);
        std::fs::remove_file(runtime.join("runtime.mjs")).unwrap();
        assert_eq!(
            translate(&app, "pt-en", &["Olá"]).await,
            Err(NOT_INSTALLED.into())
        );
        // Another version's runtime is not this app's.
        std::fs::rename(&runtime, data.join(RUNTIME_DIR).join("0.0.1")).unwrap();
        assert_eq!(
            translate(&app, "pt-en", &["Olá"]).await,
            Err(NOT_INSTALLED.into())
        );
        std::fs::remove_dir_all(&data).unwrap();
        assert_eq!(
            translate(&app, "pt-en", &["Olá"]).await,
            Err(NOT_INSTALLED.into())
        );
        assert_eq!(spawned(&app), 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn refuses_a_bad_pair_or_too_much_text_before_starting_anything() {
        let app = app(data("refuses"), LONG, LONG);
        for pair in [
            "", "pt", "pt-pt", "PT-EN", "pt-en-es", "../x-en", "pt_en", "port-en",
        ] {
            assert_eq!(
                translate(&app, pair, &["Olá"]).await,
                Err(UNKNOWN_PAIR.into()),
                "{pair}"
            );
        }
        assert_eq!(
            translate(&app, "pt-en", &["x"; 65]).await,
            Err(TOO_MUCH.into())
        );
        let long = "x".repeat(1024 * 1024);
        assert_eq!(
            translate(&app, "pt-en", &[&long]).await,
            Err(TOO_MUCH.into())
        );
        assert_eq!(translate(&app, "pt-en", &[]).await, Ok(vec![]));
        assert_eq!(spawned(&app), 0);
        // The most the runtime reads: 64 texts.
        assert_eq!(
            translate(&app, "pt-en", &["x"; 64]).await.unwrap().len(),
            64
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn says_a_model_is_missing_and_never_the_text_it_failed_on() {
        let app = app(data("errors"), LONG, LONG);
        assert_eq!(
            translate(&app, "es-en", &["hola"]).await,
            Err(NO_MODEL.into())
        );
        let error = translate(&app, "pt-en", &["my secret", "fail"])
            .await
            .unwrap_err();
        assert_eq!(error, FAILED);
        // Still the same runtime: an answer it gave is no reason to stop it.
        assert_eq!(spawned(&app), 1);
        assert_eq!(
            translate(&app, "pt-en", &["oi"]).await,
            Ok(vec!["[pt>en] oi".to_string()])
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stops_once_idle_and_starts_again_on_the_next_request() {
        let app = app(data("idle"), Duration::from_millis(600), LONG);
        translate(&app, "pt-en", &["um"]).await.unwrap();
        let first = pid(&app).await.expect("running");
        // A request before the time is up puts the stop off.
        tokio::time::sleep(Duration::from_millis(400)).await;
        translate(&app, "pt-en", &["dois"]).await.unwrap();
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(pid(&app).await, Some(first), "not idle yet");
        until("the idle runtime leaving", || !alive(first)).await;
        assert_eq!(pid(&app).await, None);
        assert_eq!(
            translate(&app, "pt-en", &["três"]).await,
            Ok(vec!["[pt>en] três".to_string()])
        );
        let second = pid(&app).await.expect("running again");
        assert_ne!(second, first);
        assert_eq!(spawned(&app), 2);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_runtime_that_dies_or_hangs_is_replaced_by_the_next_request() {
        let app = app(data("dies"), LONG, Duration::from_secs(2));
        translate(&app, "pt-en", &["um"]).await.unwrap();
        let first = pid(&app).await.unwrap();
        assert_eq!(
            translate(&app, "pt-en", &["crash"]).await,
            Err(FAILED.into())
        );
        until("the crashed runtime gone", || !alive(first)).await;
        assert_eq!(
            translate(&app, "pt-en", &["dois"]).await,
            Ok(vec!["[pt>en] dois".to_string()])
        );
        let second = pid(&app).await.unwrap();
        assert_eq!(
            translate(&app, "pt-en", &["hang"]).await,
            Err(FAILED.into())
        );
        until("the hung runtime stopped", || !alive(second)).await;
        assert_eq!(
            translate(&app, "pt-en", &["três"]).await,
            Ok(vec!["[pt>en] três".to_string()])
        );
        assert_eq!(spawned(&app), 3);
    }

    /// A runtime killed while idle (by the system, by a person) is found gone by the next request, which starts
    /// another rather than failing.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_runtime_killed_between_requests_is_started_again() {
        let app = app(data("killed"), LONG, LONG);
        translate(&app, "pt-en", &["um"]).await.unwrap();
        let first = pid(&app).await.unwrap();
        assert!(std::process::Command::new("kill")
            .args(["-KILL", &first.to_string()])
            .status()
            .unwrap()
            .success());
        until("the killed runtime gone", || !alive(first)).await;
        assert_eq!(
            translate(&app, "pt-en", &["dois"]).await,
            Ok(vec!["[pt>en] dois".to_string()])
        );
        assert_eq!(spawned(&app), 2);
    }

    /// The archive `tools/scripts/prepare-translation-runtime.mjs` built on this host, checked against its `.sha256`
    /// and unpacked where the app looks, on Mozilla's pt-en model (cached by `translationRuntime.test.ts`). Passes
    /// without checking anything where neither was built: CI builds no runtime for the unit tests.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn translates_with_the_runtime_built_on_this_host() {
        use sha2::{Digest, Sha256};
        let platform = match (std::env::consts::OS, std::env::consts::ARCH) {
            ("linux", "x86_64") => "linux-x64",
            ("linux", "aarch64") => "linux-arm64",
            ("macos", "x86_64") => "darwin-x64",
            ("macos", "aarch64") => "darwin-arm64",
            _ => return,
        };
        let dist = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../native/translation/dist");
        let name = format!("ghostly-translation-runtime-{RUNTIME_VERSION}-{platform}.tar.gz");
        let archive = dist.join(&name);
        let models = dist.join("models/pt-en");
        if !archive.is_file() || !models.is_dir() {
            eprintln!("skipped: no {name} or pt-en model in {}", dist.display());
            return;
        }
        let pinned = std::fs::read_to_string(dist.join(format!("{name}.sha256"))).unwrap();
        let digest: String = Sha256::digest(std::fs::read(&archive).unwrap())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        assert_eq!(
            pinned.split_whitespace().collect::<Vec<_>>(),
            [digest.as_str(), name.as_str()]
        );

        let data =
            std::env::temp_dir().join(format!("ghostly-translate-{}-real", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        let runtime = data.join(RUNTIME_DIR).join(RUNTIME_VERSION);
        std::fs::create_dir_all(&runtime).unwrap();
        assert!(std::process::Command::new("tar")
            .arg("-xzf")
            .arg(&archive)
            .arg("-C")
            .arg(&runtime)
            .arg("--strip-components=1")
            .status()
            .unwrap()
            .success());
        let pair = data.join(MODELS_DIR).join("pt-en");
        std::fs::create_dir_all(&pair).unwrap();
        for file in std::fs::read_dir(&models).unwrap() {
            let file = file.unwrap();
            std::fs::copy(file.path(), pair.join(file.file_name())).unwrap();
        }

        let app = app(data.clone(), Duration::from_secs(2), LONG);
        let started = std::time::Instant::now();
        let texts = translate(
            &app,
            "pt-en",
            &[
                "Olá, tudo bem?",
                "Chego aí em 10 minutos, tô preso no trânsito.",
            ],
        )
        .await
        .unwrap();
        eprintln!(
            "{texts:?}: {:?}, the runtime's start and the model's load included",
            started.elapsed()
        );
        let hello = texts[0].to_lowercase();
        assert!(
            ["hey", "hi", "hello"]
                .iter()
                .any(|word| hello.starts_with(word))
                && ["what's up", "how are you"]
                    .iter()
                    .any(|words| hello.contains(words)),
            "{texts:?}"
        );
        assert!(texts[1].contains("10 minutes"), "{texts:?}");
        assert_eq!(
            translate(&app, "en-pt", &["Hi"]).await,
            Err(NO_MODEL.into())
        );
        let first = pid(&app).await.unwrap();
        until("the idle runtime leaving", || !alive(first)).await;
        assert_eq!(pid(&app).await, None);
        std::fs::remove_dir_all(&data).unwrap();
    }
}
