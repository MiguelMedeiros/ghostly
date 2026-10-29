//! Language models, and the translation runtime that reads them, downloaded to this computer once the person said yes
//! (docs/AUTO-TRANSLATE.md). Only what the pinned lists below name is fetched: each file is checked against its pinned
//! size and SHA-256 as it streams in, into a folder of its own beside the real one, and put in place only once every
//! file of the download matched. A download that did not match leaves nothing behind.
//!
//! The models are Mozilla's, from the CDN Firefox reads them from (`translate_models.json`: the same files and hashes
//! QVAC's registry pins). The runtime comes with the first model, from our own releases.
use crate::translate::{
    self, TranslateState, MODELS_DIR, RUNTIME_DIR, RUNTIME_VERSION, UNKNOWN_PAIR,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::{Manager, State};

pub const NOT_AVAILABLE: &str = "Translation is not available on this computer yet";
pub const DOWNLOAD_FAILED: &str = "The download did not finish";
pub const MISMATCH: &str = "The download did not match its checksum";
pub const REMOVE_FAILED: &str = "The language could not be removed";

/// The runtime's archive for each platform (Node's names: `linux-x64`, `darwin-arm64`, `win32-x64`…): its size and
/// SHA-256. It is a release asset on a tag of its own, at `RUNTIME_URL` with `{version}` and `{platform}` filled in.
/// Empty until `translation-runtime-v0.1.0` is published: its entries are added then, from the `.sha256` files
/// `tools/scripts/prepare-translation-runtime.mjs` writes. A computer with no entry is told translation is not
/// available on it yet.
const RUNTIMES: &[(&str, u64, &str)] = &[];
const RUNTIME_URL: &str = "https://github.com/MiguelMedeiros/ghostly/releases/download/translation-runtime-v{version}/ghostly-translation-runtime-{version}-{platform}.tar.gz";

/// One file to download, and what it must be.
#[derive(Clone, Deserialize)]
pub struct Download {
    name: String,
    url: String,
    size: u64,
    sha256: String,
}

/// This computer's platform, as the runtime's archives are named.
fn platform() -> Option<&'static str> {
    Some(match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "linux-x64",
        ("linux", "aarch64") => "linux-arm64",
        ("macos", "x86_64") => "darwin-x64",
        ("macos", "aarch64") => "darwin-arm64",
        ("windows", "x86_64") => "win32-x64",
        _ => return None,
    })
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairStatus {
    pair: String,
    /// What it takes on disk, which is what it downloads.
    bytes: u64,
    downloaded: bool,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// The runtime is unpacked where `translate_texts` looks.
    runtime: bool,
    /// What the runtime's download is for this computer; none where there is none yet.
    runtime_bytes: Option<u64>,
    /// Every pair the app knows, downloaded or not.
    pairs: Vec<PairStatus>,
}

pub struct ModelsState {
    pairs: BTreeMap<String, Vec<Download>>,
    runtimes: Vec<(String, Download)>,
    /// One download or removal at a time: two answers to the same question wait for each other.
    busy: tokio::sync::Mutex<()>,
    /// Pinned files only come over HTTPS; a test's come from 127.0.0.1.
    https: bool,
    /// The app's data folder, when a test brings its own.
    data: Option<PathBuf>,
}

