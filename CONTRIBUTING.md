# Contributing to Ghostly 👻

We welcome all ghosts, ghouls, and developers! Here's how to haunt our codebase.

## Getting started

### Prerequisites

- Node.js 22 (what CI uses)
- Rust (stable)
- The [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your system, to build Desktop

### Setup

```bash
git clone https://github.com/MiguelMedeiros/ghostly.git
cd ghostly
npm install
npm run tauri dev
```

## Branches

- **`dev`** is where work lands: features and fixes branch off it and come back to it in a pull request.
- **`main`** is what was released. It moves only for a release (`dev` merged into it with a merge commit, never a squash) or a hotfix.
- **A hotfix** branches off `main`, is released from there, and `main` is then merged back into `dev`.

Releases: [docs/RELEASING.md](docs/RELEASING.md).

## Commands

| Command | What |
|---|---|
| `npm run dev` | the shared UI in Vite, no Tauri |
| `npm run tauri dev` | the Desktop app (Tauri + Vite) |
| `npm run tauri build` | a Desktop build for production |
| `npm run build:web` | the web app → `web/dist` |
| `npm run build:extension` | the extension → `extension/dist` (load it unpacked in `chrome://extensions`) |
| `npm run lint` / `npm run lint:fix` | ESLint |
| `npm run typecheck` | TypeScript, every workspace |
| `npm run test:affected` | before pushing: only what your change can break (unit, lint, typecheck, Rust; the e2e picked with `--port <n>`) |
| `npm test` | every unit test: `test:packages` (core, browser, sdk, extension) then `test:app` (UI components, matrix, scripts) |
| `npm run test:ui` | only the UI's component tests ([src/test/README.md](src/test/README.md)) |
| `npm run test:map` | every feature in `e2e/features.json` has a test |
| `npm run test:e2e` | end-to-end: real browsers, the web app and the extension ([e2e/README.md](e2e/README.md)) |
| `npm run e2e:full` | end-to-end with the gated suites, on a local Docker stack of regtest services |
| `npm run build && npm run check:desktop-bundle` | Desktop got its Desktop wiring, not a browser stand-in (seconds, runs anywhere) |

The website has its own commands in [website/README.md](website/README.md). The testing guide is [docs/TESTING.md](docs/TESTING.md).

## Project structure

```
ghostly/
├── packages/
│   ├── core/            # The Ghost protocol, shared by every client (TypeScript)
│   ├── browser/         # The Ghostly peer: engine, wallets, storage, the platform layer under the UI
│   ├── react/           # React hooks shared by the clients
│   ├── sdk/             # @ghostly/sdk: adapter contracts for outside authors
│   ├── cli/             # ghostly: the engine on Node for bots (daemon, socket API, events)
│   └── iroh-web/        # Iroh compiled for browsers (relay only)
├── src/                 # The shared React UI (Desktop, web app, extension)
├── src-tauri/           # Desktop's Rust backend
├── native-transports/   # Iroh and HyperDHT for Desktop, the HyperDHT relay for browsers
├── extension/           # Ghostly Browser (Chromium extension, Manifest V3)
├── web/                 # Ghostly on the web (app.ghostly.tools)
├── cli/                 # ghostly-cli (Rust), the compatibility client for v0.4 chats
├── e2e/                 # Playwright end-to-end suites and their Docker stack
├── examples/sdk-adapter # An adapter built outside the app on @ghostly/sdk
├── website/             # ghostly.tools (Next.js)
└── docs/                # Protocol, WISPs, guides
```

## Pull requests

1. Branch off `dev` (or fork, and branch off `dev` there):
   ```bash
   git checkout -b feat/spooky-feature origin/dev
   ```
2. Make your change, **with its tests** (below).
3. Before pushing, run what your change can break:
   ```bash
   npm run test:affected -- --port 50310   # unit, lint, typecheck, Rust, and the e2e tagged with the features you touched
   ```
4. Open the pull request against `dev`. A draft early is fine: CI runs on every push.

CI runs the full lint, typecheck, unit tests, builds and the Rust and Desktop checks on every pull request ([What CI runs](docs/TESTING.md#what-ci-runs)). The app's e2e suites run before every release and nightly, not on pull requests. Run the whole suites yourself only to reproduce a CI failure.

### Tests expected with a feature

- **Unit tests** for the logic (Vitest; Rust `#[cfg(test)]` for `src-tauri` and `cli`).
- **An e2e test** for what a person does or sees (Playwright, `e2e/`).
- **One line in `e2e/features.json`** for a new feature, and each test says what it covers: `{ tag: ["@feature:<id>"] }` in Playwright, `// covers: <id>` in Vitest and Rust. `npm run test:map` fails in CI on a feature with no test that is not on `e2e/allow-untested.json`.

Details: [docs/TESTING.md](docs/TESTING.md).

### Writing docs and site copy

- A change to a WISP (`docs/wisps/`) adds one file to its folder in `docs/wisps/changes/` saying what changed; do not edit a Revision row or a log line. See [WISP 00](docs/wisps/00-process.md#revisions).
- Keep the README short; details go in `docs/`. A new topic gets its own page there and one link from the README.
- No em dashes or en dashes (U+2014, U+2013) in `docs/`, `website/`, this file or `SECURITY.md`: use a period, a comma, a colon or parentheses, and a hyphen or "to" in a range. `npm run lint` in `website/` checks the files the site renders (`scripts/check-dashes.mjs`).
- Short sentences, plain words. Prefer a table or a list to a long paragraph.

## Security

Never open a public issue or pull request about a security flaw before its fix is released. Report it privately through a [GitHub security advisory](https://github.com/MiguelMedeiros/ghostly/security/advisories/new); the fix is prepared in the advisory's private fork. See [SECURITY.md](SECURITY.md).

## Bugs, features and protocol proposals

- **Bugs**: check [Issues](https://github.com/MiguelMedeiros/ghostly/issues) first. Then open one with steps to reproduce, what you expected, what happened, and your OS and app version.
- **Features**: open an issue with the `enhancement` label: the problem, your proposed solution, the alternatives.
- **Protocol proposals**: see the [WISP catalogue](docs/wisps/README.md) and the [process draft](docs/wisps/00-process.md). Keep implemented behavior apart from proposed wire formats, and include security and compatibility analysis and an interoperability plan. Draft status does not mean an integration is shipped.

## Code style

- **TypeScript/React**: follow the existing patterns; functional components.
- **Rust**: `cargo fmt`, and `cargo clippy -- -D warnings` passes.
- **Commits**: clear and descriptive (`feat(wallet): …`, `fix(chat): …`).
- **Comments**: only to explain *why*, not *what*.

---

<p align="center">
  <em>Thanks for helping make Ghostly even spookier! 👻</em>
</p>
