<!-- Pull requests come from the maintainer's pipeline; outside ones are closed (see .github/CONTRIBUTING.md). -->

<!-- What changes for the person using Ghostly, and why. Link the issue: "Fixes #123". -->

## Tested

<!-- The commands you ran and what they showed: npm run test:affected, the e2e specs you touched (PR CI does not run the web e2e), a manual check. -->

## Checklist

- [ ] A change file in `docs/changelog/unreleased/`, or this is not user-visible (tests, CI, docs)
- [ ] New strings in all 8 languages, keys sorted (`npm run locales:sort`)
- [ ] The e2e specs this touches ran locally, phone width included when the UI changed
- [ ] A new feature has its line in `e2e/features.json` and a test (`npm run test:map`)
- [ ] No keys, seeds, tokens, invite links or device codes in the code, tests or this description

## Tests

<!-- For each test this adds or changes. Delete this section when there is none. -->

- [ ] Its name says the behaviour or the bug it guards
- [ ] It goes into the area's existing test file
- [ ] A lint rule or a type would not catch the same thing
- [ ] No e2e spec already checks it
- [ ] On the real Internet it is opt-in: an e2e spec tagged `@network`, or a unit test skipped without its env flag (as `dhtDelivery.network.test.ts`)
- [ ] No fixed waits or ms budgets: a timing check goes in an e2e spec tagged `@perf`
