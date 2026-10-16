---
section: For developers
---
- A release build can no longer be put into test mode. The test identity providers and the regtest fake wallets answered to a `ghostly-test-identities` or `ghostly-test-providers` key in the browser's storage in every build. They now answer only in a development build and in the e2e suite's build (made with VITE_APPS_TEST, the same build flag as the mini-app test switch); a released build ignores the key, and so does a plain `npm run build:web`. `testProvidersEnabled` and `testIdentitiesEnabled`, still exported by `@ghostlytools/sdk/fakes`, are folded to false when the SDK is built: a plugin that wants the fakes in the app registers them itself, as before.
