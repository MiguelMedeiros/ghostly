---
section: For developers
---
- **The SDK's package is `@ghostlytools/sdk`**, in the same npm organization as `@ghostlytools/cli`. It is still packed from a checkout and not on npm. The workspace was `@ghostly/sdk`: `npm run build -w @ghostlytools/sdk` now, and adapters import `@ghostlytools/sdk`, `@ghostlytools/sdk/fakes`, `@ghostlytools/sdk/testing` and `@ghostlytools/sdk/core`.
