---
section: For developers / Tests
---
- A flaky test can be quarantined for at most 7 days with its flake issue: the tag `@quarantine` and a `// quarantine: #<issue> until <date>` line for an end-to-end test, an entry in `tools/scripts/quarantine.json` for a unit test file. The gate leaves it out, the nightly E2E (full) runs it, and CI fails once the date is past or more than 7 days ahead.
