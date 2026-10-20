---
section: For developers
---
- A minor update of Tauri or a Tauri plugin arrives as one Dependabot pull request, the cargo one, instead of an npm and a cargo pull request that each fail alone (the Tauri CLI refuses an npm package and its crate on different minor versions). Its npm side is committed on that pull request's branch by hand, as `.github/dependabot.yml` says.
