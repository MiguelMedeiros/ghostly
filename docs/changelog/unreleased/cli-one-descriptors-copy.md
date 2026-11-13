---
section: For developers / CLI
---
- The CLI loads Arkade's own copy of @bitcoinerlab/descriptors-scure ahead of an Ark wallet, as it meant to, and no longer installs a second, newer copy of it (with its descriptors-core) that only that early load used.
