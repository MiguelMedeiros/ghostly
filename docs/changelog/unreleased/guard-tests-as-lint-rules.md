---
section: For developers / Tests
---
- Three checks that scanned the UI's sources in tests are lint rules now (`tools/eslint/`), shown at the line in the editor and refused by `npm run lint`: `ghostly/no-blank-target` (a new window only through `externalLinkProps`), `ghostly/on-accent-ink` (text on `bg-accent` takes `text-on-accent`) and `ghostly/no-group-has` (no `group-has-*` class, in stylesheets and comments too).
