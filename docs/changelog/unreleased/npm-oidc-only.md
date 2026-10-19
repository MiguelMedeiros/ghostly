---
section: For developers
---
- The npm packages publish with trusted publishing (OIDC) only: `npm-publish.yml` no longer reads an npm token, and docs/RELEASING.md says how the packages refuse one.
- The security autorelease workflow is retired: a tag ruleset on `v*` now lets only a person create release tags, so a security fix ships in a patch release cut by hand.
