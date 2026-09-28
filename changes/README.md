# Changelog entries

One file per change for the next release, instead of a line in `CHANGELOG.md`: pull requests open at the same time
then never edit the same lines. `scripts/bump-version.mjs` puts every file here into the changelog's
`## Unreleased` at release time and deletes it.

Name it after the change (`changes/forward-messages.md`) and write:

```markdown
---
section: For users / Chat
---
- Forward a message to up to five chats and groups at once.
```

- `section` is a `###` heading of `## Unreleased` (`For users`, `For developers`, `Fixed`, `Security`...), and after
  ` / ` a bold group under it (`Chat`, `Calls`, `Groups`, `Wallets`, `Identities`, `Everywhere`). A section that does
  not exist yet is added at the end.
- The text is one or more list items, written for the people who read release notes. Plain English, no em dashes.
- Entries of one section go in the files' name order.

To change a line that is already in `## Unreleased`, edit `CHANGELOG.md` itself.

`node scripts/changes.mjs` checks the files (CI does); `node scripts/changes.mjs --preview` prints the section as the
release will write it.
