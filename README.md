<div align="center">
  <img src="website/public/favicon.svg" width="96" height="96" alt="Ghostly logo">
  <h1>Ghostly</h1>
  <p>An end-to-end encrypted, peer-to-peer messenger with a wallet and verifiable identities built in.<br>No Ghostly server, no account.</p>
  <p>
    <a href="https://github.com/MiguelMedeiros/ghostly/releases/latest"><img src="https://img.shields.io/github/v/release/MiguelMedeiros/ghostly?label=release" alt="Latest release"></a>
    <a href="LICENSE"><img src="https://img.shields.io/github/license/MiguelMedeiros/ghostly" alt="License: MIT"></a>
    <a href="https://github.com/MiguelMedeiros/ghostly/actions/workflows/ci.yml?query=branch%3Adev"><img src="https://img.shields.io/github/actions/workflow/status/MiguelMedeiros/ghostly/ci.yml?branch=dev&label=CI%20(dev)" alt="CI status on dev"></a>
  </p>
  <p>
    <a href="https://app.ghostly.tools"><img src="https://img.shields.io/badge/Open_in_your_browser-0e7490?style=for-the-badge" alt="Open in your browser"></a>
    <a href="https://github.com/MiguelMedeiros/ghostly/releases/latest"><img src="https://img.shields.io/badge/Download-475569?style=for-the-badge" alt="Download"></a>
    <a href="https://ghostly.tools"><img src="https://img.shields.io/badge/Website-475569?style=for-the-badge" alt="Website"></a>
  </p>
</div>

https://github.com/user-attachments/assets/d660065c-607c-45de-b041-67418fcbda03

<table>
  <tr>
    <td width="50%"><b><a href="docs/CHAT.md">Chat</a></b><br>One invite: a code, link or QR. Replies, edits, reactions, forwards and voice messages.</td>
    <td width="50%"><b><a href="docs/CHAT.md#calls-and-shared-services">Calls</a></b><br>Voice and video calls, peer to peer. Pick your mic, camera and speaker.</td>
  </tr>
  <tr>
    <td width="50%"><b><a href="docs/CHAT.md#files">Files</a></b><br>Any size, resumable, checked by digest. Videos and audio play in the chat.</td>
    <td width="50%"><b><a href="docs/CHAT.md#groups">Groups</a></b><br>Private groups of up to 32 and communities of up to 256, joined by a link.</td>
  </tr>
  <tr>
    <td width="50%"><b><a href="docs/WALLETS.md">Wallets</a></b><br>Cashu, Lightning, Ark, Spark, Fedimint, on-chain and USDT. Pay in a chat. Mainnet is experimental.</td>
    <td width="50%"><b><a href="docs/IDENTITIES.md">Identities</a></b><br>Prove your Nostr, Pubky, domain, PGP, SSH, Bitcoin address or DID. Your contact's app checks it.</td>
  </tr>
  <tr>
    <td width="50%"><b><a href="docs/CHAT.md#calls-and-shared-services">Shared apps</a></b><br>Share a web app on your <code>localhost</code> with a contact, over the chat's live connection.</td>
    <td width="50%"><b><a href="docs/CLI.md">CLI</a> &amp; <a href="docs/AI-AGENTS.md">AI agents</a></b><br>The app's engine without a screen, for bots, scripts and agents.</td>
  </tr>
</table>

**How it works:** two apps meet on the Mainline DHT, then talk peer to peer over WebRTC, Iroh or HyperDHT, with the DHT as the fallback. No Ghostly server in the middle. The protocol: [WISPs](https://ghostly.tools/wisps).

**Docs:** [Installation](docs/INSTALLATION.md) · [Architecture](docs/ARCHITECTURE.md) · [Protocol](docs/PROTOCOL.md) & [WISPs](docs/wisps/README.md) · [Building from source](docs/INSTALLATION.md#build-from-source) · [Testing](docs/TESTING.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [All docs](docs/README.md)

**License:** [MIT](LICENSE). Built by Miguel Medeiros ([GitHub](https://github.com/MiguelMedeiros), [X @_miguelmedeiros](https://x.com/_miguelmedeiros)).
