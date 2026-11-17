---
section: Fixed / CLI
release: 1.14
---
- `group send --mention` and `group edit --mention` refuse a member written only as the start of a longer word, with the usual "Write @Al in the text to mention Al": `--mention Al` with only "@Alice" in the text, or `--mention everyone` with only "@Allan", went out with the mention on the first letters of that other name.