impl Default for ModelsState {
    fn default() -> Self {
        let runtimes = RUNTIMES
            .iter()
            .map(|&(platform, size, sha256)| {
                let url = RUNTIME_URL
                    .replace("{version}", RUNTIME_VERSION)
                    .replace("{platform}", platform);
                let name = url.rsplit('/').next().unwrap_or_default().to_string();
                let sha256 = sha256.to_string();
                (
                    platform.to_string(),
                    Download {
                        name,
                        url,
                        size,
                        sha256,
                    },
                )
            })
            .collect();
        Self {
            pairs: serde_json::from_str(include_str!("translate_models.json"))
                .expect("translate_models.json"),
            runtimes,
            busy: Default::default(),
            https: true,
            data: None,
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Every file of the pair in `folder`, at its pinned size. Its hash was checked when it came.
fn complete(folder: &Path, files: &[Download]) -> bool {
    files.iter().all(|file| {
        std::fs::metadata(folder.join(&file.name))
            .is_ok_and(|m| m.is_file() && m.len() == file.size)
    })
}

/// `file` into `to`, checked as it comes: never more than its size, and its size and hash once it ended.
async fn fetch(client: &reqwest::Client, file: &Download, to: &Path) -> Result<(), String> {
    let mut response = client
        .get(&file.url)
        .send()
        .await
        .map_err(|_| DOWNLOAD_FAILED)?;
    if !response.status().is_success() {
        return Err(DOWNLOAD_FAILED.into());
    }
    let mut out = std::io::BufWriter::new(std::fs::File::create(to).map_err(|_| DOWNLOAD_FAILED)?);
    let mut hash = Sha256::new();
    let mut got = 0u64;
    while let Some(chunk) = response.chunk().await.map_err(|_| DOWNLOAD_FAILED)? {
        got += chunk.len() as u64;
        if got > file.size {
            return Err(MISMATCH.into());
        }
        hash.update(&chunk);
        out.write_all(&chunk).map_err(|_| DOWNLOAD_FAILED)?;
    }
    out.into_inner()
        .map_err(|_| DOWNLOAD_FAILED)?
        .sync_all()
        .map_err(|_| DOWNLOAD_FAILED)?;
    if got != file.size || hex(&hash.finalize()) != file.sha256 {
        return Err(MISMATCH.into());
    }
    Ok(())
}

/// The runtime's archive unpacked into `into`, its top folder left out, by the system's `tar` (Linux, macOS and
/// Windows 10 and later have one).
async fn unpack(archive: &Path, into: &Path) -> Result<(), String> {
    let mut command = tokio::process::Command::new("tar");
    command
        .arg("-xzf")
        .arg(archive)
        .arg("-C")
        .arg(into)
        .arg("--strip-components=1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    match command.status().await {
        Ok(status) if status.success() => Ok(()),
        _ => Err(DOWNLOAD_FAILED.into()),
    }
}

/// `work` filling the folder `partial`, which then becomes `target`; on any failure, `partial` is removed.
async fn into_place(
    partial: &Path,
    target: &Path,
    work: impl std::future::Future<Output = Result<(), String>>,
) -> Result<(), String> {
    let _ = std::fs::remove_dir_all(partial);
    let result = async {
        std::fs::create_dir_all(partial).map_err(|_| DOWNLOAD_FAILED)?;
        work.await?;
        let _ = std::fs::remove_dir_all(target);
        std::fs::rename(partial, target).map_err(|_| DOWNLOAD_FAILED.to_string())
    }
    .await;
    if result.is_err() {
        let _ = std::fs::remove_dir_all(partial);
    }
    result
}

impl ModelsState {
    fn status(&self, data: &Path) -> Status {
        let runtime = platform().and_then(|platform| self.runtime_for(platform));
        Status {
            runtime: translate::installed(data).is_ok(),
            runtime_bytes: runtime.map(|archive| archive.size),
            pairs: self
                .pairs
                .iter()
                .map(|(pair, files)| PairStatus {
                    pair: pair.clone(),
                    bytes: files.iter().map(|file| file.size).sum(),
                    downloaded: complete(&data.join(MODELS_DIR).join(pair), files),
                })
                .collect(),
        }
    }

    fn runtime_for(&self, platform: &str) -> Option<&Download> {
        self.runtimes
            .iter()
            .find(|(name, _)| name == platform)
            .map(|(_, archive)| archive)
    }

    fn client(&self) -> Result<reqwest::Client, String> {
        reqwest::Client::builder()
            .https_only(self.https)
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(30))
            .build()
            .map_err(|_| DOWNLOAD_FAILED.into())
    }

    async fn download(&self, data: &Path, pair: &str) -> Result<(), String> {
        let files = self.pairs.get(pair).ok_or(UNKNOWN_PAIR)?;
        let _busy = self.busy.lock().await;
        let target = data.join(MODELS_DIR).join(pair);
        let runtime = translate::installed(data).is_ok();
        if runtime && complete(&target, files) {
            return Ok(());
        }
        let client = self.client()?;
        // The runtime first: a model is no use without it, and a computer without one downloads nothing.
        if !runtime {
            let archive = platform()
                .and_then(|platform| self.runtime_for(platform))
                .ok_or(NOT_AVAILABLE)?;
            let root = data.join(RUNTIME_DIR);
            let file = root.join(format!(".{RUNTIME_VERSION}.tar.gz"));
            let partial = root.join(format!(".{RUNTIME_VERSION}.partial"));
            let result = into_place(&partial, &root.join(RUNTIME_VERSION), async {
                fetch(&client, archive, &file).await?;
                unpack(&file, &partial).await
            })
            .await;
            let _ = std::fs::remove_file(&file);
            result?;
            translate::installed(data)?;
        }
        if complete(&target, files) {
            return Ok(());
        }
        let partial = data.join(MODELS_DIR).join(format!(".{pair}.partial"));
        into_place(&partial, &target, async {
            for file in files {
                fetch(&client, file, &partial.join(&file.name)).await?;
            }
            Ok(())
        })
        .await
    }

    /// The pair's folder removed, after the runtime that may have its files open was asked to leave.
    async fn remove(
        &self,
        translate: &TranslateState,
        data: &Path,
        pair: &str,
    ) -> Result<(), String> {
        if !self.pairs.contains_key(pair) {
            return Err(UNKNOWN_PAIR.into());
        }
        let _busy = self.busy.lock().await;
        translate.stop_now().await;
        match std::fs::remove_dir_all(data.join(MODELS_DIR).join(pair)) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(REMOVE_FAILED.into()),
            _ => Ok(()),
        }
    }

    fn data<R: tauri::Runtime>(&self, app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
        match &self.data {
            Some(data) => Ok(data.clone()),
            None => app
                .path()
                .app_data_dir()
                .map_err(|_| translate::NOT_INSTALLED.into()),
        }
    }
}

/// Whether the runtime is unpacked, what it would download, and every pair the app knows with its size.
#[tauri::command]
pub async fn translation_status<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, ModelsState>,
) -> Result<Status, String> {
    Ok(state.status(&state.data(&app)?))
}

