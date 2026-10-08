---
section: For developers / CI
---
- Desktop builds other than `tauri build --debug` and `tauri dev` (so every release `tauri build`) and every browser extension build now stop when the e2e suite's build switch `VITE_APPS_TEST` is set, from the shell or a `.env` file, as the web image already did. The release workflow also empties it for both.
