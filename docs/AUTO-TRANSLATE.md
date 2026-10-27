# Auto-translation of received messages (design, not built)

Status: a design and a spike for review. Nothing here ships, and nothing on `dev` changes for users until the design is
approved. The feature then lands slice by slice on an `epic/auto-translate` branch, behind a flag.

## What it does

A switch in Settings, **Translate messages into <language>**, where <language> is the app's language. When it is on,
a received text message in another language is translated on the device and shown in the app's language. The bubble
says it was translated, and **Show original** shows the text as it was sent. It works the same in 1:1 chats and groups.
Your own messages are never translated.

Nothing leaves the device: no cloud service, no peer is asked to translate. The only network use is downloading a
language model once, after asking.

Auto-translation needs no wire or stored-format change, and so no WISP: it is a view of a message the app already
has. The original text stays what is stored, sent on to your other devices, quoted, searched and backed up. The
translation is a local cache that can be thrown away at any time.

## The engine

QVAC (Tether's local AI SDK, `@qvac/sdk`) translates with its NMT plugin, `@qvac/translation-nmtcpp`. For the
languages Ghostly has, the plugin runs **Bergamot**, the Marian models Mozilla trained for Firefox Translations
(the addon is Apache-2.0; the weights are Mozilla's, and their license is to be checked before we ship them). Bergamot
is CPU only and needs no GPU.

QVAC runs in Node.js (it starts its own Bare worker), in Bare, and in Expo apps. It does not run in a browser.

What the spike found about the two ways to use it (numbers in [Spike](#spike)):

- **`@qvac/sdk`** is the whole AI stack: on Linux x64 its dependency tree is 3.4 GB (llama.cpp, whisper, diffusion,
  ffmpeg...). Even with every other plugin left out (about 1 GB) and a worker that registers only NMT, the worker still
  maps the ggml/Vulkan fabric, RocksDB and the Hyperswarm stack, and idles at about 245 MB before any model loads. Its
  model download goes through the QVAC registry over Hyperswarm (see [Model download](#model-download)).
- **`@qvac/translation-nmtcpp` called directly** under the `bare` runtime: idles at 62 MB, loads a model from local
  files in 33-48 ms, and translates as fast (within a few ms per message). The addon itself is 10-13 MB per platform (prebuilds for
  linux/darwin/win32 x64 and arm64, android-arm64, ios-arm64). The `bare` binary is 97 MB unstripped.

**Proposal:** use the addon directly in a small Bare sidecar we own, not the SDK. The SDK adds 180 MB of idle memory,
a P2P stack we do not want started, and output we had to clean up (its en->pt output carried a `>>por<<` target
token, which the addon alone did not). We keep QVAC's addon, its models and its pinned checksums.

## Which clients get it first

| Client | How it would run | First version? |
|---|---|---|
| Desktop (Linux, macOS, Windows) | A Bare sidecar: `bare` + the nmtcpp prebuild for the platform + a short script speaking JSON over stdio. It is built like today's `native-runtime/` (Node + the HyperDHT sidecar, from `native/transports/hyperdht` by `tools/scripts/prepare-native-runtime.mjs`, this platform's prebuilds only): a sibling `native/translation` package, copied into the bundle's resources. The addon is a Bare addon, not a Node-API one, so the existing Node runtime cannot load it; Rust spawns `bare` on the first translation and stops it after 5 idle minutes. | **Yes** |
| CLI (`packages/cli`, Node) | The same `native/translation` script, started with the `bare` binary from `bare-runtime`. Received messages in `ghostly listen`, `events` and `chat history` get an optional `translation` field (the CLI prints JSON). | Yes, after Desktop |
| Android (Tauri mobile, `apps/desktop/gen/android`) | The android-arm64 prebuild is a Bare addon, so it needs Bare embedded in the app (`react-native-bare-kit` is for React Native, not Tauri), or the Bergamot C++ library built for Android and called from the existing Kotlin plugin (`GhostlyHostPlugin.kt`) through JNI. Both are real work, and RAM is the limit (see Cost). | No: later, after a phone spike |
| Web app / PWA, extension | QVAC does not run here. Firefox's own `bergamot-translator` WebAssembly build (5 MB, MPL-2.0, served by Mozilla's Remote Settings; the npm `@browsermt/bergamot-translator` 0.4.9 is from 2022) reads the same model files in a Worker. The CSPs already allow `wasm-unsafe-eval` (`apps/web/nginx-headers.conf`, the extension's manifest). Models would live in the Origin Private File System. Not measured. | No: a second spike |

So the first version is Desktop only, behind the flag. Every other client shows nothing new.

## Model download

Each language pair is one model of 35-55 MB (see the table below), downloaded once and kept.

- **Asked first.** Turning the switch on shows what is needed and its size ("Portuguese to English and back, 73 MB"),
  with Download / Not now. Nothing downloads without that answer. A message in a language that has no model yet shows a
  small **Translate (37 MB)** action in the bubble instead of a silent download.
- **Where:** in the app's data folder, `translation-models/<pair>/` (Desktop: next to the profile, not inside it, so
  every profile on the device shares it and backups never carry it).
- **Checked:** every file against the SHA-256 that QVAC's registry pins (`expectedSize` + `sha256Checksum` per file).
  We ship that list in the app, so the source of the bytes does not have to be trusted.
- **Removable:** Settings lists the downloaded pairs with their sizes and a Remove button each. Turning the switch off
  offers to remove them all.
- **From where (your call):** the bytes are the same everywhere; what differs is who sees the download.
  1. Mozilla's Firefox CDN over HTTPS (`firefox-settings-attachments.cdn.mozilla.net`, what Firefox itself fetches and
     what the addon's own fetcher uses). Mozilla's CDN sees an IP asking for "pt->en".
  2. The QVAC registry over Hyperswarm (what `@qvac/sdk` does). Any peer seeding the registry sees the IP and the
     blocks asked for; it also starts a DHT node in the app.
  3. A Ghostly mirror (our own CDN or release assets): we see it, nobody else.

  **Proposal:** 1 for the first version, with the pinned checksums, and the download dialog names Mozilla's CDN;
  3 later if we want no third party at all. Not 2: it starts a second P2P stack and announces interest in a language
  to strangers.

## Source language

The source language is detected per message with `@qvac/langdetect-text` (tinyld, MIT, pure JavaScript: it runs in
every client, the browser too). It takes 0.05-1 ms per message. It is unreliable on very short or slangy text: "ok"
is undetermined, "kkkk não acredito 😂" came out as English, "lol no way 😂" as Volapük, "Bom dia" as Portuguese at only
0.18. So:

- No translation when the detector's top language is the app's language, is undetermined, or has a probability under
  0.5; and no translation for messages under 4 letters (after removing emoji, links, mentions and numbers).
- Per chat, the last confident language is remembered and used for short messages in that chat.
- Code blocks, links, mentions, cashu tokens, invoices and other entity cards are never translated; only the text runs
  around them.
- A detected language Bergamot has no model for shows nothing.

## Languages

The app's 8 locales map to Bergamot like this. All 14 pairs to and from English exist and are pinned by QVAC
(downloaded sizes, all files of the pair):

| App language | X -> en | en -> X |
|---|---|---|
| Arabic (ar) | 37.1 MB | 35.6 MB |
| Spanish (es) | 37.0 MB | 36.6 MB |
| French (fr) | 37.2 MB | 36.8 MB |
| Italian (it) | 37.1 MB | 36.5 MB |
| Japanese (ja) | 54.8 MB | 49.6 MB |
| Portuguese (pt) | 37.0 MB | 36.4 MB |
| Chinese (zh) | 54.6 MB | 51.9 MB |

- **Into English:** one model (X -> en).
- **From English:** one model (en -> X).
- **Between two other languages** (Spanish messages for a Portuguese app): there is no direct model, so it pivots
  through English: es -> en, then en -> pt, two models (about 73 MB) chained in one native call.
- **Received languages outside the 8:** 101 pairs exist (German, Russian, Korean, Turkish...); they work the same way
  (pivot when the app is not in English).
- The app's Portuguese is Brazilian (`pt-BR`, `lib/documentLanguage.ts`), but the en -> pt model writes European
  Portuguese at times ("aluguer", "estás"). A Brazilian reader understands it but notices. The app's Chinese is
  Simplified (`zh-CN`); the Bergamot zh models were not tried in the spike, so their script is still to be checked.

## UI

- **Settings, Appearance, right under Language** (`pages/Settings.tsx`; a `SETTINGS_INDEX` entry so search finds
  it): **Translate messages into <language>** (off by default), a boolean `translateMessages` in `AppSettings` beside
  `linkPreviews` (`lib/settings.ts`). Below it: the downloaded languages with their sizes, and Remove.
- **In a bubble** (`components/MessageBubble.tsx`, shared by 1:1 chats and groups; received means
  `message.sender === "peer"`): the translated text in place of the `RichText` body, and under it a quiet line
  "Translated from Portuguese · Show original", styled like the existing `EditedMark`. Show original swaps the text in
  place (and back with "Show translation"); it is remembered per message for the session.
- **While translating:** the original shows first, then the translation replaces it (no spinner; 20-50 ms on Desktop).
- **Never translated:** own messages (from any of your devices), system lines, entity cards, and messages already in
  the app's language.
- **Per chat:** the chat's menu gets "Don't translate this chat" (some chats are deliberately in another language).
- **Copy, reply, quote, forward, search:** act on the original text. Copy offers the translation as a second item.
- **Accessibility:** the screen reader reads the translated text, then "translated from Portuguese"; Show original is
  a real button.
- Both 1:1 chats and groups. In a group with several languages, each message is detected on its own.

## Cost and limits

Measured on Desktop Linux (see Spike). The pressure is RAM, not CPU:

- **RAM:** about 245 MB per loaded model, plus 62 MB for the runtime. Translating into a non-English app language
  from a third language keeps two models (about 550 MB). So: load on first need, keep at most two models, and unload
  them all after 5 idle minutes. Unloading both models gave back about 60% (617 -> 238 MB); the runtime process then
  exits, which gives back the rest.
- **CPU:** 20-50 ms per message; a cold first message 150-170 ms. A catch-up of 30 messages: 0.6-0.8 s one by one,
  0.3 s with `runBatch`. So arrivals are batched (up to 30 per call), and only the messages on screen (plus the
  next screenful) are translated, never a whole history.
- **Long messages:** a 983-character message took 106-120 ms. Above 4 000 characters, the bubble offers
  **Translate** instead of doing it by itself.
- **Battery (phones, later):** not measured. A phone CPU will be slower than this desktop one, and the 250 MB per
  model weighs more on a 4 GB phone than the CPU time does. Android waits for its own spike.
- **Disk:** 35-55 MB per pair, shared by every profile on the device.

## Privacy and security

- Translation is local. No text is sent anywhere, nothing is logged with the message text.
- The translation cache is local and not synced: each device translates for itself (a device with the switch off sees
  the original). It is not in backups.
- The model is untrusted input to a native library: pinned checksums before load, a fixed list of file names, and the
  sidecar runs with no network access needed (it never fetches; Ghostly downloads and checks the files).
- The sidecar reads message text over stdio only; it is started by the app, not listening on a port.
- A detected language is not shown to the sender and changes nothing on the wire.

## Behind a flag

The UI has no runtime feature-flag system today. The precedent is a build-time variable: `VITE_APPS_TEST` gates the
test apps and is refused in release builds (`apps/web/appsTestFlag.ts`). Proposal: `VITE_TRANSLATE=1`, the same way,
gating the Settings row, the bubble line and the sidecar start. Release builds keep it off until the umbrella PR flips
it. The work also lives on `epic/auto-translate` until then, so `dev` has no user-visible change either way.

## Spike

Desktop Linux (this host: Arch, 16 cores, x86-64). `@qvac/sdk` 0.22.0 with `@qvac/translation-nmtcpp` 0.21.1 and
`bare` 1.36.0. Bergamot models pt->en and en->pt from the QVAC registry (2025-12-18). Beam size 1. Scripts and logs
are kept outside the repo; nothing was added to the repo's dependencies.

| | Through `@qvac/sdk` | Addon under `bare` |
|---|---|---|
| Install size (Linux x64) | 3.4 GB full, 1.0 GB with only NMT | `bare` 97 MB + addon 11.8 MB + ggml fabric (see below) |
| Process idle, no model | 245 MB (Bare worker) + the Node client | 62 MB |
| First model load, download included | 7.1 s (37 MB over Hyperswarm) | n/a (files from disk) |
| Model load, cached | 195-977 ms | 33-48 ms |
| RAM per loaded model | about 205 MB | about 245 MB |
| First message after load | 156-171 ms | 151-167 ms |
| Per message, median (pt->en / en->pt) | 22-27 ms / 26-31 ms | 20-24 ms / 26-30 ms |
| 30 messages, one by one | 666-686 ms / 786-840 ms | 593-596 ms / 757-819 ms |
| 30 messages, one batch | n/a | 309-312 ms / 337-341 ms |
| 983-character message | 106-120 ms | n/a |
| pt -> en -> pt pivot, per message | n/a | 31-69 ms (first 287 ms) |
| Disk per pair | 37 MB, plus a registry corestore (37 MB after two pairs) | 37 MB |

Sample output (the same in both paths, except the SDK's `>>por<<` token):

| pt -> en | |
|---|---|
| Chego aí em 10 minutos, tô preso no trânsito. | I'll be there in 10 minutes, I'm stuck in traffic. |
| Amanhã não vai dar, mas sexta-feira eu posso depois das seis. | Tomorrow won't give, but Friday I can after six. |
| Mandei o arquivo no grupo, dá uma olhada quando puder e me fala se precisa mudar alguma coisa antes de enviar pro cliente. | I sent the file in the group, take a look when you can and tell me if you need to change anything before sending it to the client. |

| en -> pt | |
|---|---|
| Hey! How are you? | Ei! Como estás? |
| Tomorrow won't work, but I can do Friday after six. | Amanhã não vai funcionar, mas eu posso fazer sexta-feira depois das seis. |
| lol no way 😂 | lol de jeito nenhum 😂 |

Good on plain sentences, weak on idioms ("não vai dar" -> "won't give") and slang. The pivot doubles the errors
("Oi! Tudo bem?" -> en -> pt "Olá! Olá! Muito bem?").

Other findings:

- The addon loads QVAC's ggml "fabric" (libqvac-ggml-cpu, -vulkan, -rpc) even for Bergamot, which never uses it; its
  Linux prebuild is 364 MB on disk. Shipping it per platform needs a check that a trimmed fabric (CPU backend only)
  still loads, or the sidecar grows by that much. This is the biggest open packaging question.
- The SDK's worker imports every plugin by default; with a missing one it aborts. An NMT-only worker
  (`QVAC_WORKER_PATH`, what `qvac bundle sdk` generates) is needed even on the SDK path.
- Loading a cached model never touches the registry; the files only need to be on disk with their checksums.

## Open questions for review

1. Desktop only first (Bare sidecar, addon direct), CLI next, Android and browsers after their own spikes: OK?
2. Model source: Mozilla's CDN (proposal), a Ghostly mirror, or the QVAC registry over Hyperswarm?
3. The trimmed fabric: if the CPU-only fabric cannot be cut down, is about 470 MB more in the unpacked Desktop app acceptable,
   or should the sidecar itself be an optional download, fetched with the first model?
4. New dependencies: `@qvac/translation-nmtcpp` and `bare-runtime` in a new `native/translation` package (Apache-2.0,
   both from Tether/Holepunch), and `@qvac/langdetect-text` (+ `tinyld`, MIT) in the UI. OK to add?
5. Default off, opt-in per device (proposal), or on with the first-download question?
6. "Don't translate this chat" in v1, or later?

## Slices

For `epic/auto-translate`, once the design is approved. Every slice leaves the epic green, and everything user-visible
is behind `VITE_TRANSLATE`.

| # | Slice | Surface | ~LOC (non-test) |
|---|---|---|---|
| 1 | A `VITE_TRANSLATE` build flag exists and release builds refuse it | apps/web build check (like `appsTestFlag.ts`), apps/ui `translateFlag.ts` | 60 |
| 2 | The app decides which received messages need translating and from which language | apps/ui `lib/translateWhich.ts` (langdetect + the rules above, pure) | 150 |
| 3 | The Desktop bundle carries a Bare translation runtime built like `native-runtime/` | `native/translation` (package + stdio script), `tools/scripts/prepare-translation-runtime.mjs`, `tauri.conf.json` resources | 250 |
| 4 | The Desktop app translates texts through that runtime | apps/desktop `translate.rs` (spawn, idle stop, `translate_texts` command), apps/ui `desktop/translate.ts` | 250 |
| 5 | The Desktop app downloads a language pair after asking, checks its pinned checksums and can remove it | apps/desktop download command + pinned list, apps/ui dialog, 8 locales | 350 |
| 6 | A Settings switch turns translation of received messages on and lists the downloaded languages | apps/ui `settings.ts`, `Settings.tsx`, `settingsSections.ts`, 8 locales | 200 |
| 7 | A received message shows its translation with Show original | apps/ui `MessageBubble.tsx` + translation cache hook, 8 locales | 250 |
| 8 | Arrivals are translated in batches, only for messages on screen | apps/ui hook | 150 |
| 9 | A chat can be set to never translate | apps/ui chat menu, per-chat setting, 8 locales | 120 |
| 10 | The CLI adds a translation to received messages when asked | `native/translation` reuse, `packages/cli` (`--translate`, `translation` field) | 200 |

Contracts introduced (all local, none on the wire or in WISPs, each in its own slice):

- The build variable `VITE_TRANSLATE` (slice 1).
- The runtime's stdio protocol: one JSON line per request, `{ id, op: "load" | "translate" | "unload", pair, texts[] }`
  -> `{ id, texts[] }` or `{ id, error }` (slice 3).
- The pinned model list (pair -> file names, sizes, SHA-256) and the models folder `translation-models/<pair>/`
  (slice 5).
- `AppSettings.translateMessages` in `ghostly_app_settings` (slice 6), and the per-chat opt-out key (slice 9).
- The CLI's `--translate` flag and the optional `translation: { from, text }` field on received messages (slice 10:
  public CLI output).

Slices 2 and 3 can be built in parallel; 4 needs 3; 5 needs 4; 6 needs 1 and 5; 7 and 8 need 2 and 6; 9 needs 7;
10 needs 3. Slice 3 may run over 400 lines if the trimmed ggml fabric (open question 3) needs its own build step; it
would then split into "the runtime package" and "its packaging".
