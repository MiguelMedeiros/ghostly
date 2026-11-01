# Auto-translation in chats (design, not built)

Status: a design and a spike for review. Nothing here ships, and nothing on `dev` changes for users until the design is
approved. The feature then lands slice by slice on an `epic/auto-translate` branch, behind a flag.

## What it does

Two directions, both on the device:

- **Reading (received messages).** A switch in Settings, **Translate messages into <language>**, where <language> is
  the app's language. When translation is on for a chat, a received text message in another language is translated
  and shown in the app's language. The bubble says it was translated, and **Show original** shows the text as it was
  sent. It works the same in 1:1 chats and groups. Your own messages are never translated in this direction.
- **Per chat, both ways.** Each chat (1:1 or group) can be set to **On**, **Off**, or **As in Settings** (the default
  for a chat that never chose). So a chat kept in English on purpose stays untranslated while the setting is on, and a
  chat with an Italian friend is translated while the setting is off. See [Per chat](#per-chat).
- **Writing (what I send), when I ask.** In a chat that has a language of its own, the composer can translate my draft
  into that language. I see the translation before it goes, can edit it, or send the original instead. Nothing is
  sent translated without being shown first, unless I turn on **Translate what I send** for that chat. See
  [Outgoing translation](#outgoing-translation).

Nothing leaves the device: no cloud service, no peer is asked to translate. The only network use is downloading a
language model once, after asking.

Neither direction needs a wire or stored-format change, and so no WISP. Reading is a view of a message the app already
has: the original text stays what is stored, sent on to your other devices, quoted, searched and backed up, and the
translation is a local cache that can be thrown away at any time. Writing produces an ordinary text message: what is
sent is the translated text, exactly as if I had typed it.

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
| Web app / PWA, extension | QVAC does not run here. Firefox's own `bergamot-translator` WebAssembly build (4.96 MB, MPL-2.0) reads the same model files in a Worker, single thread, models in the Origin Private File System. The CSPs already allow `wasm-unsafe-eval` (`apps/web/nginx-headers.conf`, the extension's manifest). Measured in desktop browsers: see [Spike: web app and extension](#spike-web-app-and-extension). | No: later, on desktop browsers first; phones after a phone measurement |

So the first version is Desktop only, behind the flag. Every other client shows nothing new.

## Model download

Each language pair is one model of 35-55 MB (see the table below), downloaded once and kept.

- **Asked first.** Turning the switch on (in Settings, or **On** for one chat) shows what is needed and its size
  ("Portuguese to English and back, 73 MB"), with Download / Not now. Nothing downloads without that answer. A message
  in a language that has no model yet shows a small **Translate (37 MB)** action in the bubble instead of a silent
  download. The first **Translate** in the composer asks the same way for the reverse model it needs ("English to
  Italian, 37 MB").
- **Where:** in the app's data folder, `translation-models/<pair>/` (Desktop: next to the profile, not inside it, so
  every profile on the device shares it and backups never carry it).
- **Checked:** every file against the SHA-256 that QVAC's registry pins (`expectedSize` + `sha256Checksum` per file).
  We ship that list in the app, so the source of the bytes does not have to be trusted.
- **Removable:** Settings lists the downloaded pairs with their sizes and a Remove button each. Turning the switch off
  offers to remove the pairs no chat set to **On** still uses.
- **From where (your call):** the bytes are the same everywhere; what differs is who sees the download.
  1. Mozilla's Firefox CDN over HTTPS (`firefox-settings-attachments.cdn.mozilla.net`, what Firefox itself fetches and
     what the addon's own fetcher uses). Mozilla's CDN sees an IP asking for "pt->en". Desktop only: browsers cannot
     use it (no CORS, and a 406 for any Chrome user agent; see [the web spike](#spike-web-app-and-extension)).
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
- Per chat, the last confident language of what the others write is remembered and used for short messages in that
  chat. It is also the chat's language for [outgoing translation](#outgoing-translation), unless set by hand.
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

## Per chat

Each chat has a translation choice with three values:

| Choice | Received messages in this chat | Stored |
|---|---|---|
| **As in Settings** (default) | Translated when the Settings switch is on | nothing (no key) |
| **On** | Translated, even with the Settings switch off | `"on"` |
| **Off** | Never translated, even with the Settings switch on | `"off"` |

So the Settings switch is only the default for chats that never chose; a chat's own choice always wins. A chat set to
**On** while Settings is off asks for its models the first time, as the Settings switch does.

**The choice is this device's, not synced with the profile.** It is kept beside the chat's mute, pin and read mark
(`lib/chatMute.ts` is the model: a localStorage key under the profile's prefix, `translate_<chat>`, where `<chat>` is
the session id or `group:<id>`), and forgotten with the chat. Why not synced:

- The Settings switch it overrides is this device's too (`ghostly_app_settings`, per profile and device), and so are
  the models. A chat synced to **On** would mean a download question on a device that never asked for it, and nothing
  at all on a client with no runtime (web, Android in v1).
- The app has no synced record for UI preferences today: mute and pins are per device. Syncing this one alone would be
  a new profile record between devices, a contract (and a WISP) for a view setting.
- It matches mute, which people already set per device.

The cost is setting it again on a second Desktop. If per-chat preferences are ever synced, mute and translation move
together.

## Outgoing translation

The reverse direction, on request: my draft translated into the chat's language before I send it.

- **The chat's language** is the language that chat translates from: the last confident language of what the others
  write there (see [Source language](#source-language)), or one I set by hand in the chat's translation menu
  ("Language of this chat: Italian (detected) · Change"). A chat with no confident language yet and none set has no
  outgoing translation, and the composer shows nothing new.
- **Shown before sending.** A **Translate** button in the composer (beside the send button) translates the draft and
  opens a preview above the composer: "Italian" + the translated text, editable, with **Send translation**, **Send
  original** and **Cancel** (back to the draft as typed). Translation runs on press, never on each keystroke. Editing
  the original afterwards marks the preview stale ("Translate again").
- **Translate what I send** (per chat, off by default, in the same menu): the send button translates and sends at once,
  without the preview. Even then it falls back to the preview when the chat's language is not certain (a group with
  several languages, below) or the draft's own language is undetermined. Like the per-chat choice, it is this device's.
- **What the contact receives: only the translated text.** It is an ordinary text message; the original is not sent,
  neither in the message nor as a "translated from" note. Sending the original as well would need a new message field
  (a WISP and a wire change, read only by clients that know it), or would put both texts in the body, which every
  older client would show as one long message. The original is kept on my side only: on this device, beside the
  message, so my bubble says "Translated to Italian · Show original". My other devices get the message as sent (the
  translation), without the line. Whether the contact should be told it was machine-translated is open question 7.
- **Never translated:** a draft already in the chat's language (sent as is), and the parts kept out of received
  translation (code blocks, links, mentions, tokens, invoices). Voice notes, files and pictures are not touched.
- **Editing a sent translated message** edits the sent text (the translation), as typed; it is not retranslated.
- **A group with several languages:** one message has one language; there is no translation per member (that would be
  one message per language, a wire change). The group's language is the language of most of the others' last 20
  confident messages, when it covers at least 60% of them. Below that, the group has no single language: **Translate**
  first asks which one (the group's languages, most used first), and **Translate what I send** always shows the
  preview there. A language set by hand for the group wins over the count.

## UI

- **Settings, Appearance, right under Language** (`pages/Settings.tsx`; a `SETTINGS_INDEX` entry so search finds
  it): **Translate messages into <language>** (off by default), a boolean `translateMessages` in `AppSettings` beside
  `linkPreviews` (`lib/settings.ts`). Its hint says it is the default for chats that have not chosen. Below it: the
  downloaded languages with their sizes, and Remove.
- **In a bubble** (`components/MessageBubble.tsx`, shared by 1:1 chats and groups; received means
  `message.sender === "peer"`): the translated text in place of the `RichText` body, and under it a quiet line
  "Translated from Portuguese · Show original", styled like the existing `EditedMark`. Show original swaps the text in
  place (and back with "Show translation"); it is remembered per message for the session.
- **While translating:** the original shows first, then the translation replaces it (no spinner; 20-50 ms on Desktop).
- **Never translated for reading:** own messages (from any of your devices), system lines, entity cards, and messages
  already in the app's language.
- **Per chat:** the chat's menu (1:1 and group, and the chat's info page) gets **Translation**, a small sheet with the
  three choices ("As in Settings (Off)", "On", "Off"; the first names what Settings says now), the chat's language
  with Change, and **Translate what I send**. A chat set to On or Off shows nothing else in its header; the choice is
  only in the menu.
- **Composer:** the **Translate** button shows in a chat whose translation is on (by its own choice or by Settings) and
  that has a language other than the app's. The preview sits above the composer like the reply preview does, and the
  draft stays in the composer until something is sent.
- **My translated bubble:** "Translated to Italian · Show original" under my message, on the sending device only, in
  the same quiet style.
- **Copy, reply, quote, forward, search:** act on the original text of a received message, and on the sent text (the
  translation) of mine. Copy offers the other text as a second item.
- **Accessibility:** the screen reader reads the translated text, then "translated from Portuguese"; Show original is
  a real button. The composer preview is a labelled region ("Translation to Italian"), announced when it is ready;
  Send translation is the default action, so Enter sends what is shown.
- Both 1:1 chats and groups. In a group with several languages, each received message is detected on its own.

## Cost and limits

Measured on Desktop Linux (see Spike). The pressure is RAM, not CPU:

- **RAM:** about 245 MB per loaded model, plus 62 MB for the runtime. Translating into a non-English app language
  from a third language keeps two models (about 550 MB). So: load on first need, keep at most two models, and unload
  them all after 5 idle minutes. Unloading both models gave back about 60% (617 -> 238 MB); the runtime process then
  exits, which gives back the rest.
- **CPU:** 20-50 ms per message; a cold first message 150-170 ms. A catch-up of 30 messages: 0.6-0.8 s one by one,
  0.3 s with `runBatch`. So arrivals are batched (up to 30 per call), and only the messages on screen (plus the
  next screenful) are translated, never a whole history.
- **The detector:** evaluating its 2 MB dictionary stopped the page about 500 ms in WebKitGTK, so it loads and runs in a
  worker. Each detection is under 1 ms.
- **Long messages:** a 983-character message took 106-120 ms. Above 4 000 characters, the bubble offers
  **Translate** instead of doing it by itself.
- **Battery (phones, later):** not measured. A phone CPU will be slower than this desktop one, and the 250 MB per
  model weighs more on a 4 GB phone than the CPU time does. Android waits for its own spike.
- **Disk:** 35-55 MB per pair, shared by every profile on the device.
- **Outgoing adds the reverse model.** Reading an Italian chat in an English app needs it -> en (37.1 MB); writing back
  in Italian adds en -> it (36.5 MB), 73.6 MB in all. In a Portuguese app both directions pivot through English: it ->
  en and en -> pt to read, pt -> en and en -> it to write, four models and 147.0 MB. The download question names the
  direction it is for, so reading can be downloaded without writing.
- **RAM with both directions:** still at most two models loaded. Reading and writing in the same chat use different
  models, so switching between them unloads one and loads another: 33-48 ms per model from disk, once per switch, not
  per message. A draft translates in 20-50 ms (31-69 ms through a pivot), on press only.

## Privacy and security

- Translation is local. No text is sent anywhere, nothing is logged with the message text.
- The translation cache is local and not synced: each device translates for itself (a device with the switch off sees
  the original). It is not in backups.
- The model is untrusted input to a native library: pinned checksums before load, a fixed list of file names, and the
  sidecar runs with no network access needed (it never fetches; Ghostly downloads and checks the files).
- The sidecar reads message text over stdio only; it is started by the app, not listening on a port.
- A detected language is not shown to the sender and changes nothing on the wire.
- The per-chat choices (On/Off, the chat's language, Translate what I send) are this device's, never synced and never
  sent: the contact cannot tell whether I read their chat translated.
- **Outgoing:** a draft goes to the local sidecar only, when I press Translate (or send, with Translate what I send
  on). Only the translated text is sent. The original never leaves the device, not even to my other devices: it is kept
  beside the sent message on this device, not in backups, and removed with the message (delete, delete for everyone,
  a disappearing message's timer) or the chat. Losing it only loses the Show original line.
- A machine translation goes out under my name. That is why it is shown before sending by default, and why Translate
  what I send is per chat, off by default, and falls back to the preview whenever the target language is uncertain.

## Behind a flag

The UI has no runtime feature-flag system today. The precedent is a build-time variable: `VITE_APPS_TEST` gates the
test apps and is refused in release builds (`apps/web/appsTestFlag.ts`). Proposal: `VITE_TRANSLATE=1`, the same way,
gating the Settings row, the bubble line and the sidecar start. Release builds keep it off until the umbrella PR flips
it. The work also lives on `epic/auto-translate` until then, so `dev` has no user-visible change either way.
Flipped: release.yml sets it on the Desktop build of every tag from `TRANSLATE_FROM` (1.7.0) on; Android, the web
app and the extension still refuse it (`apps/web/translateFlag.ts`).

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

## Spike: web app and extension

Can the web app (and the PWA) and the extension translate received messages without QVAC? Yes, in desktop browsers,
with Firefox's WebAssembly build of Bergamot in a Worker. Nothing of it is in the repo, and `VITE_TRANSLATE` still
refuses the web and extension builds.

How it was measured: headless Chromium 156, Firefox 157 and WebKit 27.2 (WPE, the engine of Safari) on this host
(x86-64, 16 cores), from a local server sending the web app's CSP and `Cross-Origin-Opener-Policy`, and Chromium again
with an unpacked MV3 extension using the extension's CSP. A Worker loads the engine, reads pt->en and en->pt from OPFS,
builds both models and translates 30 short chat messages per direction (the pt->en and en->pt rows of the Desktop
spike are among them). Memory: the WebAssembly heap's size, and the browser's resident memory (all its processes)
before and at the peak. The host was busy at times (load 15-20 on 16 cores); the numbers below are from a quiet run
(load 3), and busy runs were up to 3x slower. Harness and logs are kept outside the repo.

**No phone was measured.** This host has no phone, and Chromium's CPU throttling does not reach a dedicated Worker
(throttled runs were as fast as unthrottled ones), so there is no emulated phone number either. Measuring on a real
Android phone and an iPhone is a follow-up.

### Which build

| | Firefox's build (Remote Settings `translations-wasm` 3.0) | npm `@browsermt/bergamot-translator` 0.4.9 |
|---|---|---|
| Released | 2025-06 (Firefox 141), `bergamot-translator` v0.6.0 | 2022-10, built from v0.4.5 |
| Size | 4.96 MB wasm + 100 KB JS glue, MPL-2.0 | 5.17 MB wasm + 80 KB glue + 31 KB wrapper, MPL-2.0 |
| Threads | none (single thread) | none |
| Reads the current models (Remote Settings `translations-models-v2`) | yes | yes |
| Per message, median (Chromium / Firefox / WebKit) | 20 / 14 / 30 ms | 26 / 14 / 29 ms |
| WebAssembly heap, two models loaded | **338 MB** | **1,056 MB** |

**Firefox's build.** Same speed or better, a third of the memory, and the one Mozilla maintains. Its glue is a single
`loadBergamot(Module)` function; outside Firefox it uses the gemm built into the wasm (Firefox itself has a faster
native one, `WebAssembly.mozIntGemm`, that web pages do not get). Its API differs a little from 0.4.9
(`TranslationModel(from, to, config, model, lex, vocabs, null)`). The wasm and its glue would be pinned files we serve
ourselves (their SHA-256 is in the Remote Settings record), not fetched from Mozilla.

### Numbers (Firefox's build)

pt->en / en->pt, models already in OPFS unless said otherwise:

| | Chromium 156 | Firefox 157 | WebKit 27.2 |
|---|---|---|---|
| Engine start (wasm compile + init) | 9 ms | 26 ms | 16 ms |
| Time to first translation (engine, read pt->en from OPFS, build the model, 1 message) | 314 ms | 315 ms | 328 ms |
| The same, first time ever (models stored to OPFS first, from a local server) | 510 ms | 1,064 ms | 1,445 ms |
| Model read from OPFS + built | 16 + 62 ms | 38 + 52 ms | 22 + 61 ms |
| First message after the model is built | 206 / 136 ms | 182 / 105 ms | 180 / 129 ms |
| Per message, median | 20 / 19 ms | 14 / 13 ms | 30 / 29 ms |
| 30 messages, one by one | 649 / 606 ms | 457 / 410 ms | 968 / 917 ms |
| 30 messages, one batch | 1,336 / 837 ms | 652 / 381 ms | 2,221 / 1,385 ms |
| 983-character message | 327 ms | 158 ms | 507 ms |
| pt -> en -> pt pivot, 10 messages | 972 ms | 443 ms | 1,500 ms |
| WebAssembly heap: engine / one model in use / two | 40 / 196 / 338 MB | the same | the same |
| Browser memory at the peak, two models (above the page alone) | +395 MB | +373 MB | +508 MB |

- **Per message it is as fast as Desktop's native addon** (20-24 ms there) in Chromium and Firefox, and 1.5x slower in
  WebKit. Batching does not help in WebAssembly: 30 messages in one call were slower than one by one in every browser
  (the native addon was twice as fast batched). So the web translates one message per call.
- **Memory is the cost.** A model takes 48 MB of heap once built and 196 MB after its first message (the int8 weights
  are prepared then). The heap never shrinks: unloading a model leaves it allocated. Ending the Worker gives it all
  back (Chromium: 920 MB at the peak, 526 MB a second after `terminate()`, 524 MB before). So: one Worker, at most two
  models, and the Worker ends after 5 idle minutes.
- **The extension** (Chromium, MV3, with the extension's CSP) gave the same numbers as the web page: 308 ms to the
  first translation, 20 / 18 ms per message, the same heap.

### Threads and cross-origin isolation

Neither build has threads, so cross-origin isolation buys nothing today: Chromium with `Cross-Origin-Opener-Policy:
same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`) is `crossOriginIsolated`, and
translates at the same speed (21 / 21 ms per message). Threads would need our own Emscripten build of Bergamot with
pthreads, and at 14-30 ms per chat message there is little to win.

The web app is not cross-origin isolated (`same-origin-allow-popups` is not enough, and there is no COEP;
`SharedArrayBuffer` is undefined). Turning it on would break:

- **Sign-in popups.** Isolation needs `same-origin`, which cuts the app from the windows it opens: the identity
  sign-in popup (`packages/browser/src/proofs/oidc/popup.ts` closes it and reads its answer) and Pubky Passport.
- **Pictures from other sites.** `require-corp` blocks every cross-origin image without a
  `Cross-Origin-Resource-Policy` header: OpenStreetMap tiles send none (Giphy does). `credentialless` would let them
  through, but Safari does not support it.
- **The mini-app runners** (`app-frame.html`, `app-frame-net.html`) and the services bridge would each need the header
  too, inside a sandbox whose policy is a WISP (1200).

The extension could turn it on with two manifest keys (`cross_origin_opener_policy`, `cross_origin_embedder_policy`;
measured: `crossOriginIsolated` becomes true), but for the same zero gain. **Proposal: no isolation, single thread.**

### Models in OPFS

- **Size per pair:** Mozilla serves each file zstd-compressed. pt->en is 24.2 MB to download and 36.2 MB stored
  (`model` 31.6 MB, `lex` 4.6 MB, `vocab` 0.8 MB); en->pt 24.8 MB / 36.3 MB. The other locales' pairs, download size
  X->en / en->X: ar 24.7 / 23.8, es 25.1 / 24.1, fr 25.0 / 24.6, it 25.1 / 25.6, ja 36.0 / 34.9, zh-Hans 36.2 / 36.1
  MB. These are the same models as Desktop's (pt->en: the same three files and sizes, 37.0 MB decompressed); a
  Simplified Chinese model exists (`zh-Hans`), which answers the open script question in [Languages](#languages).
- **No browser can unpack zstd** (`DecompressionStream("zstd")` throws in all three; gzip works everywhere). gzip -9 of
  the same files is 5% bigger (pt->en 25.5 MB). So a mirror serves gzip, and the Worker unpacks it while writing.
- **Not from Mozilla's CDN.** `firefox-settings-attachments.cdn.mozilla.net` sends no `Access-Control-Allow-Origin`,
  so a web page cannot read its files, and it answers **406 to any user agent containing "Chrome"** (Chrome, Edge,
  Android Chrome; Firefox, Safari and curl get 200). An extension with a host permission for it still got the 406. The
  web app and the extension need a Ghostly mirror (option 3 of [Model download](#model-download)): same origin for the
  web app (its CSP already allows `connect-src 'self'`), and `Access-Control-Allow-Origin: *` on it for the extension
  (no new permission). Checksums pinned in the app as on Desktop.
- **Asked first, stored once:** the same question as Desktop. The Worker writes with `createSyncAccessHandle` (in
  every engine, Safari included); storing a 37 MB pair took 130-170 ms in Chromium, 0.6-1.6 s in Firefox and WebKit. In
  Firefox, the first write of a new origin took 3 s once and 42-57 s twice while this host was busy: the progress has
  to cover the store, not only the download. Reading a pair back: 14-47 ms. Two pairs used 73.4 MB of the origin's
  quota.
- **Evicted storage:** OPFS is best-effort. `navigator.storage.persist()` returned false in Chromium and WebKit, and
  Firefox asks the person with a prompt; nothing can be counted on. Firefox also warned that 127.0.0.1 "has been
  classified as a bounce tracker" whose state is purged without a visit. An evicted pair is a `NotFoundError` when the
  Worker opens it, so the app checks the pair (names and sizes) before loading, and goes back to **Translate (24 MB)**
  in the bubble, asking again. Never a silent download.
- **No OPFS at all:** Playwright's WebKit refused `navigator.storage.getDirectory()` in an ephemeral profile
  (`UnknownError`; it worked in a persistent one). Safari's private windows likely behave the same (not checked). Where
  OPFS is missing, translation is not offered.

### The service worker

Nothing needs to be precached:

- the wasm is already left out (`precacheList` drops every `.wasm`); fetched once on the first translation, the
  worker's `asset` route then keeps it, as it does the wallets' wasm;
- the engine's Worker and its glue (100 KB) must be left out by name, as the detector's worker is today
  (`/assets/translateDetector.worker-`), or the build would precache them for everyone;
- the models are never in the worker's cache: they come from the mirror into OPFS.

### Recommendation

**Build it, for the web app and the extension in desktop browsers, after Desktop**, reusing Desktop's slices (the
detector, the Settings switch, the bubble, per chat) with a second runtime behind the same `translate_texts` shape:

- Firefox's `bergamot-translator` wasm 3.0 and its glue, pinned and served from our own `/assets/`;
- one dedicated Worker, single thread, no cross-origin isolation; one message per call; at most two models; the Worker
  ends after 5 idle minutes;
- models from a Ghostly mirror, gzip, pinned SHA-256, asked first, stored in OPFS, asked again when evicted; not
  offered where there is no OPFS;
- nothing added to the precache.

**Not on phones yet** (the PWA on Android and iOS): 196-338 MB of WebAssembly heap in a tab, not measured on a phone,
where a tab has less memory to spend. A measurement on a real Android phone and an iPhone decides; until then phones
show nothing new. The model license check (separate) applies here too, and so does the mirror's cost.

## Open questions for review

1. Desktop only first (Bare sidecar, addon direct), CLI next, Android and browsers after their own spikes: OK?
2. Model source: Mozilla's CDN (proposal), a Ghostly mirror, or the QVAC registry over Hyperswarm?
3. The trimmed fabric: if the CPU-only fabric cannot be cut down, is about 470 MB more in the unpacked Desktop app acceptable,
   or should the sidecar itself be an optional download, fetched with the first model?
4. New dependencies: `@qvac/translation-nmtcpp` and `bare-runtime` in a new `native/translation` package (Apache-2.0,
   both from Tether/Holepunch), and `@qvac/langdetect-text` (+ `tinyld`, MIT) in the UI. OK to add?
5. Default off, opt-in per device (proposal), or on with the first-download question?
6. "Don't translate this chat" in v1, or later? **Decided:** in v1, and both ways: each chat is **As in Settings**,
   **On** or **Off**, this device's choice like the Settings switch and mute (see [Per chat](#per-chat)). Outgoing
   translation is in v1 too.
7. Should the contact be told a message was machine-translated? v1 sends nothing (no wire change). Options for later:
   an optional `translatedFrom` field in a WISP, which the contact's bubble shows as "Translated by the sender", or
   nothing ever.
8. The composer's **Translate** button: only in chats whose translation is on (proposal), or in every chat with a
   language other than the app's (someone who reads Italian fine but writes it poorly)?
9. A group's language: most of the others' last 20 messages at 60% or more (proposal), or always ask on the first
   Translate in a group?
10. The originals of my sent translations: device only and not in backups (proposal), or in backups too?
11. Web app and extension: build them after Desktop, in desktop browsers only, with Firefox's wasm and a Ghostly model
    mirror (proposal, see [Spike: web app and extension](#spike-web-app-and-extension))? The mirror is new hosting.

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
| 9 | A chat can be set to translate On, Off or As in Settings, whatever Settings says | apps/ui `lib/chatTranslate.ts` (per-device key, like `chatMute.ts`), chat menu sheet, the bubble's rule, 8 locales | 180 |
| 10 | A chat has a language: remembered from what the others write, or set by hand; a group's from most of its messages | apps/ui `lib/chatLanguage.ts` (pure count + key), the sheet's Change row, 8 locales | 150 |
| 11 | The composer translates a draft into the chat's language and shows it, editable, before sending; or sends the original | apps/ui `Composer` preview (like the reply preview), group language picker, reverse-model download question, 8 locales | 300 |
| 12 | My sent translation keeps its original on this device and shows Show original | apps/ui local originals store (by message id, removed with the message or chat), `MessageBubble.tsx`, 8 locales | 180 |
| 13 | A chat can send translated without the preview (Translate what I send) | apps/ui per-chat key, send path with the fallbacks to the preview, 8 locales | 120 |
| 14 | The CLI adds a translation to received messages when asked | `native/translation` reuse, `packages/cli` (`--translate`, `translation` field) | 200 |

Contracts introduced (all local, none on the wire or in WISPs, each in its own slice):

- The build variable `VITE_TRANSLATE` (slice 1).
- The runtime's stdio protocol: one JSON line per request, `{ id, op: "load" | "translate" | "unload", pair, texts[] }`
  -> `{ id, texts[] }` or `{ id, error }` (slice 3).
- The pinned model list (pair -> file names, sizes, SHA-256) and the models folder `translation-models/<pair>/`
  (slice 5).
- `AppSettings.translateMessages` in `ghostly_app_settings` (slice 6).
- The per-chat keys under the profile's prefix, this device only: `translate_<chat>` = `"on"` | `"off"` (slice 9),
  `translate_lang_<chat>` (a language set by hand, slice 10), `translate_send_<chat>` (slice 13).
- The local originals of sent translations: message id -> `{ to, original }`, on this device, not synced, not in
  backups (slice 12).
- The CLI's `--translate` flag and the optional `translation: { from, text }` field on received messages (slice 14:
  public CLI output). The CLI has no outgoing translation in v1.

Slices 2 and 3 can be built in parallel; 4 needs 3; 5 needs 4; 6 needs 1 and 5; 7 and 8 need 2 and 6; 9 needs 7;
10 needs 2 and 9; 11 needs 5 and 10; 12 and 13 need 11; 14 needs 3. Slice 3 may run over 400 lines if the trimmed ggml fabric (open question 3) needs its own build step; it
would then split into "the runtime package" and "its packaging".
