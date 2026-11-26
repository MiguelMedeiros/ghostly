---
section: For developers / CI
---
- A `// quarantine: #<issue> until <date>` line now covers only the first `@quarantine` test under it: a second tagged test a few lines below needs its own line, so it no longer leaves the gate under the first test's flake issue.
