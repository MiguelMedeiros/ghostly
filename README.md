<p align="center">
  <a href="https://ghostly.tools">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/logo-dark.svg">
      <img src="docs/assets/readme/logo-light.svg" alt="Ghostly logo" width="88">
    </picture>
  </a>
</p>

<h1 align="center">Ghostly</h1>

<p align="center">
  An end-to-end encrypted, peer-to-peer messenger with a wallet and verifiable identities built in.<br>
  No Ghostly server, no account.
</p>

<p align="center">
  <a href="https://app.ghostly.tools"><b>Open in your browser</b></a> ·
  <a href="#get-it">Download</a> ·
  <a href="https://ghostly.tools">Website</a> ·
  <a href="docs/README.md">Docs</a> ·
  <a href="https://ghostly.tools/wisps">Protocol</a>
</p>

<p align="center">
  <a href="https://github.com/MiguelMedeiros/ghostly/releases/latest"><img src="https://img.shields.io/github/v/release/MiguelMedeiros/ghostly?label=release" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/MiguelMedeiros/ghostly" alt="License: MIT"></a>
  <a href="https://github.com/MiguelMedeiros/ghostly/actions/workflows/ci.yml?query=branch%3Adev"><img src="https://img.shields.io/github/actions/workflow/status/MiguelMedeiros/ghostly/ci.yml?branch=dev&label=CI%20(dev)" alt="CI status on dev"></a>
</p>

<picture>
  <source media="(max-width: 600px) and (prefers-color-scheme: dark)" srcset="docs/assets/readme/hero-phone-dark.webp">
  <source media="(max-width: 600px)" srcset="docs/assets/readme/hero-phone-light.webp">
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/hero-dark.webp">
  <img src="docs/assets/readme/hero-light.webp" alt="Ghostly on a computer and a phone: a chat with Casper, with a voice message, a photo sent straight from his app and a reply" width="100%">
</picture>

## Features

- <img src="docs/assets/icons/chat.svg" width="20" align="absmiddle" alt=""> **[Chat](docs/CHAT.md)**: one invite, as a code, link or QR. Replies, edits, reactions, forwards, voice messages.
- <img src="docs/assets/icons/calls.svg" width="20" align="absmiddle" alt=""> **[Calls](docs/CHAT.md#calls-and-shared-services)**: voice and video, peer to peer. Pick your mic, camera and speaker.
- <img src="docs/assets/icons/files.svg" width="20" align="absmiddle" alt=""> **[Files](docs/CHAT.md#files)**: any size, resumable, checked by digest. Videos and audio play in the chat.
- <img src="docs/assets/icons/groups.svg" width="20" align="absmiddle" alt=""> **[Groups](docs/CHAT.md#groups)**: private groups of up to 32, communities of up to 256, joined by a link.
- <img src="docs/assets/icons/wallets.svg" width="20" align="absmiddle" alt=""> **[Wallets](docs/WALLETS.md)**: Cashu, Lightning, Ark, Spark, Fedimint, on-chain and USDT. Pay in a chat. Mainnet is experimental.
- <img src="docs/assets/icons/identities.svg" width="20" align="absmiddle" alt=""> **[Identities](docs/IDENTITIES.md)**: prove your Nostr, Pubky, domain, PGP, SSH, Bitcoin address or DID. Your contact's app checks it.
- <img src="docs/assets/icons/shared-apps.svg" width="20" align="absmiddle" alt=""> **[Shared apps](docs/CHAT.md#calls-and-shared-services)**: share a web app on your `localhost` with a contact, over the chat's live connection.
- <img src="docs/assets/icons/cli.svg" width="20" align="absmiddle" alt=""> **[CLI](docs/CLI.md) and [AI agents](docs/AI-AGENTS.md)**: the app's engine without a screen, for bots, scripts and agents.

## See it

https://github.com/user-attachments/assets/38824bb2-0e73-4066-93e2-0850ccd15c2e

<sub>A short narrated intro (it plays on github.com). The site has more: <a href="https://ghostly.tools">ghostly.tools</a>.</sub>

## Get it

- **Web:** open [app.ghostly.tools](https://app.ghostly.tools) in any modern browser. Install it as an app on a computer, Android or iPhone.
- **Desktop:** macOS, Windows and Linux, from the [latest release](https://github.com/MiguelMedeiros/ghostly/releases/latest).
- **Browser extension:** [Chrome Web Store](https://chromewebstore.google.com/detail/ghostly/nbedaagicniejlmfcncndfjcejaidbcf) (Chrome, Brave, Edge), or the zip on the latest release.
- **CLI:** `npm install -g @ghostlytools/cli` (Node 22.12 or newer).

Every platform, step by step: [Installation](docs/INSTALLATION.md).

## How it works

Your app finds your contact's app on a public network, then the two talk directly, encrypted end to end. No Ghostly server sits in the middle, and there is no account to make.

Under the hood: the apps meet on the Mainline DHT, then talk over WebRTC, Iroh or HyperDHT, with the DHT as the fallback. Read the [protocol](docs/PROTOCOL.md) and the [WISPs](docs/wisps/README.md).

## Trust

- Every release has `SHA256SUMS.txt`, signed with GPG key `46A3AC8395F95A6E6D8F1E34819EDEE4673F3EBB` ([how to check a download](docs/INSTALLATION.md#desktop-app)).
- Found a flaw? Report it privately: [SECURITY.md](.github/SECURITY.md).
- The [security review log](docs/SECURITY-REVIEW.md): the threat model, what was fixed and how it was proven, what is still open.

## Docs

[Installation](docs/INSTALLATION.md) · [Build from source](docs/INSTALLATION.md#build-from-source) · [Architecture](docs/ARCHITECTURE.md) · [Testing](docs/TESTING.md) · [Contributing](.github/CONTRIBUTING.md) · [All docs](docs/README.md)

---

<p align="center">Built by <a href="https://github.com/MiguelMedeiros">Miguel Medeiros</a> · <a href="LICENSE">MIT License</a></p>
