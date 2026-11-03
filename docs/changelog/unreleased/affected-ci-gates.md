---
section: For developers / CI
---
- A draft's CI tier and `npm run test:affected` now run the check that CI's path gates cover every file a website script, a package's or the extension's code, or a crate names, whenever one of those changes. The check reads them from disk, so no import graph picked it. A website script naming an uncovered file then went red only in the merge train's batches, three in a row.
