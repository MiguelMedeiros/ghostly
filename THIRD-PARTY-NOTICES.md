# Third-party notices

Ghostly itself is MIT licensed ([LICENSE](LICENSE)). This file names third-party work that Ghostly ships or downloads
and that asks for credit or a pointer to its source. The npm and Cargo dependencies of the apps carry their own
licenses in their packages.

## Translation (Desktop app)

The Desktop app translates on the computer with a translation runtime it downloads with the first language model
(`native/translation`, built by `tools/scripts/prepare-translation-runtime.mjs`; see
[docs/AUTO-TRANSLATE.md](docs/AUTO-TRANSLATE.md)).

- **Translation models.** The models are the ones Mozilla trained for Firefox Translations
  (https://github.com/mozilla/translations), under the Mozilla Public License 2.0. Ghostly does not redistribute them:
  the app downloads each one from Mozilla's own CDN (`firefox-settings-attachments.cdn.mozilla.net`), the files
  Firefox itself reads, and checks each file against a pinned SHA-256.
- **Bergamot.** The runtime's QVAC addon, `@qvac/translation-nmtcpp` (Apache-2.0, Tether), has the
  `bergamot-translator` engine (MPL-2.0, from the Bergamot project and Mozilla) compiled into it. The source of the fork
  the addon builds is at https://github.com/tetherto/qvac-ext-bergamot-translator, and the original at
  https://github.com/browsermt/bergamot-translator.
- **Bare.** The runtime's `bare` binary is Bare (https://github.com/holepunchto/bare, Apache-2.0, Copyright 2022
  Holepunch Inc). Its LICENSE and NOTICE are in the runtime's archive, under `licenses/bare-runtime/`.
