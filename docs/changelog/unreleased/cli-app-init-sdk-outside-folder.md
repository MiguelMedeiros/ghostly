---
section: Fixed / CLI
---
- The README that `ghostly app init` writes installs `@ghostlytools/sdk` in the folder above the app's (`npm install --save-dev --prefix ..`), so its next step, `ghostly app publish .`, no longer meets `node_modules` (refused as too many files) or bundles `package.json` and `package-lock.json`.
