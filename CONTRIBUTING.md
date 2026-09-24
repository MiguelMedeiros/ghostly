# Contributing to Ghostly 👻

We welcome all ghosts, ghouls, and developers! Here's how to haunt our codebase.

## Getting Started

### Prerequisites

- Node.js 18+
- Rust 1.70+
- [Tauri prerequisites](https://tauri.app/v1/guides/getting-started/prerequisites)

### Setup

```bash
# Clone the haunted repository
git clone https://github.com/MiguelMedeiros/ghostly.git
cd ghostly

# Install dependencies
npm install

# Start development
npm run tauri dev
```

## Development Commands

```bash
# Frontend only (Vite)
npm run dev

# Full app (Tauri + Vite)
npm run tauri dev

# Build for production
npm run tauri build

# Run linter
npm run lint

# Fix linter issues
npm run lint:fix

# Type checking
npm run typecheck

# Unit tests: packages/core, packages/browser, packages/sdk, then the UI's component tests
npm test

# Only the component tests of the UI (src/) and @ghostly/react (see src/test/README.md)
npm run test:ui

# Browser extension → extension/dist (load it unpacked in chrome://extensions)
npm run build:extension

# End-to-end: real browsers, the web app and the extension, every feature (see e2e/README.md)
npm run test:e2e

# End-to-end: the bundled Desktop app, through WebDriver (Linux and Windows only)
npm run tauri -- build --debug --no-bundle && npm run test:e2e:desktop

# Desktop got its Desktop wiring and not a browser stand-in — runs anywhere, takes a second
npm run build && npm run check:desktop-bundle
```

## Project Structure

```
ghostly/
├── packages/
│   ├── core/               # The Ghost protocol, shared by every client (TypeScript)
│   └── react/              # React hooks shared by Desktop and Browser
├── extension/              # Ghostly Browser (Chromium extension, Manifest V3)
├── src/                    # Desktop React frontend
│   ├── components/         # UI components
│   ├── hooks/              # React hooks (useChat, etc.)
│   └── pages/              # App pages
├── src-tauri/              # Rust backend
│   └── src/                # Tauri commands & Pkarr integration
├── cli/                    # ghostly-cli source
├── website/                # ghostly.tools website (Next.js)
└── ...
```

## How to Contribute

### Reporting Bugs

1. Check if the issue already exists in [Issues](https://github.com/MiguelMedeiros/ghostly/issues)
2. If not, create a new issue with:
   - Clear title and description
   - Steps to reproduce
   - Expected vs actual behavior
   - Screenshots if applicable
   - Your OS and app version

### Protocol proposals

See the [WISP working catalogue](docs/wisps/README.md) and [process draft](docs/wisps/00-process.md). Clearly separate implemented behavior from proposed wire formats, include security and compatibility analysis, and provide an interoperability plan. Draft status does not mean an integration is shipped.

### Suggesting Features

Open an issue with the `enhancement` label describing:
- The problem you're trying to solve
- Your proposed solution
- Any alternatives you've considered

### Branches

- **`dev`** is where work lands: features and fixes branch off it and come back to it.
- **`main`** is what was released. It moves only for a release (`dev` merged into it with a merge commit, never a squash) or a hotfix.
- **A hotfix** branches off `main`, is released from there, and `main` is then merged back into `dev`.

Security flaws are the exception: never a public issue or pull request for one (see [SECURITY.md](SECURITY.md)).

### Pull Requests

1. **Fork** the repository
2. **Create** your feature branch from `dev`
   ```bash
   git checkout -b feature/spooky-feature origin/dev
   ```
3. **Make** your changes
4. **Test** your changes
   ```bash
   npm run lint
   npm run typecheck
   npm test
   npm run test:map    # every feature in e2e/features.json has a test: docs/TESTING.md
   npm run test:e2e
   npm run check:desktop-bundle
   npm run tauri dev
   ```
5. **Commit** with a clear message
   ```bash
   git commit -m 'Add some spookiness'
   ```
6. **Push** to your branch
   ```bash
   git push origin feature/spooky-feature
   ```
7. **Open** a Pull Request against `dev`

## Code Style

- **TypeScript/React:** Follow existing patterns, use functional components
- **Rust:** Follow standard Rust conventions, run `cargo fmt`
- **Commits:** Use clear, descriptive commit messages
- **Comments:** Only when necessary to explain *why*, not *what*

## Areas to Contribute

- **UI/UX improvements**
- **Performance optimizations**
- **Documentation**
- **Bug fixes**
- **New features**
- **Tests**
- **Translations**

## Questions?

Feel free to open an issue or reach out!

---

<p align="center">
  <em>Thanks for helping make Ghostly even spookier! 👻</em>
</p>
