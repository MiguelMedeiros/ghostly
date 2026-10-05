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
