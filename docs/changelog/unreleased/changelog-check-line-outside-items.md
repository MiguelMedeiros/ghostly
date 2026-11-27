---
section: For developers / CI
---
- The changelog check refuses an entry with a line outside its list items, such as a bold `**Calls**` or a heading's `---` underline, instead of passing it: the bump copied it into the release notes as a second Calls group (where later Calls entries then landed) or as a heading.
