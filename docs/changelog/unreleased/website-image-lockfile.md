---
section: For developers
---
- The website's Docker image builds again from a clean cache. Its lockfile kept a package (`@napi-rs/wasm-runtime` 1.2.0) whose peers nothing in it met, so `npm ci` on Node 26 asked the registry to settle them and stopped on "Missing: @emnapi/core@ from lock file" when that answer did not come. A test now runs the site's `npm ci` offline, which passes only when the lockfile settles everything by itself.
