---
section: For developers / CI
---
- The changelog check and the version bump refuse an entry in `docs/changelog/unreleased/` that no release would read (a name in another case or with another extension, such as `b.MD` or `x.markdown`, one with none, a subfolder or a symbolic link), instead of skipping it, which left the change out of the release notes and the file in the folder for good.
