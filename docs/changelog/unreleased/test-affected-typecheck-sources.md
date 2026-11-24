---
section: For developers / Tests
---
- `npm run test:affected` type-checks a change with every tsc program that compiles it. Each program ran only when a changed file matched its hand-written list of sources, and nine of the ten lists left out files their tsconfig reaches: a change to `apps/ui/src/lib/` skipped the browser package's check, one to `packages/browser/src/` the e2e check, one to `apps/web/src/` the root (UI) check. A test now walks each program's imports from its tsconfig and names any file its list leaves out.
