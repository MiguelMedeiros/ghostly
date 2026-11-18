---
section: Fixed / CLI
---
- `npm install @ghostlytools/cli` downloads 12 MB instead of 21 MB and takes 21 MB less disk: the BDK, Fedimint and Bark wallets' WebAssembly is read from the packages npm installs with the CLI, where the package carried a second copy of each.