/// The pair's model (`<from>-<to>`, one the app knows), and the runtime first when it is not there yet. Errors:
/// `UNKNOWN_PAIR`, `NOT_AVAILABLE`, `DOWNLOAD_FAILED`, `MISMATCH`.
#[tauri::command]
pub async fn translation_download<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, ModelsState>,
    pair: String,
) -> Result<(), String> {
    state.download(&state.data(&app)?, &pair).await
}

/// The pair's model off this computer; none there is fine. Errors: `UNKNOWN_PAIR`, `REMOVE_FAILED`.
#[tauri::command]
pub async fn translation_remove<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, ModelsState>,
    translate: State<'_, TranslateState>,
    pair: String,
) -> Result<(), String> {
    state.remove(&translate, &state.data(&app)?, &pair).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const MOZILLA: &str =
        "https://firefox-settings-attachments.cdn.mozilla.net/main-workspace/translations-models/";

    #[test]
    fn pins_the_fourteen_pairs_to_and_from_english_on_mozillas_cdn() {
        let state = ModelsState::default();
        let mut expected: Vec<String> = ["ar", "es", "fr", "it", "ja", "pt", "zh"]
            .iter()
            .flat_map(|code| [format!("{code}-en"), format!("en-{code}")])
            .collect();
        expected.sort();
        assert_eq!(state.pairs.keys().cloned().collect::<Vec<_>>(), expected);
        for (pair, files) in &state.pairs {
            let code = pair.replace('-', "");
            assert_eq!(files[0].name, format!("model.{code}.intgemm.alphas.bin"));
            assert!((2..=3).contains(&files.len()), "{pair}");
            for file in files {
                assert!(file.url.starts_with(MOZILLA), "{}", file.url);
                assert!(
                    file.name == files[0].name || file.name.ends_with(&format!("vocab.{code}.spm")),
                    "{}",
                    file.name
                );
                assert!(file.size > 500_000, "{}", file.name);
                assert!(
                    file.sha256.len() == 64
                        && file
                            .sha256
                            .bytes()
                            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')),
                    "{}",
                    file.name
                );
            }
        }
        // The model the runtime's own test translates "Olá, tudo bem?" with, as QVAC's registry pins it too.
        let model = &state.pairs["pt-en"][0];
        assert_eq!(
            model.sha256,
            "7b854f1ec5a485dd33efd7c1bc01dd7d5a57f566957c5e47722af333f0ce9157"
        );
        assert_eq!(
            model.url,
            format!("{MOZILLA}6a2cb71f-cf08-431a-a4a2-22e450750408.bin")
        );
    }

    #[test]
    fn a_runtime_comes_from_its_own_release_tag() {
        for (platform, archive) in ModelsState::default().runtimes {
            let name = format!("ghostly-translation-runtime-{RUNTIME_VERSION}-{platform}.tar.gz");
            assert_eq!(archive.name, name);
            assert_eq!(archive.url, format!("https://github.com/MiguelMedeiros/ghostly/releases/download/translation-runtime-v{RUNTIME_VERSION}/{name}"));
            assert_eq!(archive.sha256.len(), 64);
        }
    }
}

