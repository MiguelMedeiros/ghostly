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
git clone https://github.com/MiguelMedeiros/pkarr-chat.git
cd pkarr-chat

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
```

## Project Structure

```
pkarr-chat/
├── src/                    # React frontend
│   ├── components/         # UI components
│   ├── hooks/              # React hooks (useChat, etc.)
│   └── pages/              # App pages
├── src-tauri/              # Rust backend
│   └── src/                # Tauri commands & Pkarr integration
├── cli/                    # ghostly-cli source
├── website/                # ghostly.chat website (Next.js)
└── ...
```

## How to Contribute

### Reporting Bugs

1. Check if the issue already exists in [Issues](https://github.com/MiguelMedeiros/pkarr-chat/issues)
2. If not, create a new issue with:
   - Clear title and description
   - Steps to reproduce
   - Expected vs actual behavior
   - Screenshots if applicable
   - Your OS and app version

### Suggesting Features

Open an issue with the `enhancement` label describing:
- The problem you're trying to solve
- Your proposed solution
- Any alternatives you've considered

### Pull Requests

1. **Fork** the repository
2. **Create** your feature branch
   ```bash
   git checkout -b feature/spooky-feature
   ```
3. **Make** your changes
4. **Test** your changes
   ```bash
   npm run lint
   npm run typecheck
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
7. **Open** a Pull Request

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
