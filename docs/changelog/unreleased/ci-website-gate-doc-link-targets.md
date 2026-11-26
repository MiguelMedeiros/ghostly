---
section: For developers / Tests
---
- CI runs the Website checks when a document a published one links to changes (`docs/BROWSER.md`, `docs/TRANSPORTS.md`, `packages/browser/src/proofs/PROOFS.md` and nine more). Renaming or deleting one skipped the Website job, merged, and the next run that built the site failed at "Generate the reference files" on a link to a file that is gone. A test checks the gate covers every file a published document links to.
