---
section: For developers / Identities
---
- Identity-proof providers can say their words in the app's language: every line a provider shows (instructions, a signer's progress and approval words, an unpublish step, a subject preview) can go through a new optional `say(key, english, values)` hook, handed as `instructions(statement, say)`, `ctx.say` for signers and `unpublish.run`, and `options.say` for `subject.preview`. `english` writes each value as `{{name}}`; a provider that ignores `say`, or a host that hands none (the CLI), gets the English text as before. See `packages/browser/src/proofs/PROOFS.md`.
