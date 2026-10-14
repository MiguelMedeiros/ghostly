---
section: For developers
release: 1.3
---
- A security autorelease moves the web image's `latest` from the default branch: `security-autorelease.yml` dispatches `web-latest.yml` without `--ref main`, so the tag still moves when `main` does not hold that workflow yet.
