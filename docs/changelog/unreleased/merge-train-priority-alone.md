---
section: For developers
---
- The merge train takes a pull request labelled `queue:priority` and not `queue` as in the line, first. Before, only `queue` put a pull request in the line, so one with `queue:priority` alone waited for good while the train found no base to run (three green flaky-test fixes sat for eight hours on 2026-10-09).
