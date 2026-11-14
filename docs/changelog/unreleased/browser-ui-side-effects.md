---
section: For developers
---
- `@ghostly/browser` and the shared UI (`apps/ui`, which gets a `package.json` for it) list in `sideEffects` the modules that do something when they load (a listener, reserved ids, a worker, the secret guard's other seed lists, CSS), so a bundle drops any other module whose exports it does not use. A test holds the lists to what the modules run on load.
