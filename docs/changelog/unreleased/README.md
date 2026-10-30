# Changelog entries

One file per change for the next release, instead of a line in `CHANGELOG.md`: pull requests open at the same time
then never edit the same lines. `tools/scripts/bump-version.mjs` puts the files in this folder
(`docs/changelog/unreleased/`) into the changelog's `## Unreleased` at release time and deletes them, except the ones
held for a later release.

Name it after the change (`docs/changelog/unreleased/forward-messages.md`) and write:

```markdown
---
section: For users / Chat
---
- Forward a message to up to five chats and groups at once.
```

- `section` is a `###` heading of `## Unreleased` (`For users`, `For developers`, `Fixed`, `Security`...), and after
  ` / ` a bold group under it (`Chat`, `Calls`, `Groups`, `Wallets`, `Identities`, `Everywhere`). A group that does
  not exist yet is added at the end of its heading. The headings come out in the order Security, For users, Fixed, For
  developers (another one after them), whatever the files' names.
- The text is one or more list items, written for the people who read release notes. Plain English, no em dashes.
- Entries of one section go in the files' name order.
- `release: <major>.<minor>` (optional, after `section`) holds the entry for that release, for a change that ships
  behind a flag until then. A bump to an older version leaves the file here (`release: 1.2` stays through every
  1.1.x patch), and the bump to 1.2.0 or later takes it. Without it, the next release takes the entry.
- Until 1.2.0, an Apps entry (section `... / Apps`, or text about the apps flag, WISP 1200 or `apps/1`) must say
  `release: 1.2`, and `section` and `release` are the only keys: the check refuses anything else, so a misspelled
  `release` never lets an entry out early.
- Until 1.3.0, an entry about the native Android app (section `... / Android`, or text that names the Android app or
  an APK) must say `release: 1.3`: the app is in no release before it. The web app on an Android phone is not the
  native app; write "on Android" there.
- Until 1.7.0, an entry about auto-translation in the Desktop app (text that names Translate messages, Translate what
  I send, the Translate button, Show original, the translation runtime or models, or auto-translation) must say
  `release: 1.7`: the Desktop app carries it from 1.7.0. "Translated" alone (the app's own words in a language) is not
  held, nor is a `... / CLI` entry.

```markdown
---
section: For developers / Apps
release: 1.2
---
- Behind the apps flag: ...
```

To change a line that is already in `## Unreleased`, edit `CHANGELOG.md` itself.

From the repository root, `node tools/scripts/changes.mjs` checks the files (CI does);
`node tools/scripts/changes.mjs --preview` prints the section with every entry, and
`node tools/scripts/changes.mjs --preview 1.1.7` as bumping to 1.1.7 would write it, held entries left out.
