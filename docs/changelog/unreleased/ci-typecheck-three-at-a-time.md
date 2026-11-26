---
section: For developers / Tests
---
- `npm run typecheck` runs its ten tsc programs three at a time, the longest first, instead of one after another (`--jobs <n>` to choose). Each tsc is one thread, so on CI's 4-core runner two cores sat idle while the TypeScript check set the length of "Frontend lint and types", the slowest job of most draft runs; on a 4-core machine it took 384 s, now 171 s. It reads the same list `npm run test:affected` types a change against, which now has the CLI: a change to it was never type-checked there.
