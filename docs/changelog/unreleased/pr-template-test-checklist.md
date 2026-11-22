---
section: For developers / Tests
---
- The pull request template asks of each new test: its name says the behaviour or bug it guards, it goes into the area's existing file, a lint rule or a type would not do it, no e2e spec already checks it, a test on the real Internet is opt-in (`@network`, or an env flag), and it has no fixed waits or ms budgets (a timing check goes in an e2e spec tagged `@perf`).
