---
section: For developers
---
- The shared UI moved to `apps/ui/`: `src/` is now `apps/ui/src/` (strings in `apps/ui/src/locales/<language>/<area>.json`), with its `index.html`, `public/` and Vite and Vitest configs beside it. `npm run dev` and `npm run build` work as before; the Desktop's build lands in `apps/ui/dist`. The repository root keeps only the workspace configs and the project documents.
