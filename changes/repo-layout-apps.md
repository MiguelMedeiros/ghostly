---
section: For developers
---
- The three apps live under `apps/`: the web app in `apps/web/`, Ghostly Browser in `apps/extension/` and the Desktop (Tauri) app in `apps/desktop/` (it was `src-tauri/`). Builds land in `apps/web/dist` and `apps/extension/dist`; `docker compose up --build` from the repository root builds the web image as before.
