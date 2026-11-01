---
section: Fixed / CLI
---
- `ghostly store sign` no longer writes over a `ghostly-store.json` or `ghostly-store.sig` in the output folder that does not read as a signed index (its signature missing or damaged, or a signature alone): it is refused, naming the file, as `app publish` refuses a bundle it cannot read. Before, the new index replaced it without the checks for a lower `sequence`, the same one with other content, or another store key. Signing the same index again after a run stopped between the two files still works.