/// Downloads from a web server on 127.0.0.1, with a runtime archive made here: a `bare` that is a shell script running
/// Node, and a `runtime.mjs` that tags each text with its pair when that pair's folder is there.
#[cfg(all(test, unix))]
mod download_tests {
    use super::*;
    use std::{
        collections::HashMap,
        io::BufRead,
        net::TcpListener,
        sync::{Arc, Mutex},
    };
    use tauri::test::{mock_builder, MockRuntime};

    const FAKE_RUNTIME: &str = r#"
import fs from 'node:fs'
import readline from 'node:readline'
const models = process.argv[2]
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, pair, texts } = JSON.parse(line)
  const answer = fs.existsSync(`${models}/${pair}`)
    ? { id, texts: texts.map(text => `[${pair}] ${text}`) }
    : { id, error: 'Translation model not downloaded' }
  process.stdout.write(JSON.stringify(answer) + '\n')
})
"#;

    /// Each path answered with the bytes put there, or 404; every path asked is noted.
    #[derive(Clone, Default)]
    struct Server {
        origin: String,
        files: Arc<Mutex<HashMap<String, Vec<u8>>>>,
        asked: Arc<Mutex<Vec<String>>>,
    }

    impl Server {
        fn start() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let server = Server {
                origin: format!("http://{}", listener.local_addr().unwrap()),
                ..Default::default()
            };
            let serving = server.clone();
            std::thread::spawn(move || {
                for mut stream in listener.incoming().flatten() {
                    let serving = serving.clone();
                    std::thread::spawn(move || {
                        let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                        let mut line = String::new();
                        reader.read_line(&mut line).unwrap();
                        let path = line.split_whitespace().nth(1).unwrap_or("").to_string();
                        let mut header = String::from("x");
                        while header.trim() != "" {
                            header.clear();
                            if reader.read_line(&mut header).unwrap_or(0) == 0 {
                                break;
                            }
                        }
                        serving.asked.lock().unwrap().push(path.clone());
                        let body = serving.files.lock().unwrap().get(&path).cloned();
                        let (status, body) = match body {
                            Some(body) => ("200 OK", body),
                            None => ("404 Not Found", Vec::new()),
                        };
                        let head = format!(
                            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        );
                        let _ = stream.write_all(head.as_bytes());
                        let _ = stream.write_all(&body);
                    });
                }
            });
            server
        }

        /// `body` served at `path`, pinned as it is.
        fn pin(&self, path: &str, name: &str, body: &[u8]) -> Download {
            self.serve(path, body);
            Download {
                name: name.into(),
                url: format!("{}{path}", self.origin),
                size: body.len() as u64,
                sha256: hex(&Sha256::digest(body)),
            }
        }

        fn serve(&self, path: &str, body: &[u8]) {
            self.files
                .lock()
                .unwrap()
                .insert(path.into(), body.to_vec());
        }

        fn asked(&self) -> Vec<String> {
            self.asked.lock().unwrap().clone()
        }
    }

    fn model(pair: &str) -> Vec<u8> {
        // Bigger than one read, so it streams in chunks.
        pair.bytes().cycle().take(300_000).collect()
    }

    /// The runtime's archive as `prepare-translation-runtime.mjs` makes it: one top folder.
    fn archive(dir: &Path) -> Vec<u8> {
        use std::os::unix::fs::PermissionsExt;
        let top = format!(
            "ghostly-translation-runtime-{RUNTIME_VERSION}-{}",
            platform().unwrap()
        );
        let folder = dir.join("build").join(&top);
        std::fs::create_dir_all(&folder).unwrap();
        let node = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|dir| dir.join("node"))
            .find(|path| path.is_file())
            .expect("node on PATH");
        let bare = folder.join("bare");
        std::fs::write(
            &bare,
            format!("#!/bin/sh\nexec '{}' \"$@\"\n", node.display()),
        )
        .unwrap();
        std::fs::set_permissions(&bare, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(folder.join("runtime.mjs"), FAKE_RUNTIME).unwrap();
        let file = dir.join("runtime.tar.gz");
        assert!(std::process::Command::new("tar")
            .arg("-czf")
            .arg(&file)
            .arg("-C")
            .arg(dir.join("build"))
            .arg(&top)
            .status()
            .unwrap()
            .success());
        let bytes = std::fs::read(&file).unwrap();
        std::fs::remove_dir_all(dir.join("build")).unwrap();
        std::fs::remove_file(file).unwrap();
        bytes
    }

    struct Lab {
        app: tauri::App<MockRuntime>,
        data: PathBuf,
        server: Server,
    }

    /// An app with a data folder of its own, pt-en and en-pt pinned to the server, and a runtime archive for this
    /// computer when `runtime`.
    fn lab(name: &str, runtime: bool) -> Lab {
        let dir = std::env::temp_dir().join(format!(
            "ghostly-translate-models-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let data = dir.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let server = Server::start();
        let pairs = ["pt-en", "en-pt"]
            .map(|pair| {
                let code = pair.replace('-', "");
                let name = format!("model.{code}.intgemm.alphas.bin");
                let vocab = format!("vocab.{code}.spm");
                let files = vec![
                    server.pin(&format!("/{pair}/model"), &name, &model(pair)),
                    server.pin(&format!("/{pair}/vocab"), &vocab, vocab.as_bytes()),
                ];
                (pair.to_string(), files)
            })
            .into();
        let runtimes = if runtime {
            let name = format!("{}.tar.gz", platform().unwrap());
            vec![(
                platform().unwrap().to_string(),
                server.pin("/runtime", &name, &archive(&dir)),
            )]
        } else {
            Vec::new()
        };
        let app = mock_builder()
            .manage(ModelsState {
                pairs,
                runtimes,
                busy: Default::default(),
                https: false,
                data: Some(data.clone()),
            })
            .manage(TranslateState::in_folder(data.clone()))
            .build(tauri::generate_context!(test = true))
            .expect("app");
        Lab { app, data, server }
    }

    impl Lab {
        async fn download(&self, pair: &str) -> Result<(), String> {
            translation_download(self.app.handle().clone(), self.app.state(), pair.into()).await
        }

        async fn remove(&self, pair: &str) -> Result<(), String> {
            translation_remove(
                self.app.handle().clone(),
                self.app.state(),
                self.app.state(),
                pair.into(),
            )
            .await
        }

        async fn status(&self) -> Status {
            translation_status(self.app.handle().clone(), self.app.state())
                .await
                .unwrap()
        }

        async fn translate(&self, pair: &str, text: &str) -> Result<Vec<String>, String> {
            translate::translate_texts(
                self.app.handle().clone(),
                self.app.state(),
                pair.into(),
                vec![text.into()],
            )
            .await
        }

        fn downloaded(&self, pair: &str) -> bool {
            self.data.join(MODELS_DIR).join(pair).exists()
        }

        /// Anything a download left beside the real folders: its partial folders and archive.
        fn leftovers(&self) -> Vec<String> {
            [RUNTIME_DIR, MODELS_DIR]
                .iter()
                .filter_map(|dir| std::fs::read_dir(self.data.join(dir)).ok())
                .flatten()
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .filter(|name| name.starts_with('.'))
                .collect()
        }

        fn install_runtime_by_hand(&self) {
            let root = self.data.join(RUNTIME_DIR).join(RUNTIME_VERSION);
            std::fs::create_dir_all(&root).unwrap();
            std::fs::write(root.join("bare"), b"").unwrap();
            std::fs::write(root.join("runtime.mjs"), b"").unwrap();
        }
    }

    fn pair_status(pair: &str, downloaded: bool) -> PairStatus {
        PairStatus {
            pair: pair.into(),
            bytes: model(pair).len() as u64
                + format!("vocab.{}.spm", pair.replace('-', "")).len() as u64,
            downloaded,
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn downloads_the_runtime_with_the_first_model_and_translates_with_them() {
        let lab = lab("first", true);
        let archive = lab.server.files.lock().unwrap()["/runtime"].len() as u64;
        assert_eq!(
            lab.status().await,
            Status {
                runtime: false,
                runtime_bytes: Some(archive),
                pairs: vec![pair_status("en-pt", false), pair_status("pt-en", false)],
            }
        );
        assert_eq!(
            lab.translate("pt-en", "Olá").await,
            Err(translate::NOT_INSTALLED.into())
        );
        // Asked twice at once (two clicks): one download.
        let (a, b) = tokio::join!(lab.download("pt-en"), lab.download("pt-en"));
        assert_eq!((a, b), (Ok(()), Ok(())));
        assert_eq!(
            lab.server.asked(),
            ["/runtime", "/pt-en/model", "/pt-en/vocab"]
        );
        assert_eq!(
            std::fs::read(
                lab.data
                    .join(MODELS_DIR)
                    .join("pt-en/model.pten.intgemm.alphas.bin")
            )
            .unwrap(),
            model("pt-en")
        );
        assert_eq!(lab.leftovers(), Vec::<String>::new());
        assert_eq!(
            lab.status().await,
            Status {
                runtime: true,
                runtime_bytes: Some(archive),
                pairs: vec![pair_status("en-pt", false), pair_status("pt-en", true)],
            }
        );
        assert_eq!(
            lab.translate("pt-en", "Olá").await,
            Ok(vec!["[pt-en] Olá".to_string()])
        );
        // The next pair comes without the runtime.
        lab.download("en-pt").await.unwrap();
        assert_eq!(lab.server.asked()[3..], ["/en-pt/model", "/en-pt/vocab"]);
        assert_eq!(
            lab.translate("en-pt", "Hi").await,
            Ok(vec!["[en-pt] Hi".to_string()])
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_file_that_does_not_match_its_pin_leaves_nothing_behind() {
        let lab = lab("mismatch", true);
        let vocab = b"vocab.pten.spm";
        let mut tampered = vocab.to_vec();
        tampered[0] ^= 1;
        let cases: [(&str, &[u8], &str); 4] = [
            ("one byte changed", &tampered, MISMATCH),
            ("short", &vocab[..vocab.len() - 1], MISMATCH),
            ("long", b"vocab.pten.spm and more", MISMATCH),
            ("gone", b"", DOWNLOAD_FAILED),
        ];
        for (case, body, error) in cases {
            if body.is_empty() {
                lab.server.files.lock().unwrap().remove("/pt-en/vocab");
            } else {
                lab.server.serve("/pt-en/vocab", body);
            }
            assert_eq!(lab.download("pt-en").await, Err(error.into()), "{case}");
            assert!(!lab.downloaded("pt-en"), "{case}");
            assert_eq!(lab.leftovers(), Vec::<String>::new(), "{case}");
            assert!(!lab.status().await.pairs[1].downloaded, "{case}");
        }
        // The runtime came, checked, before the model failed: it stays.
        assert!(lab.status().await.runtime);
        lab.server.serve("/pt-en/vocab", vocab);
        assert_eq!(lab.download("pt-en").await, Ok(()));
        assert!(lab.downloaded("pt-en"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_runtime_that_does_not_match_is_not_unpacked_and_no_model_comes() {
        let lab = lab("runtime-mismatch", true);
        let mut archive = lab.server.files.lock().unwrap()["/runtime"].clone();
        let last = archive.len() - 1;
        archive[last] ^= 1;
        lab.server.serve("/runtime", &archive);
        assert_eq!(lab.download("pt-en").await, Err(MISMATCH.into()));
        assert_eq!(lab.server.asked(), ["/runtime"]);
        assert!(!lab.data.join(RUNTIME_DIR).join(RUNTIME_VERSION).exists());
        assert!(!lab.downloaded("pt-en"));
        assert_eq!(lab.leftovers(), Vec::<String>::new());
        assert!(!lab.status().await.runtime);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn without_a_runtime_for_this_computer_nothing_is_downloaded() {
        let lab = lab("no-runtime", false);
        assert_eq!(lab.status().await.runtime_bytes, None);
        assert_eq!(lab.download("pt-en").await, Err(NOT_AVAILABLE.into()));
        for pair in ["pt-de", "../pt-en", "", "PT-EN"] {
            assert_eq!(lab.download(pair).await, Err(UNKNOWN_PAIR.into()), "{pair}");
        }
        assert_eq!(lab.server.asked(), Vec::<String>::new());
        assert!(!lab.downloaded("pt-en"));
        // One already there (unpacked by an earlier version of this list) is enough.
        lab.install_runtime_by_hand();
        assert_eq!(lab.download("pt-en").await, Ok(()));
        assert_eq!(lab.server.asked(), ["/pt-en/model", "/pt-en/vocab"]);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn removes_a_pair_after_stopping_the_runtime_that_had_it_open() {
        let lab = lab("remove", true);
        lab.download("pt-en").await.unwrap();
        lab.translate("pt-en", "Olá").await.unwrap();
        let runtime = lab.app.state::<TranslateState>();
        assert!(runtime.running().await);
        assert_eq!(lab.remove("pt-en").await, Ok(()));
        assert!(!runtime.running().await, "the runtime was asked to leave");
        assert!(!lab.downloaded("pt-en"));
        assert!(!lab.status().await.pairs[1].downloaded);
        assert!(lab.status().await.runtime, "the runtime stays");
        assert_eq!(
            lab.translate("pt-en", "Olá").await,
            Err(translate::NO_MODEL.into())
        );
        // Nothing there is fine; a pair the app does not know is not.
        assert_eq!(lab.remove("pt-en").await, Ok(()));
        assert_eq!(lab.remove("../pt-en").await, Err(UNKNOWN_PAIR.into()));
        assert!(lab.data.join(MODELS_DIR).exists());
    }
}
