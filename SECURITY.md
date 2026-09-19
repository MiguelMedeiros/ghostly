# Security Policy

Ghostly carries private conversations, calls, files and money between people. If you find a way to break that, we want to hear about it before anyone else does.

## Reporting a vulnerability

Use either one:

- **[Report a vulnerability](https://github.com/MiguelMedeiros/ghostly/security/advisories/new)** on GitHub — private, and the fix is prepared in a private fork attached to the same advisory.
- Email **[ghostly-sec@miguelmedeiros.com.br](mailto:ghostly-sec@miguelmedeiros.com.br)**, which is only for security reports about Ghostly.

Please **do not** open a public issue, pull request or discussion for a vulnerability. We hold ourselves to the same rule: nothing we have not fixed and released is described in public either.

A useful report says:

- what an attacker can do, and who the attacker is (a linked contact, a relay operator, someone on the network, a web page, someone with the device)
- which client and version: Desktop, Ghostly Browser (extension), [app.ghostly.tools](https://app.ghostly.tools), the CLI, or [ghostly.tools](https://ghostly.tools)
- steps to reproduce, or a proof of concept
- your name or handle if you would like credit

## What happens next

| When | What |
|---|---|
| within 3 days | we confirm we received it |
| within 10 days | we tell you whether we can reproduce it and how serious we think it is |
| as soon as it is fixed | a patch release, and a note in the [changelog](CHANGELOG.md) |
| after users had a chance to update | public disclosure, crediting you unless you prefer otherwise |

We ask that you give us up to 90 days before publishing details, and less when the fix ships sooner. If a vulnerability is being exploited, tell us and we will move faster.

## Scope

In scope:

- the Ghost Protocol as described in [docs/PROTOCOL.md](docs/PROTOCOL.md) and as implemented in `packages/core`
- Ghostly Desktop (`src-tauri`, `src`), Ghostly Browser (`extension`), Ghostly on the web (`web`), the CLI (`cli`)
- the wallet and payments (`packages/browser/src/engine`)
- the sites [ghostly.tools](https://ghostly.tools) and [app.ghostly.tools](https://app.ghostly.tools), and this repository's build and release pipeline

Especially interesting: anything that lets a contact, a relay, a mint or a network attacker read messages, impersonate someone, reach a service or a local address they should not, run code in the app, or take someone's sats.

Out of scope:

- the Pkarr relays, Mainline DHT nodes, STUN/TURN servers and Cashu mints themselves (report those to their operators)
- attacks that need an already compromised device or browser profile
- denial of service by flooding public infrastructure
- missing hardening with no demonstrated impact

## Supported versions

Security fixes go into the latest release. Please update before reporting, and make sure the issue still reproduces there.

## Safe harbor

Research done in good faith, within this policy, on your own accounts and devices, is welcome, and we will not pursue it. Do not access other people's conversations, keys or funds, and stop and tell us if you do so by accident.
