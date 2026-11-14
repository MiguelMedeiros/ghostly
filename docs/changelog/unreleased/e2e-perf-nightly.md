---
section: For developers
---
- The end-to-end tests whose pass hangs on milliseconds or frame times (the long chat list's Light/Dark switch, a long chat's opening and leaving, a keystroke in a long chat, the Tasks board's scroll) are tagged `@perf`: every run leaves them out unless `E2E_PERF=1`, and a nightly `E2E (perf)` workflow runs only them and keeps each budget's value in its summary and a `perf.json` artifact. What they check besides (rows in the page, React commits, the field's writes) stays in the usual runs.
