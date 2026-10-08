---
section: For developers / CI
---
- In the security autorelease's `deps` mode, a manifest, version file or Dockerfile may change only versions: dependency ranges, the app's version, crate versions and base image tags. A branch that also changes a package.json's scripts, an extension's permissions, the updater's key, a Cargo build script, a Dockerfile's commands or a dependency's source, or that adds a manifest, now waits for a person.
