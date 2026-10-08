---
section: For developers / CI
---
- A changelog entry can wait for a later release: `release: <major.minor>` in its front matter keeps it in `docs/changelog/unreleased/` through every older version's bump, so a patch never lists what it does not ship. The check refuses an unknown or repeated front matter key, and, until 1.2.0, an Apps entry that is not held. The version bump refuses a version older than the release a feature flag belongs to while that flag is on, and that release while the flag is still off (`RELEASE_GUARDS` in `tools/scripts/changes.mjs`); the release workflow checks the tag the same way. A bump keeps an empty `## Unreleased` above the new version.
