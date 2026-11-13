---
section: Fixed / CLI
---
- `ghostly wallet create … --value` no longer repeats a value it took for a field's name. A macaroon, a rune or an API key given without its `name=` but ending in base64's `=` was printed back in the "names no field" error, on the terminal and in any log of it.
