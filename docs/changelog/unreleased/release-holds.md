---
section: For developers / CI
---
- A changelog entry can wait for a later release: `release: <major.minor>` in its front matter keeps it in `docs/changelog/unreleased/` through every older version's bump, so a patch never lists what it does not ship. The version bump also refuses a version older than the release a feature flag belongs to while that flag is on (`RELEASE_GUARDS` in `tools/scripts/bump-version.mjs`).
