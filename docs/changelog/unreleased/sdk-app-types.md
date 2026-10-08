---
section: For developers / Apps
release: 1.2
---
- `@ghostlytools/sdk/app`: the types a mini-app is written against. It has the `window.ghostly` API, the broker's messages, every refusal code (`MiniAppErrorCode`, read back from an error with `miniAppErrorCode`), the broker's limits and the manifest's type (`AppManifestSource` for `ghostly-app.json`). It imports nothing at run time, so an app's single-file bundle takes only the constants it uses. The SDK's declarations now also type check with `NodeNext` module resolution.
